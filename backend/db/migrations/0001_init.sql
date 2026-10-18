-- 0001_init: full schema. Hand-written because Prisma's schema language cannot express
-- partial indexes, trigram (GIN) indexes, CHECK constraints or triggers.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE role          AS ENUM ('VIEWER', 'MEMBER', 'LEAD', 'ADMIN');
CREATE TYPE item_type     AS ENUM ('INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK');
CREATE TYPE priority      AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
CREATE TYPE item_status   AS ENUM ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED');
CREATE TYPE activity_type AS ENUM ('CREATED', 'STATUS_CHANGED', 'ASSIGNED', 'PRIORITY_CHANGED', 'FIELDS_UPDATED', 'COMMENT_ADDED');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

-- A user can belong to several teams, with a different role in each.
CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role    role NOT NULL,
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX idx_memberships_team ON memberships (team_id);

CREATE TABLE work_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description   text NOT NULL DEFAULT '',
  type          item_type   NOT NULL,
  priority      priority    NOT NULL DEFAULT 'MEDIUM',
  status        item_status NOT NULL DEFAULT 'OPEN',
  team_id       uuid NOT NULL REFERENCES teams(id),
  assignee_id   uuid REFERENCES users(id),
  created_by_id uuid NOT NULL REFERENCES users(id),
  due_date      timestamptz(3),
  version       integer NOT NULL DEFAULT 1,           -- optimistic-locking counter
  created_at    timestamptz(3) NOT NULL DEFAULT now(),
  updated_at    timestamptz(3) NOT NULL DEFAULT now(),
  -- Invariant: only an OPEN item may be unassigned.
  CONSTRAINT work_items_assigned_unless_open CHECK (assignee_id IS NOT NULL OR status = 'OPEN')
);

-- Keyset pagination + team scoping (every list query filters by team_id).
CREATE INDEX idx_items_team_created        ON work_items (team_id, created_at DESC, id DESC);
CREATE INDEX idx_items_team_status_created ON work_items (team_id, status, created_at DESC, id DESC);
-- "Assigned to me"
CREATE INDEX idx_items_assignee_status     ON work_items (assignee_id, status, created_at DESC, id DESC);
-- "Unassigned urgent": tiny partial index containing only the rows that dashboard cares about.
CREATE INDEX idx_items_unassigned_urgent   ON work_items (team_id, created_at DESC, id DESC)
  WHERE assignee_id IS NULL AND priority = 'URGENT';
-- Substring search (ILIKE '%q%') served by trigram indexes.
CREATE INDEX idx_items_title_trgm ON work_items USING gin (title gin_trgm_ops);
CREATE INDEX idx_items_desc_trgm  ON work_items USING gin (description gin_trgm_ops);

CREATE TABLE activity_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq        bigint GENERATED ALWAYS AS IDENTITY,   -- strict insertion order (timestamps can tie)
  item_id    uuid NOT NULL REFERENCES work_items(id),
  actor_id   uuid NOT NULL REFERENCES users(id),
  type       activity_type NOT NULL,
  from_value text,
  to_value   text,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_item_seq ON activity_events (item_id, seq);

-- Append-only is enforced by the database, not by convention.
CREATE FUNCTION forbid_activity_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity_events is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_events_append_only
  BEFORE UPDATE OR DELETE ON activity_events
  FOR EACH ROW EXECUTE FUNCTION forbid_activity_mutation();

CREATE TABLE comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES work_items(id),
  author_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX idx_comments_item_created ON comments (item_id, created_at, id);

-- Idempotency: one row per (user, key). The row is inserted in the same transaction
-- as the work it protects, so it exists if and only if that work committed.
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key             text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
