-- Synthetic fixture policy only. Run against a throwaway development database
-- with the privileged provisioning role; never as a runtime application role.
-- Fixture numbers are deterministic and do NOT represent paid model metering.
BEGIN;
INSERT INTO scopehatch.inference_accounts(tenant_id,currency,limit_minor)
VALUES ('studio-a','IDR',100000), ('studio-b','USD',10000)
ON CONFLICT(tenant_id) DO NOTHING;
INSERT INTO scopehatch.inference_routes
 (tenant_id,provider_id,model,enabled,currency,residency,capabilities,
  context_window,input_per_million_minor,output_per_million_minor,priority,timeout_ms)
VALUES
 ('studio-a','fixture','fixture-v1',true,'IDR','local',
  ARRAY['brief-extraction'],16384,0,0,0,15000),
 ('studio-b','fixture','fixture-v1',true,'USD','local',
  ARRAY['brief-extraction'],16384,0,0,0,15000)
ON CONFLICT(tenant_id,provider_id,model) DO NOTHING;
COMMIT;
