-- Idempotent: runs on every server start. Add new columns with
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS below the CREATE, never by editing
-- an existing CREATE (existing databases would never see the change).

CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  username              VARCHAR(80)  NOT NULL,
  password_hash         TEXT         NOT NULL,
  full_name             VARCHAR(160) NOT NULL,
  role                  VARCHAR(20)  NOT NULL DEFAULT 'User' CHECK (role IN ('Admin', 'User')),
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  failed_login_attempts INTEGER      NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uq ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS documents (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              INTEGER      NOT NULL REFERENCES users(id),
  file_name            VARCHAR(255) NOT NULL,
  file_size            INTEGER      NOT NULL,
  sha256               CHAR(64)     NOT NULL,
  storage_path         TEXT         NOT NULL,
  page_count           INTEGER,
  status               VARCHAR(20)  NOT NULL DEFAULT 'uploaded'
                       CHECK (status IN ('uploaded', 'processing', 'extracting', 'validating', 'completed', 'failed')),
  failure_reason       TEXT,
  warnings             JSONB        NOT NULL DEFAULT '[]',
  field_count          INTEGER      NOT NULL DEFAULT 0,
  avg_confidence       NUMERIC(4,3),
  uploaded_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at         TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS documents_user_idx ON documents (user_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

CREATE TABLE IF NOT EXISTS extracted_fields (
  id               SERIAL PRIMARY KEY,
  document_id      UUID         NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_key        VARCHAR(120) NOT NULL,
  canonical_key    VARCHAR(80),
  label            TEXT         NOT NULL,
  value_raw        TEXT         NOT NULL,
  value_normalized TEXT,
  value_type       VARCHAR(20)  NOT NULL DEFAULT 'text',
  confidence       NUMERIC(4,3) NOT NULL,
  method           VARCHAR(30)  NOT NULL,
  page             INTEGER,
  bbox             JSONB,
  validation       JSONB        NOT NULL DEFAULT '{}',
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  edited_by        INTEGER REFERENCES users(id),
  edited_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS extracted_fields_doc_idx ON extracted_fields (document_id, sort_order);

CREATE TABLE IF NOT EXISTS extracted_tables (
  id          SERIAL PRIMARY KEY,
  document_id UUID    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page        INTEGER NOT NULL,
  headers     JSONB   NOT NULL,
  rows        JSONB   NOT NULL
);
CREATE INDEX IF NOT EXISTS extracted_tables_doc_idx ON extracted_tables (document_id);

-- The "configured field-mapping rules": label synonyms grouped under one canonical key.
CREATE TABLE IF NOT EXISTS field_aliases (
  id            SERIAL PRIMARY KEY,
  canonical_key VARCHAR(80)  NOT NULL,
  alias         VARCHAR(160) NOT NULL,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS field_aliases_alias_uq ON field_aliases (LOWER(alias));

-- Websites the extension may scan and fill. Anything else is refused.
CREATE TABLE IF NOT EXISTS allowed_sites (
  id           SERIAL PRIMARY KEY,
  origin       VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(160) NOT NULL,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Website + form + web field -> PDF field, saved from a confirmed manual mapping.
CREATE TABLE IF NOT EXISTS form_mappings (
  id                  SERIAL PRIMARY KEY,
  origin              VARCHAR(255) NOT NULL,
  form_key            VARCHAR(500) NOT NULL,
  web_field_signature VARCHAR(64)  NOT NULL,
  web_field_label     TEXT,
  field_key           VARCHAR(120) NOT NULL,
  canonical_key       VARCHAR(80),
  use_count           INTEGER      NOT NULL DEFAULT 0,
  created_by          INTEGER REFERENCES users(id),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (origin, form_key, web_field_signature)
);

CREATE TABLE IF NOT EXISTS fill_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER      NOT NULL REFERENCES users(id),
  document_ids UUID[]       NOT NULL,
  origin       VARCHAR(255) NOT NULL,
  path         TEXT,
  form_title   TEXT,
  detected     INTEGER      NOT NULL DEFAULT 0,
  auto_matched INTEGER      NOT NULL DEFAULT 0,
  reviewed     INTEGER      NOT NULL DEFAULT 0,
  filled       INTEGER      NOT NULL DEFAULT 0,
  failed       INTEGER      NOT NULL DEFAULT 0,
  skipped      INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fill_sessions_user_idx ON fill_sessions (user_id, created_at DESC);

-- Per-field outcome of a fill session. Labels and keys only — never values.
CREATE TABLE IF NOT EXISTS fill_session_fields (
  id              SERIAL PRIMARY KEY,
  session_id      INTEGER      NOT NULL REFERENCES fill_sessions(id) ON DELETE CASCADE,
  web_field_label TEXT,
  field_key       VARCHAR(120),
  confidence      NUMERIC(4,3),
  source          VARCHAR(20),
  outcome         VARCHAR(20)  NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id             BIGSERIAL PRIMARY KEY,
  actor_user_id  INTEGER REFERENCES users(id),
  target_user_id INTEGER REFERENCES users(id),
  entity_type    VARCHAR(40),
  entity_id      VARCHAR(80),
  action         VARCHAR(60) NOT NULL,
  details        JSONB,
  ip_address     VARCHAR(80),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);

-- 2026-10-09: known layouts (Yashoda final/summary bill) parsed into their real shape.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_type VARCHAR(40);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS structured JSONB;

-- 2026-10-09: why a fill step failed, and the page's structure at that moment
-- (captions, labels, column headings — no field values), to correct site profiles.
ALTER TABLE fill_session_fields ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE fill_sessions ADD COLUMN IF NOT EXISTS page_outline JSONB;

-- 2026-10-09: with KEEP_PDF=false the PDF is deleted once its data has been
-- read; the document row (extracted data) stays until its retention date.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_kept BOOLEAN NOT NULL DEFAULT TRUE;
