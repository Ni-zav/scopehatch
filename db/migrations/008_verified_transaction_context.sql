-- Application attestations bind identity to one backend and one transaction.
BEGIN;
CREATE SCHEMA IF NOT EXISTS scopehatch_private;
REVOKE ALL ON SCHEMA scopehatch_private FROM PUBLIC, scopehatch_app;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS scopehatch_private.context_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key bytea NOT NULL CHECK (octet_length(key) = 32)
);
ALTER TABLE scopehatch_private.context_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch_private.context_key FORCE ROW LEVEL SECURITY;
REVOKE ALL ON scopehatch_private.context_key FROM PUBLIC, scopehatch_app;

-- Resolve the extension's actual namespace once, never a caller's search_path.
DO $install$
DECLARE crypto_schema text;
BEGIN
  SELECT n.nspname INTO STRICT crypto_schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
  EXECUTE format($function$
    CREATE OR REPLACE FUNCTION scopehatch_private.context_mac(payload text)
    RETURNS bytea LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
    AS 'SELECT %I.hmac(convert_to(''scopehatch/context/v1:'' || payload, ''UTF8''), key, ''sha256'')
        FROM scopehatch_private.context_key WHERE singleton'
  $function$, crypto_schema);
END $install$;
REVOKE ALL ON FUNCTION scopehatch_private.context_mac(text) FROM PUBLIC, scopehatch_app;

CREATE OR REPLACE FUNCTION scopehatch.verified_context() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $verify$
DECLARE
  payload text := current_setting('scopehatch.identity', true);
  supplied text := current_setting('scopehatch.identity_mac', true);
  expected bytea;
  actual bytea;
  difference integer := 0;
  claims jsonb;
BEGIN
  IF payload IS NULL OR octet_length(payload) > 4096 OR
     supplied IS NULL OR supplied !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  expected := scopehatch_private.context_mac(payload);
  IF expected IS NULL THEN RETURN NULL; END IF;
  actual := decode(supplied, 'hex');
  -- Compare every byte, with no early exit on a matching prefix.
  FOR i IN 0..31 LOOP
    difference := difference | (get_byte(expected,i) # get_byte(actual,i));
  END LOOP;
  IF difference <> 0 THEN RETURN NULL; END IF;
  claims := payload::jsonb;
  IF claims->>'v' IS DISTINCT FROM '1' OR
     claims->>'tx' IS DISTINCT FROM pg_current_xact_id()::text OR
     claims->>'pid' IS DISTINCT FROM pg_backend_pid()::text OR
     claims->>'db' IS DISTINCT FROM current_database() OR
     claims->>'login' IS DISTINCT FROM session_user::text OR
     claims->>'start' IS DISTINCT FROM extract(epoch FROM pg_postmaster_start_time())::text OR
     claims->>'kind' IS NULL OR claims->>'kind' NOT IN ('transaction','membership') THEN
    RETURN NULL;
  END IF;
  IF claims->>'kind' = 'transaction' AND
    (coalesce(claims->>'tenant','') = '' OR coalesce(claims->>'actor','') = '') THEN RETURN NULL; END IF;
  IF claims->>'kind' = 'membership' AND
    (coalesce(claims->>'subject','') = '' OR coalesce(claims->>'issuer','') = '') THEN RETURN NULL; END IF;
  RETURN claims;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $verify$;
REVOKE ALL ON FUNCTION scopehatch.verified_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scopehatch.verified_context() TO scopehatch_app;
CREATE OR REPLACE FUNCTION scopehatch.tenant_id() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT scopehatch.verified_context()->>'tenant' $$;
CREATE OR REPLACE FUNCTION scopehatch.actor_id() RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog
AS $$ SELECT scopehatch.verified_context()->>'actor' $$;

-- Membership discovery also requires proof of the verified OIDC identity.
CREATE OR REPLACE FUNCTION scopehatch.lookup_verified_subject(p_subject text, p_issuer text)
RETURNS TABLE(tenant_id text, principal_id text, roles text[], active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT m.tenant_id,m.principal_id,m.roles,m.active
  FROM scopehatch.memberships m
  JOIN scopehatch.tenant_identity_issuers i ON i.tenant_id=m.tenant_id
  WHERE m.principal_id=p_subject AND i.issuer=p_issuer AND m.active
    AND scopehatch.verified_context()->>'kind' = 'membership'
    AND scopehatch.verified_context()->>'subject' = p_subject
    AND scopehatch.verified_context()->>'issuer' = p_issuer
$$;
REVOKE ALL ON FUNCTION scopehatch.lookup_verified_subject(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scopehatch.lookup_verified_subject(text,text) TO scopehatch_app;

-- Protected host administration and disposable SQL fixtures only. NOT a runtime oracle.
CREATE OR REPLACE FUNCTION scopehatch.admin_bind_context(tenant text, actor text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $admin$
DECLARE payload text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scopehatch.memberships
    WHERE tenant_id=tenant AND principal_id=actor AND active) THEN
    RAISE EXCEPTION 'Active administrative subject required' USING ERRCODE='42501';
  END IF;
  payload := jsonb_build_object('v',1,'kind','transaction','tenant',tenant,'actor',actor,
    'tx',pg_current_xact_id()::text,'pid',pg_backend_pid()::text,
    'db',current_database(),'login',session_user::text,
    'start',extract(epoch FROM pg_postmaster_start_time())::text)::text;
  PERFORM set_config('scopehatch.identity',payload,true);
  PERFORM set_config('scopehatch.identity_mac',encode(scopehatch_private.context_mac(payload),'hex'),true);
END $admin$;
REVOKE ALL ON FUNCTION scopehatch.admin_bind_context(text,text) FROM PUBLIC, scopehatch_app;
COMMIT;
