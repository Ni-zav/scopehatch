-- Durable governed inference accounts and accounting snapshots.
-- Separate migration owner provisions budget limits and model-route allowlists.
BEGIN;
CREATE TABLE IF NOT EXISTS scopehatch.inference_accounts (
  tenant_id text PRIMARY KEY REFERENCES scopehatch.tenants(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  limit_minor numeric(30,0) NOT NULL CHECK (limit_minor >= 0),
  held_minor numeric(30,0) NOT NULL DEFAULT 0 CHECK (held_minor >= 0),
  spent_minor numeric(30,0) NOT NULL DEFAULT 0 CHECK (spent_minor >= 0)
);
CREATE TABLE IF NOT EXISTS scopehatch.inference_routes (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id),
  provider_id text NOT NULL,
  model text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  residency text NOT NULL,
  capabilities text[] NOT NULL,
  context_window integer NOT NULL CHECK (context_window BETWEEN 1 AND 1000000000),
  input_per_million_minor numeric(30,0) NOT NULL CHECK (input_per_million_minor >= 0),
  output_per_million_minor numeric(30,0) NOT NULL CHECK (output_per_million_minor >= 0),
  priority integer NOT NULL DEFAULT 0,
  timeout_ms integer NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1 AND 120000),
  PRIMARY KEY (tenant_id, provider_id, model),
  CHECK (length(provider_id) BETWEEN 1 AND 64),
  CHECK (length(model) BETWEEN 1 AND 200)
);
CREATE TABLE IF NOT EXISTS scopehatch.inference_reservations (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id),
  id text NOT NULL,
  idempotency_key text NOT NULL,
  intent text NOT NULL CHECK (intent ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('reserved','dispatched','unknown','settled','released')),
  provider_id text NOT NULL,
  model text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price jsonb NOT NULL CHECK (jsonb_typeof(price)='object'),
  reserved_minor numeric(30,0) NOT NULL CHECK (reserved_minor>=0),
  cost_minor numeric(30,0) CHECK (cost_minor>=0),
  usage jsonb NOT NULL CHECK (jsonb_typeof(usage)='object'),
  dispatched boolean NOT NULL,
  created_at bigint NOT NULL,
  suggestion_result jsonb,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS scopehatch.inference_events (
  tenant_id text NOT NULL,
  id text NOT NULL,
  reservation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('release','settle','reconcile')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,reservation_id)
    REFERENCES scopehatch.inference_reservations(tenant_id,id)
);
ALTER TABLE scopehatch.inference_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.inference_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inference_accounts_scoped ON scopehatch.inference_accounts;
CREATE POLICY inference_accounts_scoped ON scopehatch.inference_accounts TO scopehatch_app
  USING (scopehatch.has_role(tenant_id, ARRAY['owner','operator']))
  WITH CHECK (scopehatch.has_role(tenant_id, ARRAY['owner','operator']));
DROP POLICY IF EXISTS inference_routes_scoped ON scopehatch.inference_routes;
CREATE POLICY inference_routes_scoped ON scopehatch.inference_routes TO scopehatch_app
  USING (scopehatch.has_role(tenant_id, ARRAY['owner','operator']));
DROP POLICY IF EXISTS inference_reservations_scoped ON scopehatch.inference_reservations;
CREATE POLICY inference_reservations_scoped ON scopehatch.inference_reservations TO scopehatch_app
  USING (scopehatch.has_role(tenant_id, ARRAY['owner','operator']))
  WITH CHECK (scopehatch.has_role(tenant_id, ARRAY['owner','operator']));
DROP POLICY IF EXISTS inference_events_scoped ON scopehatch.inference_events;
CREATE POLICY inference_events_scoped ON scopehatch.inference_events TO scopehatch_app
  USING (scopehatch.has_role(tenant_id, ARRAY['owner','operator']))
  WITH CHECK (scopehatch.has_role(tenant_id, ARRAY['owner','operator']));
REVOKE ALL ON scopehatch.inference_accounts,scopehatch.inference_routes,
  scopehatch.inference_reservations,scopehatch.inference_events FROM PUBLIC;
GRANT SELECT,UPDATE(held_minor,spent_minor) ON scopehatch.inference_accounts TO scopehatch_app;
GRANT SELECT ON scopehatch.inference_routes TO scopehatch_app;
GRANT SELECT,INSERT,UPDATE(suggestion_result,status,usage,cost_minor,dispatched)
  ON scopehatch.inference_reservations TO scopehatch_app;
GRANT SELECT,INSERT ON scopehatch.inference_events TO scopehatch_app;
COMMIT;
