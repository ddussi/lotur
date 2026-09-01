export const REVIEW_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rt_review_projects (
  id text PRIMARY KEY,
  owner_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  slug text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT rt_review_projects_owner_slug_unique UNIQUE (owner_account_id, slug),
  CONSTRAINT rt_review_projects_id_format
    CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT rt_review_projects_slug_format
    CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT rt_review_projects_display_name_length
    CHECK (char_length(display_name) BETWEEN 1 AND 128)
);

CREATE TABLE IF NOT EXISTS rt_review_revisions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES rt_review_projects(id) ON DELETE CASCADE,
  revision_key text NOT NULL,
  created_by_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  CONSTRAINT rt_review_revisions_project_key_unique UNIQUE (project_id, revision_key),
  CONSTRAINT rt_review_revisions_id_format
    CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT rt_review_revisions_key_format
    CHECK (revision_key ~ '^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,127}$')
);

CREATE TABLE IF NOT EXISTS rt_review_tunnel_bindings (
  tunnel_id text PRIMARY KEY,
  session_id text NOT NULL UNIQUE,
  revision_id text NOT NULL REFERENCES rt_review_revisions(id) ON DELETE CASCADE,
  owner_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT rt_review_tunnel_bindings_tunnel_id_format
    CHECK (tunnel_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT rt_review_tunnel_bindings_session_id_format
    CHECK (session_id ~ '^[A-Za-z0-9_-]{1,128}$')
);
ALTER TABLE rt_review_tunnel_bindings
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
UPDATE rt_review_tunnel_bindings
SET expires_at = created_at + interval '365 days'
WHERE expires_at IS NULL;
ALTER TABLE rt_review_tunnel_bindings ALTER COLUMN expires_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS rt_review_tunnel_bindings_revision_id_idx
  ON rt_review_tunnel_bindings(revision_id);
CREATE INDEX IF NOT EXISTS rt_review_tunnel_bindings_expires_at_idx
  ON rt_review_tunnel_bindings(expires_at);

CREATE TABLE IF NOT EXISTS rt_review_threads (
  id text PRIMARY KEY,
  revision_id text NOT NULL REFERENCES rt_review_revisions(id) ON DELETE CASCADE,
  route_path text NOT NULL,
  anchor_type text NOT NULL DEFAULT 'PAGE' CHECK (anchor_type IN ('PAGE', 'REGION')),
  anchor jsonb,
  pin_number integer,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  body text,
  content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
  author_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  resolved_by_account_id text REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  deleted_by_account_id text REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT rt_review_threads_id_format
    CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT rt_review_threads_route_path
    CHECK (
      char_length(route_path) BETWEEN 1 AND 2048
      AND route_path LIKE '/%'
      AND route_path NOT LIKE '//%'
      AND position('?' IN route_path) = 0
      AND position('#' IN route_path) = 0
    ),
  CONSTRAINT rt_review_threads_anchor_shape
    CHECK (
      (anchor_type = 'PAGE' AND anchor IS NULL)
      OR (
        anchor_type = 'REGION'
        AND jsonb_typeof(anchor) = 'object'
        AND anchor->>'type' = 'REGION_V1'
      )
    ),
  CONSTRAINT rt_review_threads_pin_number_shape
    CHECK (
      (anchor_type = 'PAGE' AND pin_number IS NULL)
      OR (anchor_type = 'REGION' AND pin_number > 0)
    ),
  CONSTRAINT rt_review_threads_body_shape
    CHECK (
      (
        deleted_at IS NULL
        AND deleted_by_account_id IS NULL
        AND body IS NOT NULL
        AND char_length(body) BETWEEN 1 AND 4000
        AND body ~ '[^[:space:]]'
      )
      OR (
        deleted_at IS NOT NULL
        AND deleted_by_account_id IS NOT NULL
        AND body IS NULL
      )
    ),
  CONSTRAINT rt_review_threads_resolution_shape
    CHECK (
      (status = 'OPEN' AND resolved_by_account_id IS NULL AND resolved_at IS NULL)
      OR (
        status = 'RESOLVED'
        AND (
          (resolved_by_account_id IS NULL AND resolved_at IS NULL)
          OR (resolved_by_account_id IS NOT NULL AND resolved_at IS NOT NULL)
        )
      )
    ),
  CONSTRAINT rt_review_threads_time_order CHECK (updated_at >= created_at)
);
ALTER TABLE rt_review_threads
  ADD COLUMN IF NOT EXISTS resolved_by_account_id text
    REFERENCES rt_accounts(id) ON DELETE RESTRICT;
ALTER TABLE rt_review_threads
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
ALTER TABLE rt_review_threads
  ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
ALTER TABLE rt_review_threads
  ADD COLUMN IF NOT EXISTS deleted_by_account_id text
    REFERENCES rt_accounts(id) ON DELETE RESTRICT;
ALTER TABLE rt_review_threads
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE rt_review_threads
  ADD COLUMN IF NOT EXISTS pin_number integer;
WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY revision_id, route_path
           ORDER BY created_at, id
         )::integer AS pin_number
  FROM rt_review_threads
  WHERE anchor_type = 'REGION' AND pin_number IS NULL
)
UPDATE rt_review_threads AS thread
SET pin_number = numbered.pin_number
FROM numbered
WHERE thread.id = numbered.id;
ALTER TABLE rt_review_threads DROP CONSTRAINT IF EXISTS rt_review_threads_content_version;
ALTER TABLE rt_review_threads
  ADD CONSTRAINT rt_review_threads_content_version CHECK (content_version > 0);
ALTER TABLE rt_review_threads ALTER COLUMN body DROP NOT NULL;
ALTER TABLE rt_review_threads DROP CONSTRAINT IF EXISTS rt_review_threads_body_length;
ALTER TABLE rt_review_threads DROP CONSTRAINT IF EXISTS rt_review_threads_body_shape;
ALTER TABLE rt_review_threads
  ADD CONSTRAINT rt_review_threads_body_shape
  CHECK (
    (
      deleted_at IS NULL
      AND deleted_by_account_id IS NULL
      AND body IS NOT NULL
      AND char_length(body) BETWEEN 1 AND 4000
      AND body ~ '[^[:space:]]'
    )
    OR (
      deleted_at IS NOT NULL
      AND deleted_by_account_id IS NOT NULL
      AND body IS NULL
    )
  );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rt_review_threads_region_v1_shape'
      AND conrelid = 'rt_review_threads'::regclass
  ) THEN
    ALTER TABLE rt_review_threads
      ADD CONSTRAINT rt_review_threads_region_v1_shape
      CHECK (
        anchor_type <> 'REGION'
        OR (
          jsonb_typeof(anchor) = 'object'
          AND anchor->>'type' = 'REGION_V1'
        )
      );
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rt_review_threads_resolution_shape'
      AND conrelid = 'rt_review_threads'::regclass
  ) THEN
    ALTER TABLE rt_review_threads
      ADD CONSTRAINT rt_review_threads_resolution_shape
      CHECK (
        (status = 'OPEN' AND resolved_by_account_id IS NULL AND resolved_at IS NULL)
        OR (
          status = 'RESOLVED'
          AND (
            (resolved_by_account_id IS NULL AND resolved_at IS NULL)
            OR (resolved_by_account_id IS NOT NULL AND resolved_at IS NOT NULL)
          )
        )
      );
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rt_review_threads_pin_number_shape'
      AND conrelid = 'rt_review_threads'::regclass
  ) THEN
    ALTER TABLE rt_review_threads
      ADD CONSTRAINT rt_review_threads_pin_number_shape
      CHECK (
        (anchor_type = 'PAGE' AND pin_number IS NULL)
        OR (anchor_type = 'REGION' AND pin_number > 0)
      );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS rt_review_threads_revision_route_created_idx
  ON rt_review_threads(revision_id, route_path, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS rt_review_threads_revision_route_pin_unique
  ON rt_review_threads(revision_id, route_path, pin_number)
  WHERE pin_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS rt_review_pin_counters (
  revision_id text NOT NULL REFERENCES rt_review_revisions(id) ON DELETE CASCADE,
  route_path text NOT NULL,
  next_pin_number integer NOT NULL CHECK (next_pin_number > 0),
  PRIMARY KEY (revision_id, route_path)
);
INSERT INTO rt_review_pin_counters (revision_id, route_path, next_pin_number)
SELECT revision_id, route_path, max(pin_number) + 1
FROM rt_review_threads
WHERE pin_number IS NOT NULL
GROUP BY revision_id, route_path
ON CONFLICT (revision_id, route_path) DO UPDATE
SET next_pin_number = GREATEST(
  rt_review_pin_counters.next_pin_number,
  EXCLUDED.next_pin_number
);

CREATE TABLE IF NOT EXISTS rt_review_replies (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES rt_review_threads(id) ON DELETE CASCADE,
  body text,
  content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
  author_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  deleted_by_account_id text REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT rt_review_replies_id_format
    CHECK (id ~ '^[A-Za-z0-9_-]{1,128}$'),
  CONSTRAINT rt_review_replies_body_shape
    CHECK (
      (
        deleted_at IS NULL
        AND deleted_by_account_id IS NULL
        AND body IS NOT NULL
        AND char_length(body) BETWEEN 1 AND 4000
        AND body ~ '[^[:space:]]'
      )
      OR (
        deleted_at IS NOT NULL
        AND deleted_by_account_id IS NOT NULL
        AND body IS NULL
      )
    )
);
ALTER TABLE rt_review_replies
  ADD COLUMN IF NOT EXISTS content_version integer NOT NULL DEFAULT 1;
ALTER TABLE rt_review_replies
  ADD COLUMN IF NOT EXISTS deleted_by_account_id text
    REFERENCES rt_accounts(id) ON DELETE RESTRICT;
ALTER TABLE rt_review_replies
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE rt_review_replies ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE rt_review_replies SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE rt_review_replies ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE rt_review_replies ALTER COLUMN body DROP NOT NULL;
ALTER TABLE rt_review_replies DROP CONSTRAINT IF EXISTS rt_review_replies_content_version;
ALTER TABLE rt_review_replies
  ADD CONSTRAINT rt_review_replies_content_version CHECK (content_version > 0);
ALTER TABLE rt_review_replies DROP CONSTRAINT IF EXISTS rt_review_replies_body_length;
ALTER TABLE rt_review_replies DROP CONSTRAINT IF EXISTS rt_review_replies_body_shape;
ALTER TABLE rt_review_replies
  ADD CONSTRAINT rt_review_replies_body_shape
  CHECK (
    (
      deleted_at IS NULL
      AND deleted_by_account_id IS NULL
      AND body IS NOT NULL
      AND char_length(body) BETWEEN 1 AND 4000
      AND body ~ '[^[:space:]]'
    )
    OR (
      deleted_at IS NOT NULL
      AND deleted_by_account_id IS NOT NULL
      AND body IS NULL
    )
  );
CREATE INDEX IF NOT EXISTS rt_review_replies_thread_created_idx
  ON rt_review_replies(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS rt_review_mentions (
  revision_id text NOT NULL REFERENCES rt_review_revisions(id) ON DELETE CASCADE,
  route_path text NOT NULL,
  thread_id text NOT NULL REFERENCES rt_review_threads(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('COMMENT', 'REPLY')),
  content_id text NOT NULL,
  recipient_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (content_type, content_id, recipient_account_id),
  CONSTRAINT rt_review_mentions_route_path
    CHECK (
      char_length(route_path) BETWEEN 1 AND 2048
      AND route_path LIKE '/%'
      AND route_path NOT LIKE '//%'
      AND position('?' IN route_path) = 0
      AND position('#' IN route_path) = 0
    )
);
CREATE INDEX IF NOT EXISTS rt_review_mentions_revision_route_recipient_idx
  ON rt_review_mentions(revision_id, route_path, recipient_account_id);

CREATE TABLE IF NOT EXISTS rt_review_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id text NOT NULL REFERENCES rt_review_revisions(id) ON DELETE CASCADE,
  route_path text NOT NULL,
  thread_id text NOT NULL REFERENCES rt_review_threads(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('COMMENT', 'REPLY')),
  content_id text NOT NULL,
  recipient_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE CASCADE,
  actor_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  read_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT rt_review_notifications_route_path
    CHECK (
      char_length(route_path) BETWEEN 1 AND 2048
      AND route_path LIKE '/%'
      AND route_path NOT LIKE '//%'
      AND position('?' IN route_path) = 0
      AND position('#' IN route_path) = 0
    )
);
CREATE INDEX IF NOT EXISTS rt_review_notifications_recipient_revision_route_id_idx
  ON rt_review_notifications(recipient_account_id, revision_id, route_path, id DESC);

CREATE TABLE IF NOT EXISTS rt_review_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision_id text NOT NULL REFERENCES rt_review_revisions(id) ON DELETE CASCADE,
  route_path text NOT NULL,
  thread_id text NOT NULL REFERENCES rt_review_threads(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'COMMENT_CREATED',
    'REPLY_CREATED',
    'THREAD_STATUS_CHANGED',
    'COMMENT_UPDATED',
    'COMMENT_DELETED',
    'REPLY_UPDATED',
    'REPLY_DELETED',
    'NOTIFICATION_CREATED',
    'NOTIFICATION_READ_CHANGED'
  )),
  actor_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  recipient_account_id text REFERENCES rt_accounts(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT rt_review_events_route_path
    CHECK (
      char_length(route_path) BETWEEN 1 AND 2048
      AND route_path LIKE '/%'
      AND route_path NOT LIKE '//%'
      AND position('?' IN route_path) = 0
      AND position('#' IN route_path) = 0
    )
);
ALTER TABLE rt_review_events
  ADD COLUMN IF NOT EXISTS recipient_account_id text
    REFERENCES rt_accounts(id) ON DELETE CASCADE;
ALTER TABLE rt_review_events
  DROP CONSTRAINT IF EXISTS rt_review_events_event_type_check;
ALTER TABLE rt_review_events
  ADD CONSTRAINT rt_review_events_event_type_check CHECK (event_type IN (
    'COMMENT_CREATED',
    'REPLY_CREATED',
    'THREAD_STATUS_CHANGED',
    'COMMENT_UPDATED',
    'COMMENT_DELETED',
    'REPLY_UPDATED',
    'REPLY_DELETED',
    'NOTIFICATION_CREATED',
    'NOTIFICATION_READ_CHANGED'
  ));
CREATE INDEX IF NOT EXISTS rt_review_events_revision_route_id_idx
  ON rt_review_events(revision_id, route_path, id);
CREATE INDEX IF NOT EXISTS rt_review_events_occurred_at_idx
  ON rt_review_events(occurred_at, id);
CREATE INDEX IF NOT EXISTS rt_review_events_recipient_id_idx
  ON rt_review_events(recipient_account_id, id)
  WHERE recipient_account_id IS NOT NULL;

INSERT INTO rt_schema_migrations(version) VALUES (9)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (10)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (11)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (12)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (13)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (14)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (15)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (16)
ON CONFLICT (version) DO NOTHING;
INSERT INTO rt_schema_migrations(version) VALUES (17)
ON CONFLICT (version) DO NOTHING;

ALTER TABLE rt_review_threads ADD COLUMN IF NOT EXISTS workflow_version integer NOT NULL DEFAULT 1 CHECK (workflow_version > 0);
ALTER TABLE rt_review_threads DROP CONSTRAINT IF EXISTS rt_review_threads_status_check;
ALTER TABLE rt_review_threads ADD CONSTRAINT rt_review_threads_status_check CHECK (status IN ('OPEN', 'NEEDS_REVIEW', 'RESOLVED'));
ALTER TABLE rt_review_threads DROP CONSTRAINT IF EXISTS rt_review_threads_resolution_shape;
ALTER TABLE rt_review_threads ADD CONSTRAINT rt_review_threads_resolution_shape CHECK (
  (status <> 'RESOLVED' AND resolved_by_account_id IS NULL AND resolved_at IS NULL)
  OR (status = 'RESOLVED' AND ((resolved_by_account_id IS NULL AND resolved_at IS NULL) OR (resolved_by_account_id IS NOT NULL AND resolved_at IS NOT NULL)))
);
CREATE TABLE IF NOT EXISTS rt_review_workflow_history (
  thread_id text NOT NULL REFERENCES rt_review_threads(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 1),
  from_status text NOT NULL CHECK (from_status IN ('OPEN', 'NEEDS_REVIEW', 'RESOLVED')),
  to_status text NOT NULL CHECK (to_status IN ('OPEN', 'NEEDS_REVIEW', 'RESOLVED')),
  actor_account_id text NOT NULL REFERENCES rt_accounts(id) ON DELETE RESTRICT,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (thread_id, version)
);
CREATE INDEX IF NOT EXISTS rt_review_threads_revision_created_idx ON rt_review_threads(revision_id, created_at DESC, id DESC);
INSERT INTO rt_schema_migrations(version) VALUES (18) ON CONFLICT (version) DO NOTHING;
ALTER TABLE rt_review_notifications ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT 'MENTION' CHECK (reason IN ('MENTION', 'REPLY'));
CREATE INDEX IF NOT EXISTS rt_review_notifications_recipient_id_idx ON rt_review_notifications(recipient_account_id, id DESC);
CREATE INDEX IF NOT EXISTS rt_review_notifications_unread_idx ON rt_review_notifications(recipient_account_id, id DESC) WHERE read_at IS NULL;
INSERT INTO rt_schema_migrations(version) VALUES (19) ON CONFLICT (version) DO NOTHING;
ALTER TABLE rt_review_notifications DROP CONSTRAINT IF EXISTS rt_review_notifications_reason_check;
ALTER TABLE rt_review_notifications ADD CONSTRAINT rt_review_notifications_reason_check CHECK (reason IN ('MENTION', 'REPLY', 'WORKFLOW_REQUEST', 'WORKFLOW_RESULT'));
ALTER TABLE rt_review_notifications ADD COLUMN IF NOT EXISTS source_key text;
UPDATE rt_review_notifications SET source_key = 'legacy:' || id WHERE source_key IS NULL;
ALTER TABLE rt_review_notifications ALTER COLUMN source_key SET NOT NULL;
ALTER TABLE rt_review_notifications ADD COLUMN IF NOT EXISTS workflow_version integer;
CREATE UNIQUE INDEX IF NOT EXISTS rt_review_notifications_source_unique ON rt_review_notifications(recipient_account_id, source_key);
INSERT INTO rt_schema_migrations(version) VALUES (20) ON CONFLICT (version) DO NOTHING;
`;
