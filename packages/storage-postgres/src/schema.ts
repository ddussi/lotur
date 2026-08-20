export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rt_schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rt_accounts (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  roles text[] NOT NULL,
  password_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  auth_version integer NOT NULL CHECK (auth_version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT rt_accounts_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  CONSTRAINT rt_accounts_roles_nonempty CHECK (cardinality(roles) > 0),
  CONSTRAINT rt_accounts_roles_allowed CHECK (roles <@ ARRAY['ADMIN', 'DEVELOPER', 'REVIEWER']::text[])
);

CREATE TABLE IF NOT EXISTS rt_auth_sessions (
  id text PRIMARY KEY,
  token_digest text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  account_auth_version integer NOT NULL,
  audience text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rt_auth_sessions_account_id_idx ON rt_auth_sessions(account_id);
CREATE INDEX IF NOT EXISTS rt_auth_sessions_expires_at_idx ON rt_auth_sessions(expires_at);

ALTER TABLE rt_auth_sessions ADD COLUMN IF NOT EXISTS audience text;
UPDATE rt_auth_sessions SET audience = 'control' WHERE audience IS NULL;
ALTER TABLE rt_auth_sessions ALTER COLUMN audience SET NOT NULL;

CREATE TABLE IF NOT EXISTS rt_login_throttles (
  key text PRIMARY KEY,
  failures integer NOT NULL CHECK (failures > 0),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL
);

ALTER TABLE rt_login_throttles ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE rt_login_throttles SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE rt_login_throttles ALTER COLUMN updated_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS rt_login_intents (
  id text PRIMARY KEY,
  target_host text NOT NULL,
  target_path text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_session_exchanges (
  code_digest text PRIMARY KEY,
  account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  target_host text NOT NULL,
  target_path text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rt_carrier_credentials (
  id text PRIMARY KEY,
  secret_digest text NOT NULL,
  account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  account_auth_version integer NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('create', 'resume')),
  tunnel_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rt_carrier_credentials_expires_at_idx ON rt_carrier_credentials(expires_at);

CREATE TABLE IF NOT EXISTS rt_audit_events (
  id text PRIMARY KEY,
  action text NOT NULL,
  actor_account_id text REFERENCES rt_accounts(id) ON DELETE SET NULL,
  target_account_id text REFERENCES rt_accounts(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS rt_audit_events_occurred_at_idx ON rt_audit_events(occurred_at DESC);

INSERT INTO rt_schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (2)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (3)
ON CONFLICT (version) DO NOTHING;
`;
