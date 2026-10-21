-- Fixed-scope identity lookup for a signature/issuer/audience-verified JWT subject.
-- The API must not treat a caller-provided subject, tenant, or role as authority.
BEGIN;
CREATE OR REPLACE FUNCTION scopehatch.lookup_verified_subject(p_subject text)
RETURNS TABLE(tenant_id text, principal_id text, roles text[], active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,scopehatch
AS $$
  SELECT m.tenant_id,m.principal_id,m.roles,m.active
    FROM scopehatch.memberships m
   WHERE m.principal_id = p_subject AND m.active = true
$$;
REVOKE ALL ON FUNCTION scopehatch.lookup_verified_subject(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scopehatch.lookup_verified_subject(text) TO scopehatch_app;
COMMIT;
