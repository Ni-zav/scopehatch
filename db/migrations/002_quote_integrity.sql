-- Hardening: an UPDATE/INSERT outside the repository must not fabricate
-- a ready price, and a revised intake invalidates all old quote approvals.
BEGIN;
CREATE OR REPLACE FUNCTION scopehatch.assert_current_quote(
  p_tenant text, p_project text, p_scope integer, p_catalog integer,
  p_estimate integer
) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE q_state text;
DECLARE bound_intake integer;
BEGIN
  PERFORM 1 FROM scopehatch.tenants WHERE id = p_tenant FOR UPDATE;
  PERFORM 1 FROM scopehatch.projects
    WHERE tenant_id = p_tenant AND id = p_project FOR UPDATE;
  SELECT intake_revision INTO bound_intake FROM scopehatch.scope_revisions
  WHERE tenant_id = p_tenant AND project_id = p_project AND revision = p_scope;
  IF p_scope IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.scope_revisions
      WHERE tenant_id = p_tenant AND project_id = p_project
    ) OR bound_intake IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.intakes
      WHERE tenant_id = p_tenant AND project_id = p_project
    ) OR p_catalog IS DISTINCT FROM (
      SELECT max(version) FROM scopehatch.catalog_versions
      WHERE tenant_id = p_tenant
    ) OR p_estimate IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.estimate_revisions
      WHERE tenant_id = p_tenant AND project_id = p_project
    ) THEN
    RAISE EXCEPTION 'stale quote or intake' USING ERRCODE = '23514';
  END IF;
  SELECT state INTO q_state FROM scopehatch.estimate_revisions
  WHERE tenant_id = p_tenant AND project_id = p_project
    AND revision = p_estimate AND scope_revision = p_scope
    AND catalog_version = p_catalog;
  IF q_state IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'quote is not ready' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION scopehatch.guard_estimate_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE previous integer;
DECLARE catalog_currency text;
DECLARE bound_intake integer;
DECLARE scope_unknowns jsonb;
DECLARE computed_total numeric;
DECLARE expected_lines jsonb;
DECLARE invalid_lines integer;
DECLARE num_lines integer;
BEGIN
  IF NEW.created_by IS DISTINCT FROM scopehatch.actor_id() THEN
    RAISE EXCEPTION 'principal mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM scopehatch.tenants WHERE id = NEW.tenant_id FOR UPDATE;
  PERFORM 1 FROM scopehatch.projects
    WHERE tenant_id = NEW.tenant_id AND id = NEW.project_id FOR UPDATE;
  SELECT coalesce(max(revision), 0) INTO previous FROM scopehatch.estimate_revisions
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id;
  SELECT currency INTO catalog_currency FROM scopehatch.catalog_versions
    WHERE tenant_id = NEW.tenant_id AND version = NEW.catalog_version;
  SELECT intake_revision, unknowns INTO bound_intake, scope_unknowns
  FROM scopehatch.scope_revisions
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
      AND revision = NEW.scope_revision;
  IF NEW.revision <> previous + 1
    OR NEW.scope_revision IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.scope_revisions
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
    ) OR bound_intake IS DISTINCT FROM (
      SELECT max(revision) FROM scopehatch.intakes
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
    ) OR NEW.catalog_version IS DISTINCT FROM (
      SELECT max(version) FROM scopehatch.catalog_versions
      WHERE tenant_id = NEW.tenant_id
    ) OR NEW.currency IS DISTINCT FROM catalog_currency
  THEN RAISE EXCEPTION 'stale estimate, intake or currency mismatch' USING ERRCODE = '23514';
  END IF;

  -- The only approvable state is ready, so ready estimates MUST match an
  -- independently calculated price from persisted, tenant-bound scope/rates.
  -- Numeric arithmetic prevents BIGINT overflow before the safe-int check.
  SELECT count(*)::int,
    count(*) FILTER (WHERE d.quantity IS NULL OR c.service_id IS NULL
      OR (d.source = 'brief' AND length(trim(d.evidence)) = 0))::int,
    coalesce(sum(c.unit_price_minor::numeric * d.quantity::numeric), 0),
    coalesce(jsonb_agg(
      jsonb_build_object(
        'serviceId', d.service_id, 'quantity', d.quantity,
        'unitPriceMinor', c.unit_price_minor,
        'subtotalMinor', c.unit_price_minor::numeric * d.quantity::numeric,
        'evidence', d.evidence, 'source', d.source
      ) ORDER BY d.line_no
    ), '[]'::jsonb)
  INTO num_lines, invalid_lines, computed_total, expected_lines
  FROM scopehatch.scope_deliverables d
  LEFT JOIN scopehatch.catalog_services c
    ON c.tenant_id = d.tenant_id AND c.catalog_version = NEW.catalog_version
   AND c.service_id = d.service_id
  WHERE d.tenant_id = NEW.tenant_id AND d.project_id = NEW.project_id
    AND d.scope_revision = NEW.scope_revision;

  IF NEW.state = 'ready' THEN
    IF scope_unknowns <> '[]'::jsonb OR num_lines = 0 OR invalid_lines <> 0
      OR computed_total > 9007199254740991::numeric
      OR NEW.total_minor::numeric IS DISTINCT FROM computed_total
      OR NEW.lines IS DISTINCT FROM expected_lines
    THEN RAISE EXCEPTION 'ready quote does not match persisted catalog and scope'
      USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
