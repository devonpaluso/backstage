/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Entity, stringifyEntityRef } from '@backstage/catalog-model';
import { ConflictError } from '@backstage/errors';
import { Knex } from 'knex';
import lodash from 'lodash';
import { v4 as uuid } from 'uuid';
import type { Logger } from 'winston';
import {
  Transaction,
  GetProcessableEntitiesResult,
  ProcessingDatabase,
  RefreshStateItem,
  UpdateProcessedEntityOptions,
  UpdateEntityCacheOptions,
  ListParentsOptions,
  ListParentsResult,
} from './types';
import { ProcessingIntervalFunction } from '../processing/refresh';
import { rethrowError, timestampToDateTime } from './conversion';
import { initDatabaseMetrics } from './metrics';
import {
  DbRefreshKeysRow,
  DbRefreshStateReferencesRow,
  DbRefreshStateRow,
  DbRelationsRow,
} from './tables';

import { generateStableHash } from './util';
import { isDatabaseConflictError } from '@backstage/backend-common';
import { DeferredEntity } from '@backstage/plugin-catalog-node';

// The number of items that are sent per batch to the database layer, when
// doing .batchInsert calls to knex. This needs to be low enough to not cause
// errors in the underlying engine due to exceeding query limits, but large
// enough to get the speed benefits.
const BATCH_SIZE = 50;

export class DefaultProcessingDatabase implements ProcessingDatabase {
  constructor(
    private readonly options: {
      database: Knex;
      logger: Logger;
      refreshInterval: ProcessingIntervalFunction;
    },
  ) {
    initDatabaseMetrics(options.database);
  }

  async updateProcessedEntity(
    txOpaque: Transaction,
    options: UpdateProcessedEntityOptions,
  ): Promise<{ previous: { relations: DbRelationsRow[] } }> {
    const tx = txOpaque as Knex.Transaction;
    const {
      id,
      processedEntity,
      resultHash,
      errors,
      relations,
      deferredEntities,
      refreshKeys,
      locationKey,
    } = options;
    const configClient = tx.client.config.client;
    const refreshResult = await tx<DbRefreshStateRow>('refresh_state')
      .update({
        processed_entity: JSON.stringify(processedEntity),
        result_hash: resultHash,
        errors,
        location_key: locationKey,
      })
      .where('entity_id', id)
      .andWhere(inner => {
        if (!locationKey) {
          return inner.whereNull('location_key');
        }
        return inner
          .where('location_key', locationKey)
          .orWhereNull('location_key');
      });
    if (refreshResult === 0) {
      throw new ConflictError(
        `Conflicting write of processing result for ${id} with location key '${locationKey}'`,
      );
    }
    const sourceEntityRef = stringifyEntityRef(processedEntity);

    // Schedule all deferred entities for future processing.
    await this.addUnprocessedEntities(tx, {
      entities: deferredEntities,
      sourceEntityRef,
    });

    // Delete old relations
    // NOTE(freben): knex implemented support for returning() on update queries for sqlite, but at the current time of writing (Sep 2022) not for delete() queries.
    let previousRelationRows: DbRelationsRow[];
    if (configClient.includes('sqlite3') || configClient.includes('mysql')) {
      previousRelationRows = await tx<DbRelationsRow>('relations')
        .select('*')
        .where({ originating_entity_id: id });
      await tx<DbRelationsRow>('relations')
        .where({ originating_entity_id: id })
        .delete();
    } else {
      previousRelationRows = await tx<DbRelationsRow>('relations')
        .where({ originating_entity_id: id })
        .delete()
        .returning('*');
    }

    // Batch insert new relations
    const relationRows: DbRelationsRow[] = relations.map(
      ({ source, target, type }) => ({
        originating_entity_id: id,
        source_entity_ref: stringifyEntityRef(source),
        target_entity_ref: stringifyEntityRef(target),
        type,
      }),
    );
    await tx.batchInsert(
      'relations',
      this.deduplicateRelations(relationRows),
      BATCH_SIZE,
    );

    // Delete old refresh keys
    await tx<DbRefreshKeysRow>('refresh_keys')
      .where({ entity_id: id })
      .delete();

    // Insert the refresh keys for the processed entity
    await tx.batchInsert(
      'refresh_keys',
      refreshKeys.map(k => ({
        entity_id: id,
        key: k.key,
      })),
      BATCH_SIZE,
    );

    return {
      previous: {
        relations: previousRelationRows,
      },
    };
  }

  async updateProcessedEntityErrors(
    txOpaque: Transaction,
    options: UpdateProcessedEntityOptions,
  ): Promise<void> {
    const tx = txOpaque as Knex.Transaction;
    const { id, errors, resultHash } = options;

    await tx<DbRefreshStateRow>('refresh_state')
      .update({
        errors,
        result_hash: resultHash,
      })
      .where('entity_id', id);
  }

  async updateEntityCache(
    txOpaque: Transaction,
    options: UpdateEntityCacheOptions,
  ): Promise<void> {
    const tx = txOpaque as Knex.Transaction;
    const { id, state } = options;

    await tx<DbRefreshStateRow>('refresh_state')
      .update({ cache: JSON.stringify(state ?? {}) })
      .where('entity_id', id);
  }

  async getProcessableEntities(
    txOpaque: Transaction,
    request: { processBatchSize: number },
  ): Promise<GetProcessableEntitiesResult> {
    const tx = txOpaque as Knex.Transaction;

    let itemsQuery = tx<DbRefreshStateRow>('refresh_state').select();

    // This avoids duplication of work because of race conditions and is
    // also fast because locked rows are ignored rather than blocking.
    // It's only available in MySQL and PostgreSQL
    if (['mysql', 'mysql2', 'pg'].includes(tx.client.config.client)) {
      itemsQuery = itemsQuery.forUpdate().skipLocked();
    }

    const items = await itemsQuery
      .where('next_update_at', '<=', tx.fn.now())
      .limit(request.processBatchSize)
      .orderBy('next_update_at', 'asc');

    const interval = this.options.refreshInterval();

    const nextUpdateAt = (refreshInterval: number) => {
      if (tx.client.config.client.includes('sqlite3')) {
        return tx.raw(`datetime('now', ?)`, [`${refreshInterval} seconds`]);
      }

      if (tx.client.config.client.includes('mysql')) {
        return tx.raw(`now() + interval ${refreshInterval} second`);
      }

      return tx.raw(`now() + interval '${refreshInterval} seconds'`);
    };

    await tx<DbRefreshStateRow>('refresh_state')
      .whereIn(
        'entity_ref',
        items.map(i => i.entity_ref),
      )
      .update({
        next_update_at: nextUpdateAt(interval),
      });

    return {
      items: items.map(
        i =>
          ({
            id: i.entity_id,
            entityRef: i.entity_ref,
            unprocessedEntity: JSON.parse(i.unprocessed_entity) as Entity,
            processedEntity: i.processed_entity
              ? (JSON.parse(i.processed_entity) as Entity)
              : undefined,
            resultHash: i.result_hash || '',
            nextUpdateAt: timestampToDateTime(i.next_update_at),
            lastDiscoveryAt: timestampToDateTime(i.last_discovery_at),
            state: i.cache ? JSON.parse(i.cache) : undefined,
            errors: i.errors,
            locationKey: i.location_key,
          } as RefreshStateItem),
      ),
    };
  }

  async listParents(
    txOpaque: Transaction,
    options: ListParentsOptions,
  ): Promise<ListParentsResult> {
    const tx = txOpaque as Knex.Transaction;

    const rows = await tx<DbRefreshStateReferencesRow>(
      'refresh_state_references',
    )
      .where({ target_entity_ref: options.entityRef })
      .select();

    const entityRefs = rows.map(r => r.source_entity_ref!).filter(Boolean);

    return { entityRefs };
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      let result: T | undefined = undefined;

      await this.options.database.transaction(
        async tx => {
          // We can't return here, as knex swallows the return type in case the transaction is rolled back:
          // https://github.com/knex/knex/blob/e37aeaa31c8ef9c1b07d2e4d3ec6607e557d800d/lib/transaction.js#L136
          result = await fn(tx);
        },
        {
          // If we explicitly trigger a rollback, don't fail.
          doNotRejectOnRollback: true,
        },
      );

      return result!;
    } catch (e) {
      this.options.logger.debug(`Error during transaction, ${e}`);
      throw rethrowError(e);
    }
  }

  /**
   * Attempts to update an existing refresh state row, returning true if it was
   * updated and false if there was no entity with a matching ref and location key.
   *
   * Updating the entity will also cause it to be scheduled for immediate processing.
   */
  private async updateUnprocessedEntity(
    tx: Knex.Transaction,
    entity: Entity,
    hash: string,
    locationKey?: string,
  ): Promise<boolean> {
    const entityRef = stringifyEntityRef(entity);
    const serializedEntity = JSON.stringify(entity);

    const refreshResult = await tx<DbRefreshStateRow>('refresh_state')
      .update({
        unprocessed_entity: serializedEntity,
        unprocessed_hash: hash,
        location_key: locationKey,
        last_discovery_at: tx.fn.now(),
        // We only get to this point if a processed entity actually had any changes, or
        // if an entity provider requested this mutation, meaning that we can safely
        // bump the deferred entities to the front of the queue for immediate processing.
        next_update_at: tx.fn.now(),
      })
      .where('entity_ref', entityRef)
      .andWhere(inner => {
        if (!locationKey) {
          return inner.whereNull('location_key');
        }
        return inner
          .where('location_key', locationKey)
          .orWhereNull('location_key');
      });

    return refreshResult === 1;
  }

  /**
   * Attempts to insert a new refresh state row for the given entity, returning
   * true if successful and false if there was a conflict.
   */
  private async insertUnprocessedEntity(
    tx: Knex.Transaction,
    entity: Entity,
    hash: string,
    locationKey?: string,
  ): Promise<boolean> {
    const entityRef = stringifyEntityRef(entity);
    const serializedEntity = JSON.stringify(entity);

    try {
      let query = tx<DbRefreshStateRow>('refresh_state').insert({
        entity_id: uuid(),
        entity_ref: entityRef,
        unprocessed_entity: serializedEntity,
        unprocessed_hash: hash,
        errors: '',
        location_key: locationKey,
        next_update_at: tx.fn.now(),
        last_discovery_at: tx.fn.now(),
      });

      // TODO(Rugvip): only tested towards MySQL, Postgres and SQLite.
      // We have to do this because the only way to detect if there was a conflict with
      // SQLite is to catch the error, while Postgres needs to ignore the conflict to not
      // break the ongoing transaction.
      if (tx.client.config.client.includes('pg')) {
        query = query.onConflict('entity_ref').ignore() as any; // type here does not match runtime
      }

      // Postgres gives as an object with rowCount, SQLite gives us an array
      const result: { rowCount?: number; length?: number } = await query;
      return result.rowCount === 1 || result.length === 1;
    } catch (error) {
      // SQLite, or MySQL reached this rather than the rowCount check above
      if (!isDatabaseConflictError(error)) {
        throw error;
      } else {
        this.options.logger.debug(
          `Unable to insert a new refresh state row, ${error}`,
        );
        return false;
      }
    }
  }

  /**
   * Checks whether a refresh state exists for the given entity that has a
   * location key that does not match the provided location key.
   *
   * @returns The conflicting key if there is one.
   */
  private async checkLocationKeyConflict(
    tx: Knex.Transaction,
    entityRef: string,
    locationKey?: string,
  ): Promise<string | undefined> {
    const row = await tx<DbRefreshStateRow>('refresh_state')
      .select('location_key')
      .where('entity_ref', entityRef)
      .first();

    const conflictingKey = row?.location_key;

    // If there's no existing key we can't have a conflict
    if (!conflictingKey) {
      return undefined;
    }

    if (conflictingKey !== locationKey) {
      return conflictingKey;
    }
    return undefined;
  }

  private deduplicateRelations(rows: DbRelationsRow[]): DbRelationsRow[] {
    return lodash.uniqBy(
      rows,
      r => `${r.source_entity_ref}:${r.target_entity_ref}:${r.type}`,
    );
  }

  /**
   * Add a set of deferred entities for processing.
   * The entities will be added at the front of the processing queue.
   */
  private async addUnprocessedEntities(
    txOpaque: Transaction,
    options: {
      sourceEntityRef: string;
      entities: DeferredEntity[];
    },
  ): Promise<void> {
    const tx = txOpaque as Knex.Transaction;

    // Keeps track of the entities that we end up inserting to update refresh_state_references afterwards
    const stateReferences = new Array<string>();
    const conflictingStateReferences = new Array<string>();

    // Upsert all of the unprocessed entities into the refresh_state table, by
    // their entity ref.
    for (const { entity, locationKey } of options.entities) {
      const entityRef = stringifyEntityRef(entity);
      const hash = generateStableHash(entity);

      const updated = await this.updateUnprocessedEntity(
        tx,
        entity,
        hash,
        locationKey,
      );
      if (updated) {
        stateReferences.push(entityRef);
        continue;
      }

      const inserted = await this.insertUnprocessedEntity(
        tx,
        entity,
        hash,
        locationKey,
      );
      if (inserted) {
        stateReferences.push(entityRef);
        continue;
      }

      // If the row can't be inserted, we have a conflict, but it could be either
      // because of a conflicting locationKey or a race with another instance, so check
      // whether the conflicting entity has the same entityRef but a different locationKey
      const conflictingKey = await this.checkLocationKeyConflict(
        tx,
        entityRef,
        locationKey,
      );
      if (conflictingKey) {
        this.options.logger.warn(
          `Detected conflicting entityRef ${entityRef} already referenced by ${conflictingKey} and now also ${locationKey}`,
        );
        conflictingStateReferences.push(entityRef);
      }
    }

    // Replace all references for the originating entity or source and then create new ones
    await tx<DbRefreshStateReferencesRow>('refresh_state_references')
      .whereNotIn('target_entity_ref', conflictingStateReferences)
      .andWhere({ source_entity_ref: options.sourceEntityRef })
      .delete();
    await tx.batchInsert(
      'refresh_state_references',
      stateReferences.map(entityRef => ({
        source_entity_ref: options.sourceEntityRef,
        target_entity_ref: entityRef,
      })),
      BATCH_SIZE,
    );
  }
}
