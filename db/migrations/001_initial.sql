-- Scopehatch Sprint 01. Run as a migration owner, NEVER as the runtime role.
-- PostgreSQL >= 14. Only grant scopehatch_app to trusted API login roles.
BEGIN;
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scopehatch_app') THEN
    CREATE ROLE scopehatch_app NOLOGIN NOBYPASSRLS;
  END IF;
END $role$;
CREATE SCHEMA IF NOT EXISTS scopehatch;
REVOKE ALL ON SCHEMA scopehatch FROM PUBLIC;

CREATE TABLE IF NOT EXISTS scopehatch.tenants (
  id text PRIMARY KEY CHECK (length(trim(id)) > 0),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scopehatch.memberships (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id) ON DELETE RESTRICT,
  principal_id text NOT NULL CHECK (length(trim(principal_id)) > 0),
  roles text[] NOT NULL CHECK (
    cardinality(roles) > 0
    AND roles <@ ARRAY['owner','operator','reviewer']::text[]
  ),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id)
);

-- SECURITY DEFINER only reads memberships. The migration owner must NOT be
-- the API role. memberships intentionally has no FORCE RLS: the owner can
-- perform this non-recursive existence check; API connections remain subject
-- to its SELECT policy. The caller's context is provided by trusted middleware.
CREATE OR REPLACE FUNCTION scopehatch.actor_id() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('scopehatch.actor_id', true), '') $$;
CREATE OR REPLACE FUNCTION scopehatch.tenant_id() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('scopehatch.tenant_id', true), '') $$;
CREATE OR REPLACE FUNCTION scopehatch.is_member(p_tenant text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, scopehatch
AS $$
  SELECT p_tenant IS NOT NULL
    AND p_tenant = scopehatch.tenant_id()
    AND EXISTS (
      SELECT 1 FROM scopehatch.memberships m
      WHERE m.tenant_id = p_tenant
        AND m.principal_id = scopehatch.actor_id() AND m.active
    )
$$;
CREATE OR REPLACE FUNCTION scopehatch.has_role(p_tenant text, required_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, scopehatch
AS $$
  SELECT scopehatch.is_member(p_tenant) AND EXISTS (
    SELECT 1 FROM scopehatch.memberships m
    WHERE m.tenant_id = p_tenant AND m.principal_id = scopehatch.actor_id()
      AND m.active AND m.roles && required_roles
  )
$$;

CREATE TABLE IF NOT EXISTS scopehatch.projects (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id),
  id text NOT NULL CHECK (length(trim(id)) > 0),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES scopehatch.memberships(tenant_id, principal_id)
);
CREATE TABLE IF NOT EXISTS scopehatch.intakes (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  brief text NOT NULL CHECK (length(trim(brief)) > 0),
  author_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES scopehatch.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, author_id)
    REFERENCES scopehatch.memberships(tenant_id, principal_id)
);
CREATE TABLE IF NOT EXISTS scopehatch.catalog_versions (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id),
  version integer NOT NULL CHECK (version > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version),
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES scopehatch.memberships(tenant_id, principal_id)
);
CREATE TABLE IF NOT EXISTS scopehatch.catalog_services (
  tenant_id text NOT NULL,
  catalog_version integer NOT NULL,
  service_id text NOT NULL CHECK (length(trim(service_id)) > 0),
  label text NOT NULL CHECK (length(trim(label)) > 0),
  unit_price_minor bigint NOT NULL CHECK
    (unit_price_minor BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, catalog_version, service_id),
  FOREIGN KEY (tenant_id, catalog_version)
    REFERENCES scopehatch.catalog_versions(tenant_id, version)
);
CREATE TABLE IF NOT EXISTS scopehatch.scope_revisions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  intake_revision integer NOT NULL,
  author_id text NOT NULL,
  unknowns jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(unknowns) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES scopehatch.projects(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id, intake_revision)
    REFERENCES scopehatch.intakes(tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, author_id)
    REFERENCES scopehatch.memberships(tenant_id, principal_id)
);
CREATE TABLE IF NOT EXISTS scopehatch.scope_deliverables (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  scope_revision integer NOT NULL,
  line_no integer NOT NULL CHECK (line_no >= 0),
  service_id text NOT NULL CHECK (length(trim(service_id)) > 0),
  quantity bigint CHECK (quantity BETWEEN 1 AND 9007199254740991),
  evidence text NOT NULL DEFAULT '',
  source text NOT NULL CHECK (source IN ('brief', 'manual')),
  PRIMARY KEY (tenant_id, project_id, scope_revision, line_no),
  FOREIGN KEY (tenant_id, project_id, scope_revision)
    REFERENCES scopehatch.scope_revisions(tenant_id, project_id, revision)
);
CREATE TABLE IF NOT EXISTS scopehatch.estimate_revisions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  scope_revision integer NOT NULL,
  catalog_version integer NOT NULL,
  created_by text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  state text NOT NULL CHECK (state IN ('blocked', 'ready')),
  total_minor bigint CHECK (total_minor BETWEEN 0 AND 9007199254740991),
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  blockers jsonb NOT NULL CHECK (jsonb_typeof(blockers) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, revision),
  UNIQUE (tenant_id, project_id, revision, scope_revision, catalog_version),
  FOREIGN KEY (tenant_id, project_id, scope_revision)
    REFERENCES scopehatch.scope_revisions(tenant_id, project_id, revision),
  FOREIGN KEY (tenant_id, catalog_version)
    REFERENCES scopehatch.catalog_versions(tenant_id, version),
  FOREIGN KEY (tenant_id, created_by)
    REFERENCES scopehatch.memberships(tenant_id, principal_id),
  CONSTRAINT estimate_state_consistency CHECK (
    (state = 'ready' AND total_minor IS NOT NULL AND blockers = '[]'::jsonb)
    OR (state = 'blocked' AND total_minor IS NULL AND blockers <> '[]'::jsonb)
  )
);
CREATE TABLE IF NOT EXISTS scopehatch.reviews (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  id text NOT NULL,
  estimate_revision integer NOT NULL,
  scope_revision integer NOT NULL,
  catalog_version integer NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved')),
  submitted_by text NOT NULL,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  PRIMARY KEY (tenant_id, project_id, id),
  UNIQUE (tenant_id, project_id, estimate_revision),
  FOREIGN KEY (tenant_id, project_id, estimate_revision, scope_revision, catalog_version)
    REFERENCES scopehatch.estimate_revisions
      (tenant_id, project_id, revision, scope_revision, catalog_version),
  FOREIGN KEY (tenant_id, submitted_by)
    REFERENCES scopehatch.memberships(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, approved_by)
    REFERENCES scopehatch.memberships(tenant_id, principal_id),
  CONSTRAINT review_state_consistency CHECK (
    (state = 'pending' AND approved_by IS NULL AND approved_at IS NULL)
    OR (state = 'approved' AND approved_by IS NOT NULL
        AND approved_at IS NOT NULL AND approved_by <> submitted_by)
  )
);
CREATE TABLE IF NOT EXISTS scopehatch.audit_events (
  tenant_id text NOT NULL,
  id text NOT NULL,
  project_id text,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (length(trim(action)) > 0),
  object_revision integer,
  request_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES scopehatch.tenants(id),
  FOREIGN KEY (tenant_id, actor_id)
    REFERENCES scopehatch.memberships(tenant_id, principal_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES scopehatch.projects(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS audit_project_cursor
  ON scopehatch.audit_events (tenant_id, project_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS scopehatch.idempotency_records (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  actor_id text NOT NULL,
  operation text NOT NULL CHECK (length(trim(operation)) > 0),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key),
  FOREIGN KEY (tenant_id, actor_id)
    REFERENCES scopehatch.memberships(tenant_id, principal_id)
);

CREATE OR REPLACE FUNCTION scopehatch.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
BEGIN
  RAISE EXCEPTION 'immutable record: %', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- Serializes mutations that can supersede an approval. Lock order is tenant,
-- then project everywhere. These guards also apply to direct SQL writes.
CREATE OR REPLACE FUNCTION scopehatch.guard_revision_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE previous integer;
BEGIN
  IF NEW.tenant_id <> scopehatch.tenant_id() OR
     NEW.author_id <> scopehatch.actor_id() OR
     NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator']) THEN
    RAISE EXCEPTION 'principal mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scopehatch.tenants WHERE id = NEW.tenant_id FOR UPDATE;
  PERFORM 1 FROM scopehatch.projects
    WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  IF TG_TABLE_NAME = 'intakes' THEN
    SELECT coalesce(max(revision), 0) INTO previous FROM scopehatch.intakes
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
  ELSE
    SELECT coalesce(max(revision), 0) INTO previous FROM scopehatch.scope_revisions
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
    IF NEW.intake_revision <> (
      SELECT max(revision) FROM scopehatch.intakes
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
    ) THEN
      RAISE EXCEPTION 'stale intake' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.revision <> previous + 1 THEN
    RAISE EXCEPTION 'nonsequential revision' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION scopehatch.guard_project_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM scopehatch.tenant_id()
     OR NEW.created_by IS DISTINCT FROM scopehatch.actor_id()
     OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator']) THEN
    RAISE EXCEPTION 'project creation permission denied' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $;

CREATE OR REPLACE FUNCTION scopehatch.guard_catalog_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE previous integer;
BEGIN
  IF NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator'])
     OR NEW.created_by <> scopehatch.actor_id() THEN
    RAISE EXCEPTION 'catalog permission denied' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scopehatch.tenants WHERE id = NEW.tenant_id FOR UPDATE;
  SELECT coalesce(max(version), 0) INTO previous FROM scopehatch.catalog_versions
    WHERE tenant_id = NEW.tenant_id;
  IF NEW.version <> previous + 1 THEN
    RAISE EXCEPTION 'nonsequential catalog version' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

-- Returns a stable snapshot after acquiring the serialization locks.
CREATE OR REPLACE FUNCTION scopehatch.assert_current_quote(
  p_tenant text, p_project text, p_scope integer, p_catalog integer,
  p_estimate integer
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE q_state text;
BEGIN
  PERFORM 1 FROM scopehatch.tenants WHERE id = p_tenant FOR UPDATE;
  PERFORM 1 FROM scopehatch.projects
    WHERE tenant_id = p_tenant AND id = p_project FOR UPDATE;
  IF p_scope IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.scope_revisions
      WHERE tenant_id = p_tenant AND project_id = p_project
    ) OR p_catalog IS DISTINCT FROM (
      SELECT max(version) FROM scopehatch.catalog_versions
      WHERE tenant_id = p_tenant
    ) OR p_estimate IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.estimate_revisions
      WHERE tenant_id = p_tenant AND project_id = p_project
    ) THEN
    RAISE EXCEPTION 'stale quote' USING ERRCODE = '23514';
  END IF;
  SELECT state INTO q_state FROM scopehatch.estimate_revisions
  WHERE tenant_id = p_tenant AND project_id = p_project
    AND revision = p_estimate AND scope_revision = p_scope
    AND catalog_version = p_catalog;
  IF q_state IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'quote is not ready' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION scopehatch.guard_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE scope_author text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' OR NEW.approved_by IS NOT NULL
      OR NEW.approved_at IS NOT NULL OR NEW.submitted_by <> scopehatch.actor_id()
      OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator'])
    THEN RAISE EXCEPTION 'invalid review submission' USING ERRCODE = '42501'; END IF;
    PERFORM scopehatch.assert_current_quote(
      NEW.tenant_id, NEW.project_id, NEW.scope_revision,
      NEW.catalog_version, NEW.estimate_revision
    );
    SELECT author_id INTO scope_author FROM scopehatch.scope_revisions
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
      AND revision = NEW.scope_revision;
    IF scope_author IS DISTINCT FROM NEW.submitted_by THEN
      RAISE EXCEPTION 'only scope author may submit' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF (to_jsonb(NEW) - 'state' - 'approved_by' - 'approved_at')
        IS DISTINCT FROM
       (to_jsonb(OLD) - 'state' - 'approved_by' - 'approved_at')
      OR OLD.state <> 'pending' OR NEW.state <> 'approved'
      OR NEW.approved_by IS DISTINCT FROM scopehatch.actor_id()
      OR NEW.approved_by = OLD.submitted_by OR NEW.approved_at IS NULL
      OR NOT scopehatch.has_role(OLD.tenant_id, ARRAY['owner','reviewer'])
    THEN RAISE EXCEPTION 'invalid approval transition' USING ERRCODE = '42501'; END IF;
    PERFORM scopehatch.assert_current_quote(
      OLD.tenant_id, OLD.project_id, OLD.scope_revision,
      OLD.catalog_version, OLD.estimate_revision
    );
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION scopehatch.guard_estimate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE previous integer;
DECLARE catalog_currency text;
BEGIN
  IF NEW.created_by IS DISTINCT FROM scopehatch.actor_id()
     OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator']) THEN
    RAISE EXCEPTION 'principal mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scopehatch.tenants WHERE id = NEW.tenant_id FOR UPDATE;
  PERFORM 1 FROM scopehatch.projects
    WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  SELECT coalesce(max(revision), 0) INTO previous FROM scopehatch.estimate_revisions
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
  SELECT currency INTO catalog_currency FROM scopehatch.catalog_versions
    WHERE tenant_id = NEW.tenant_id AND version = NEW.catalog_version;
  IF NEW.revision <> previous + 1
    OR NEW.scope_revision IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.scope_revisions
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
    ) OR NEW.catalog_version IS DISTINCT FROM (
      SELECT max(version) FROM scopehatch.catalog_versions
      WHERE tenant_id = NEW.tenant_id
    ) OR NEW.currency IS DISTINCT FROM catalog_currency
  THEN RAISE EXCEPTION 'stale estimate or currency mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION scopehatch.guard_audit_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
BEGIN
  IF NEW.actor_id IS DISTINCT FROM scopehatch.actor_id() THEN
    RAISE EXCEPTION 'audit actor mismatch' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS immutable_tenants ON scopehatch.tenants;
CREATE TRIGGER immutable_tenants BEFORE UPDATE OR DELETE ON scopehatch.tenants
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS guard_project_insert ON scopehatch.projects;
CREATE TRIGGER guard_project_insert BEFORE INSERT ON scopehatch.projects
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_project_insert();
DROP TRIGGER IF EXISTS immutable_projects ON scopehatch.projects;
CREATE TRIGGER immutable_projects BEFORE UPDATE OR DELETE ON scopehatch.projects
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_intakes ON scopehatch.intakes;
CREATE TRIGGER immutable_intakes BEFORE UPDATE OR DELETE ON scopehatch.intakes
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_catalog_versions ON scopehatch.catalog_versions;
CREATE TRIGGER immutable_catalog_versions BEFORE UPDATE OR DELETE ON scopehatch.catalog_versions
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_catalog_services ON scopehatch.catalog_services;
CREATE TRIGGER immutable_catalog_services BEFORE UPDATE OR DELETE ON scopehatch.catalog_services
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_scope_revisions ON scopehatch.scope_revisions;
CREATE TRIGGER immutable_scope_revisions BEFORE UPDATE OR DELETE ON scopehatch.scope_revisions
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_scope_deliverables ON scopehatch.scope_deliverables;
CREATE TRIGGER immutable_scope_deliverables BEFORE UPDATE OR DELETE ON scopehatch.scope_deliverables
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_estimate_revisions ON scopehatch.estimate_revisions;
CREATE TRIGGER immutable_estimate_revisions BEFORE UPDATE OR DELETE ON scopehatch.estimate_revisions
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_audit_events ON scopehatch.audit_events;
CREATE TRIGGER immutable_audit_events BEFORE UPDATE OR DELETE ON scopehatch.audit_events
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS immutable_idempotency ON scopehatch.idempotency_records;
CREATE TRIGGER immutable_idempotency BEFORE UPDATE OR DELETE ON scopehatch.idempotency_records
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS guard_intake_insert ON scopehatch.intakes;
CREATE TRIGGER guard_intake_insert BEFORE INSERT ON scopehatch.intakes
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_revision_insert();
DROP TRIGGER IF EXISTS guard_scope_insert ON scopehatch.scope_revisions;
CREATE TRIGGER guard_scope_insert BEFORE INSERT ON scopehatch.scope_revisions
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_revision_insert();
DROP TRIGGER IF EXISTS guard_catalog_insert ON scopehatch.catalog_versions;
CREATE TRIGGER guard_catalog_insert BEFORE INSERT ON scopehatch.catalog_versions
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_catalog_insert();
DROP TRIGGER IF EXISTS guard_estimate_insert ON scopehatch.estimate_revisions;
CREATE TRIGGER guard_estimate_insert BEFORE INSERT ON scopehatch.estimate_revisions
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_estimate_insert();
DROP TRIGGER IF EXISTS guard_review_change ON scopehatch.reviews;
CREATE TRIGGER guard_review_change BEFORE INSERT OR UPDATE ON scopehatch.reviews
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_review();
DROP TRIGGER IF EXISTS immutable_reviews_delete ON scopehatch.reviews;
CREATE TRIGGER immutable_reviews_delete BEFORE DELETE ON scopehatch.reviews
FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS guard_audit_insert ON scopehatch.audit_events;
CREATE TRIGGER guard_audit_insert BEFORE INSERT ON scopehatch.audit_events
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_audit_insert();

-- Membership provisioning is an administrative operation, not an API mutation.
-- Its owner bypass must be limited to a protected migration/provisioning identity.
DO $policies$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY[
    'tenants','memberships','projects','intakes','catalog_versions',
    'catalog_services','scope_revisions','scope_deliverables',
    'estimate_revisions','reviews','audit_events','idempotency_records'
  ] LOOP
    EXECUTE format('ALTER TABLE scopehatch.%I ENABLE ROW LEVEL SECURITY', tab);
    IF tab <> 'memberships' THEN
      EXECUTE format('ALTER TABLE scopehatch.%I FORCE ROW LEVEL SECURITY', tab);
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_access ON scopehatch.%I', tab);
    IF tab = 'tenants' THEN
      EXECUTE 'CREATE POLICY tenant_access ON scopehatch.tenants FOR ALL TO scopehatch_app USING (scopehatch.is_member(id)) WITH CHECK (scopehatch.is_member(id))';
    ELSE
      EXECUTE format('CREATE POLICY tenant_access ON scopehatch.%I FOR ALL TO scopehatch_app USING (scopehatch.is_member(tenant_id)) WITH CHECK (scopehatch.is_member(tenant_id))', tab);
    END IF;
  END LOOP;
END $policies$;

REVOKE ALL ON ALL TABLES IN SCHEMA scopehatch FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA scopehatch FROM PUBLIC;
GRANT USAGE ON SCHEMA scopehatch TO scopehatch_app;
GRANT EXECUTE ON FUNCTION scopehatch.actor_id() TO scopehatch_app;
GRANT EXECUTE ON FUNCTION scopehatch.tenant_id() TO scopehatch_app;
GRANT EXECUTE ON FUNCTION scopehatch.is_member(text) TO scopehatch_app;
GRANT EXECUTE ON FUNCTION scopehatch.has_role(text,text[]) TO scopehatch_app;
GRANT EXECUTE ON FUNCTION scopehatch.assert_current_quote(text,text,integer,integer,integer) TO scopehatch_app;
GRANT SELECT, UPDATE ON scopehatch.tenants, scopehatch.projects TO scopehatch_app;
GRANT INSERT ON scopehatch.projects TO scopehatch_app;
GRANT SELECT ON scopehatch.memberships TO scopehatch_app;
GRANT SELECT, INSERT ON scopehatch.intakes, scopehatch.catalog_versions,
  scopehatch.catalog_services, scopehatch.scope_revisions,
  scopehatch.scope_deliverables, scopehatch.estimate_revisions,
  scopehatch.audit_events, scopehatch.idempotency_records TO scopehatch_app;
GRANT SELECT, INSERT, UPDATE ON scopehatch.reviews TO scopehatch_app;
COMMIT;
