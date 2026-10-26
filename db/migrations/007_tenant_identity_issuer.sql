-- Existing tenants stay unbound until the trusted operator verifies their members.
BEGIN;
CREATE TABLE IF NOT EXISTS scopehatch.tenant_identity_issuers (
  tenant_id text PRIMARY KEY REFERENCES scopehatch.tenants(id),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  bound_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE scopehatch.tenant_identity_issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.tenant_identity_issuers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON scopehatch.tenant_identity_issuers FROM PUBLIC, scopehatch_app;

CREATE OR REPLACE FUNCTION scopehatch.lookup_verified_subject(p_subject text, p_issuer text)
RETURNS TABLE(tenant_id text, principal_id text, roles text[], active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,scopehatch
AS $$
  SELECT m.tenant_id,m.principal_id,m.roles,m.active
    FROM scopehatch.memberships m
    JOIN scopehatch.tenant_identity_issuers i ON i.tenant_id=m.tenant_id
   WHERE m.principal_id=p_subject AND i.issuer=p_issuer AND m.active=true
$$;
REVOKE ALL ON FUNCTION scopehatch.lookup_verified_subject(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scopehatch.lookup_verified_subject(text,text) TO scopehatch_app;
REVOKE ALL ON FUNCTION scopehatch.lookup_verified_subject(text) FROM scopehatch_app;
COMMIT;
