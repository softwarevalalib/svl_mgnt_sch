import { getDatabase } from '../database/init';
import { getPendingChanges, markChangeFailed, markChangesSynced } from './sqlite-outbox';
import type { ServerChange, SyncPushResult } from './types';

interface SyncClientOptions {
  apiUrl: string;
  token: string;
  institutionId: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  appVersion?: string;
  applyServerChange: (change: ServerChange) => void;
}

async function request<T>(options: SyncClientOptions, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${options.apiUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sync request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

export async function synchronize(options: SyncClientOptions): Promise<{
  pushed: number;
  pulled: number;
  conflicts: number;
}> {
  await request(options, '/api/sync/devices', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: options.deviceId,
      name: options.deviceName,
      platform: options.platform,
      appVersion: options.appVersion,
    }),
  });

  let pushed = 0;
  let conflictCount = 0;
  const pending = getPendingChanges(options.institutionId, 100);
  if (pending.length) {
    try {
      const result = await request<SyncPushResult>(options, '/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({ changes: pending }),
      });
      markChangesSynced(result.accepted.map((change) => change.id));
      pushed = result.accepted.length;
      conflictCount = result.conflicts.length;

      const db = getDatabase();
      const insertConflict = db.prepare(`
        INSERT OR IGNORE INTO sync_conflicts (
          id, institution_id, entity_type, entity_id, server_payload,
          server_version, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `);
      const storeConflicts = db.transaction(() => {
        for (const conflict of result.conflicts) {
          insertConflict.run(
            conflict.id,
            options.institutionId,
            conflict.entityType,
            conflict.entityId,
            conflict.serverPayload ? JSON.stringify(conflict.serverPayload) : null,
            conflict.serverVersion
          );
        }
      });
      storeConflicts();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const change of pending) markChangeFailed(change.id, message);
      throw error;
    }
  }

  const db = getDatabase();
  const state = db.prepare(
    'SELECT last_server_sequence FROM sync_state WHERE institution_id = ?'
  ).get(options.institutionId) as { last_server_sequence: number } | undefined;
  let cursor = state?.last_server_sequence || 0;
  let pulled = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await request<{
      changes: ServerChange[];
      nextSequence: number;
      hasMore: boolean;
    }>(options, `/api/sync/pull?after=${cursor}&limit=200`);

    const applyPage = db.transaction(() => {
      for (const change of page.changes) options.applyServerChange(change);
      db.prepare(`
        INSERT INTO sync_state (
          institution_id, device_id, last_server_sequence, last_sync_at, updated_at
        ) VALUES (?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(institution_id) DO UPDATE SET
          device_id = excluded.device_id,
          last_server_sequence = excluded.last_server_sequence,
          last_sync_at = datetime('now'),
          updated_at = datetime('now')
      `).run(options.institutionId, options.deviceId, page.nextSequence);
    });
    applyPage();
    cursor = page.nextSequence;
    pulled += page.changes.length;
    hasMore = page.hasMore;
  }

  return { pushed, pulled, conflicts: conflictCount };
}
