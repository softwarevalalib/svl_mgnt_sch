export type SyncOperation = 'upsert' | 'delete';

export interface SyncChange {
  id: string;
  institutionId: string;
  deviceId: string;
  entityType: string;
  entityId: string;
  operation: SyncOperation;
  payload: Record<string, unknown> | null;
  baseVersion: number;
  createdAt: string;
}

export interface ServerChange extends SyncChange {
  sequence: number;
  serverVersion: number;
  acceptedAt: string;
}

export interface SyncPushResult {
  accepted: Array<{ id: string; sequence: number; serverVersion: number }>;
  conflicts: Array<{
    id: string;
    entityType: string;
    entityId: string;
    serverVersion: number;
    serverPayload: Record<string, unknown> | null;
  }>;
}
