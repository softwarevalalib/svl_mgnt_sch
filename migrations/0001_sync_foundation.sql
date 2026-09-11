CREATE TABLE IF NOT EXISTS sync_devices (
  id UUID PRIMARY KEY,
  institution_id UUID NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_devices_institution
  ON sync_devices (institution_id, revoked_at);

CREATE TABLE IF NOT EXISTS sync_entities (
  institution_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB,
  version BIGINT NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_device_id UUID,
  PRIMARY KEY (institution_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS sync_changes (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_id UUID NOT NULL UNIQUE,
  institution_id UUID NOT NULL,
  device_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload JSONB,
  base_version BIGINT NOT NULL DEFAULT 0,
  server_version BIGINT NOT NULL,
  client_created_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_changes_pull
  ON sync_changes (institution_id, sequence);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id UUID PRIMARY KEY,
  change_id UUID NOT NULL,
  institution_id UUID NOT NULL,
  device_id UUID NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  local_payload JSONB,
  server_payload JSONB,
  local_base_version BIGINT NOT NULL,
  server_version BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted_local', 'accepted_server', 'merged')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_pending
  ON sync_conflicts (institution_id, status, created_at);
