import { Router, Response } from 'express';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { transaction, query } from './postgres';
import { authenticateCloud, CloudAuthRequest } from './sync-auth';
import type { SyncChange } from '../sync/types';

const MANUAL_CONFLICT_ENTITIES = new Set([
  'fees',
  'fee_payments',
  'marks',
  'results',
  'payroll',
  'attendance',
  'accounts',
  'transactions',
]);

export const cloudSyncRouter = Router();
cloudSyncRouter.use(authenticateCloud);

cloudSyncRouter.post('/devices', async (req: CloudAuthRequest, res: Response) => {
  const { deviceId, name, platform, appVersion } = req.body || {};
  if (!deviceId || !isUuid(deviceId) || !name || !platform) {
    res.status(400).json({ error: 'Valid deviceId, name, and platform are required' });
    return;
  }

  const devices = await query<{ id: string }>(
    `INSERT INTO sync_devices (
       id, institution_id, name, platform, app_version, last_seen_at
     ) VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       platform = EXCLUDED.platform,
       app_version = EXCLUDED.app_version,
       last_seen_at = now(),
       revoked_at = NULL
     WHERE sync_devices.institution_id = EXCLUDED.institution_id
     RETURNING id`,
    [deviceId, req.cloudUser!.institutionId, name, platform, appVersion || null]
  );

  if (!devices.length) {
    res.status(409).json({ error: 'Device belongs to another institution' });
    return;
  }

  res.status(201).json({ deviceId, registered: true });
});

cloudSyncRouter.post('/push', async (req: CloudAuthRequest, res: Response) => {
  const changes = Array.isArray(req.body?.changes) ? req.body.changes as SyncChange[] : [];
  if (!changes.length || changes.length > 100) {
    res.status(400).json({ error: 'Submit between 1 and 100 changes' });
    return;
  }

  const institutionId = req.cloudUser!.institutionId;
  const accepted: any[] = [];
  const conflicts: any[] = [];

  await transaction(async (client) => {
    for (const change of changes) {
      if (
        !isUuid(change.id) ||
        !isUuid(change.deviceId) ||
        !isUuid(change.entityId) ||
        change.institutionId !== institutionId ||
        !change.entityType ||
        !['upsert', 'delete'].includes(change.operation) ||
        !change.createdAt ||
        Number.isNaN(Date.parse(change.createdAt))
      ) {
        throw new Error('Invalid synchronization change payload');
      }

      const device = await client.query(
        `SELECT id FROM sync_devices
         WHERE id = $1 AND institution_id = $2 AND revoked_at IS NULL`,
        [change.deviceId, institutionId]
      );
      if (!device.rowCount) throw new Error('Device is not registered');

      const existingChange = await client.query(
        'SELECT sequence, server_version FROM sync_changes WHERE change_id = $1',
        [change.id]
      );
      if (existingChange.rowCount) {
        accepted.push({
          id: change.id,
          sequence: Number(existingChange.rows[0].sequence),
          serverVersion: Number(existingChange.rows[0].server_version),
          duplicate: true,
        });
        continue;
      }

      const current = await client.query(
        `SELECT payload, version, deleted_at
         FROM sync_entities
         WHERE institution_id = $1 AND entity_type = $2 AND entity_id = $3
         FOR UPDATE`,
        [institutionId, change.entityType, change.entityId]
      );
      const serverVersion = current.rowCount ? Number(current.rows[0].version) : 0;

      if (
        MANUAL_CONFLICT_ENTITIES.has(change.entityType) &&
        serverVersion !== Number(change.baseVersion || 0)
      ) {
        const conflictId = uuidv4();
        await client.query(
          `INSERT INTO sync_conflicts (
             id, change_id, institution_id, device_id, entity_type, entity_id,
             local_payload, server_payload, local_base_version, server_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            conflictId, change.id, institutionId, change.deviceId,
            change.entityType, change.entityId, change.payload,
            current.rows[0]?.payload || null, change.baseVersion || 0, serverVersion,
          ]
        );
        conflicts.push({
          id: conflictId,
          entityType: change.entityType,
          entityId: change.entityId,
          serverVersion,
          serverPayload: current.rows[0]?.payload || null,
        });
        continue;
      }

      const nextVersion = serverVersion + 1;
      const deletedAt = change.operation === 'delete' ? new Date() : null;
      await client.query(
        `INSERT INTO sync_entities (
           institution_id, entity_type, entity_id, payload, version,
           deleted_at, updated_at, updated_by_device_id
         ) VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
         ON CONFLICT (institution_id, entity_type, entity_id) DO UPDATE SET
           payload = EXCLUDED.payload,
           version = EXCLUDED.version,
           deleted_at = EXCLUDED.deleted_at,
           updated_at = now(),
           updated_by_device_id = EXCLUDED.updated_by_device_id`,
        [
          institutionId, change.entityType, change.entityId,
          change.payload || null, nextVersion, deletedAt, change.deviceId,
        ]
      );
      const inserted = await client.query(
        `INSERT INTO sync_changes (
           change_id, institution_id, device_id, entity_type, entity_id,
           operation, payload, base_version, server_version, client_created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING sequence`,
        [
          change.id, institutionId, change.deviceId, change.entityType,
          change.entityId, change.operation, change.payload || null,
          change.baseVersion || 0, nextVersion, change.createdAt,
        ]
      );
      accepted.push({
        id: change.id,
        sequence: Number(inserted.rows[0].sequence),
        serverVersion: nextVersion,
      });
    }
  });

  res.json({ accepted, conflicts });
});

cloudSyncRouter.get('/pull', async (req: CloudAuthRequest, res: Response) => {
  const after = Math.max(0, Number(req.query.after || 0));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
  const changes = await query<any>(
    `SELECT
       sequence, change_id AS id, institution_id AS "institutionId",
       device_id AS "deviceId", entity_type AS "entityType",
       entity_id AS "entityId", operation, payload,
       base_version AS "baseVersion", server_version AS "serverVersion",
       client_created_at AS "createdAt", accepted_at AS "acceptedAt"
     FROM sync_changes
     WHERE institution_id = $1 AND sequence > $2
     ORDER BY sequence
     LIMIT $3`,
    [req.cloudUser!.institutionId, after, limit]
  );

  res.json({
    changes: changes.map((change) => ({
      ...change,
      sequence: Number(change.sequence),
      baseVersion: Number(change.baseVersion),
      serverVersion: Number(change.serverVersion),
    })),
    nextSequence: changes.length ? Number(changes[changes.length - 1].sequence) : after,
    hasMore: changes.length === limit,
  });
});
