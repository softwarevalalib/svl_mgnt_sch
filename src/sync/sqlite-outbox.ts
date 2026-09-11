import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/init';
import type { SyncChange, SyncOperation } from './types';

export function enqueueChange(input: {
  institutionId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  payload?: Record<string, unknown> | null;
  baseVersion?: number;
}): string {
  const db = getDatabase();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO sync_outbox (
      id, institution_id, device_id, entity_type, entity_id,
      operation, payload, base_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.institutionId,
    input.deviceId,
    input.entityType,
    input.entityId,
    input.operation,
    input.payload ? JSON.stringify(input.payload) : null,
    input.baseVersion || 0
  );
  return id;
}

export function getPendingChanges(institutionId: string, limit = 100): SyncChange[] {
  const rows = getDatabase().prepare(`
    SELECT * FROM sync_outbox
    WHERE institution_id = ? AND synced_at IS NULL
    ORDER BY created_at, id
    LIMIT ?
  `).all(institutionId, limit) as any[];

  return rows.map((row) => ({
    id: row.id,
    institutionId: row.institution_id,
    deviceId: row.device_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    operation: row.operation,
    payload: row.payload ? JSON.parse(row.payload) : null,
    baseVersion: row.base_version,
    createdAt: row.created_at,
  }));
}

export function markChangesSynced(ids: string[]): void {
  if (!ids.length) return;
  const db = getDatabase();
  const update = db.prepare(`
    UPDATE sync_outbox SET synced_at = datetime('now'), last_error = NULL
    WHERE id = ?
  `);
  const commit = db.transaction((changeIds: string[]) => {
    for (const id of changeIds) update.run(id);
  });
  commit(ids);
}

export function markChangeFailed(id: string, error: string): void {
  getDatabase().prepare(`
    UPDATE sync_outbox
    SET attempts = attempts + 1, last_error = ?
    WHERE id = ?
  `).run(error.slice(0, 1000), id);
}
