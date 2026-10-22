-- Sprint 02 additive migration. Run as the migration owner after 005.
-- Existing catalog, scope, estimate and approval rows remain immutable.
BEGIN;

CREATE OR REPLACE FUNCTION scopehatch.valid_proposal_metadata(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE k text;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object'
     OR octet_length(value::text) > 65536
     OR NOT (value ?& ARRAY['overview','assumptions','exclusions','commercialTerms'])
     OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 4
     OR jsonb_typeof(value->'overview') <> 'string'
     OR char_length(value->>'overview') > 4000 THEN
    RETURN false;
  END IF;
  FOREACH k IN ARRAY ARRAY['assumptions','exclusions','commercialTerms'] LOOP
    IF jsonb_typeof(value->k) <> 'array'
       OR jsonb_array_length(value->k) > 50 THEN RETURN false; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(value->k) AS element(item)
      WHERE jsonb_typeof(item) <> 'string'
        OR char_length(btrim(item #>> '{}')) NOT BETWEEN 1 AND 2000
    ) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

ALTER TABLE scopehatch.scope_revisions
  ADD COLUMN IF NOT EXISTS proposal jsonb NOT NULL
    DEFAULT '{"overview":"","assumptions":[],"exclusions":[],"commercialTerms":[]}'::jsonb;
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='scopehatch.scope_revisions'::regclass
       AND conname='scope_proposal_metadata_valid'
  ) THEN
    ALTER TABLE scopehatch.scope_revisions
      ADD CONSTRAINT scope_proposal_metadata_valid
      CHECK (scopehatch.valid_proposal_metadata(proposal));
  END IF;
END $constraint$;

ALTER TABLE scopehatch.scope_deliverables
  ADD COLUMN IF NOT EXISTS client_description text NOT NULL DEFAULT '';
DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='scopehatch.scope_deliverables'::regclass
       AND conname='scope_client_description_length'
  ) THEN
    ALTER TABLE scopehatch.scope_deliverables
      ADD CONSTRAINT scope_client_description_length
      CHECK (char_length(client_description) <= 2000);
  END IF;
END $constraint$;

CREATE INDEX IF NOT EXISTS projects_tenant_created_id_desc
  ON scopehatch.projects(tenant_id, created_at DESC, id DESC);

-- The old Sprint 01 trigger allowed operator; Sprint 02 allows only owner.
CREATE OR REPLACE FUNCTION scopehatch.guard_catalog_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,scopehatch AS $$
DECLARE previous integer;
BEGIN
  IF NEW.created_by IS DISTINCT FROM scopehatch.actor_id()
     OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner']) THEN
    RAISE EXCEPTION 'catalog permission denied' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM scopehatch.tenants WHERE id=NEW.tenant_id FOR UPDATE;
  SELECT coalesce(max(version),0) INTO previous
    FROM scopehatch.catalog_versions WHERE tenant_id=NEW.tenant_id;
  IF NEW.version <> previous + 1 THEN
    RAISE EXCEPTION 'nonsequential catalog version' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION scopehatch.guard_catalog_service_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,scopehatch AS $$
DECLARE expected integer; existing integer; owner_id text; parent_txid bigint;
BEGIN
  PERFORM 1 FROM scopehatch.tenants WHERE id=NEW.tenant_id FOR UPDATE;
  SELECT service_count,created_by,creation_txid
    INTO expected,owner_id,parent_txid FROM scopehatch.catalog_versions
   WHERE tenant_id=NEW.tenant_id AND version=NEW.catalog_version;
  SELECT count(*)::integer INTO existing FROM scopehatch.catalog_services
   WHERE tenant_id=NEW.tenant_id AND catalog_version=NEW.catalog_version;
  IF expected IS NULL OR existing >= expected
     OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner'])
     OR owner_id IS DISTINCT FROM scopehatch.actor_id()
     OR parent_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'immutable catalog version cannot add lines'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Preserve tenant-member read access; make direct SQL inserts owner-only.
DROP POLICY IF EXISTS tenant_access ON scopehatch.catalog_versions;
DROP POLICY IF EXISTS tenant_access ON scopehatch.catalog_services;
DROP POLICY IF EXISTS catalog_read ON scopehatch.catalog_versions;
DROP POLICY IF EXISTS catalog_create ON scopehatch.catalog_versions;
DROP POLICY IF EXISTS catalog_read ON scopehatch.catalog_services;
DROP POLICY IF EXISTS catalog_create ON scopehatch.catalog_services;
CREATE POLICY catalog_read ON scopehatch.catalog_versions FOR SELECT TO scopehatch_app
  USING (scopehatch.is_member(tenant_id));
CREATE POLICY catalog_create ON scopehatch.catalog_versions FOR INSERT TO scopehatch_app
  WITH CHECK (scopehatch.has_role(tenant_id,ARRAY['owner']));
CREATE POLICY catalog_read ON scopehatch.catalog_services FOR SELECT TO scopehatch_app
  USING (scopehatch.is_member(tenant_id));
CREATE POLICY catalog_create ON scopehatch.catalog_services FOR INSERT TO scopehatch_app
  WITH CHECK (scopehatch.has_role(tenant_id,ARRAY['owner']));

REVOKE ALL ON FUNCTION scopehatch.valid_proposal_metadata(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scopehatch.valid_proposal_metadata(jsonb) TO scopehatch_app;
COMMIT;
