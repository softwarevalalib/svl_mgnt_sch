CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS institutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_code TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  institution_type TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  county TEXT,
  city TEXT,
  country TEXT NOT NULL DEFAULT 'Liberia',
  logo TEXT,
  motto TEXT,
  primary_color TEXT NOT NULL DEFAULT '#1e40af',
  secondary_color TEXT NOT NULL DEFAULT '#3b82f6',
  accent_color TEXT NOT NULL DEFAULT '#f59e0b',
  currency TEXT NOT NULL DEFAULT 'USD',
  currency_symbol TEXT NOT NULL DEFAULT '$',
  timezone TEXT NOT NULL DEFAULT 'Africa/Monrovia',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  setup_completed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_code_lower ON institutions (lower(institution_code));

CREATE TABLE IF NOT EXISTS branches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  branch_code TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  county TEXT,
  city TEXT,
  is_main BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (institution_id, branch_code)
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID REFERENCES institutions(id) ON DELETE CASCADE,
  role_code TEXT NOT NULL,
  role_name TEXT NOT NULL,
  description TEXT,
  is_system_role BOOLEAN NOT NULL DEFAULT FALSE,
  is_platform_role BOOLEAN NOT NULL DEFAULT FALSE,
  role_level TEXT,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_platform_code ON roles (role_code) WHERE institution_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_institution_code ON roles (institution_id, role_code) WHERE institution_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permission_code TEXT UNIQUE NOT NULL,
  permission_name TEXT NOT NULL,
  module TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID REFERENCES institutions(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  avatar TEXT,
  role_id UUID REFERENCES roles(id) ON DELETE SET NULL,
  user_type TEXT NOT NULL,
  linked_entity_type TEXT,
  linked_entity_id UUID,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  force_password_change BOOLEAN NOT NULL DEFAULT FALSE,
  last_login TIMESTAMPTZ,
  last_login_ip TEXT,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, role_id)
);

INSERT INTO roles (
  institution_id, role_code, role_name, description,
  is_system_role, is_platform_role, role_level, permissions, is_active
) VALUES (
  NULL, 'platform_admin', 'Platform Administrator',
  'Full system access across all institutions',
  TRUE, TRUE, 'platform', '[]'::jsonb, TRUE
) ON CONFLICT DO NOTHING;
