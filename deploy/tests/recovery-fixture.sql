-- Synthetic restore-rehearsal data only; NEVER run against a customer database.
-- Requires freshly migrated, disposable PostgreSQL and the checked-in demo seeds.
BEGIN;
SELECT set_config('scopehatch.tenant_id','studio-a',true);
SELECT set_config('scopehatch.actor_id','a-reviewer',true);
UPDATE scopehatch.reviews SET state='approved', approved_by='a-reviewer', approved_at=now()
WHERE tenant_id='studio-a' AND project_id='a-demo' AND id='a-review' AND state='pending';
INSERT INTO scopehatch.audit_events
  (tenant_id,id,project_id,actor_id,action,object_revision,request_id,outcome,metadata)
VALUES ('studio-a','rehearsal-approval','a-demo','a-reviewer','proposal.approved',1,
  'rehearsal-approved','succeeded','{"synthetic":true}'::jsonb);

SELECT set_config('scopehatch.tenant_id','studio-b',true);
SELECT set_config('scopehatch.actor_id','b-operator',true);
INSERT INTO scopehatch.scope_revisions
  (tenant_id,project_id,revision,intake_revision,author_id,unknowns,line_count)
VALUES ('studio-b','b-demo',2,1,'b-operator','[]'::jsonb,1);
INSERT INTO scopehatch.scope_deliverables
  (tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source)
VALUES ('studio-b','b-demo',2,0,'render',2,'synthetic revised scope','manual');

-- Unsettled, dispatched provider usage must remain unknown with its hold intact.
UPDATE scopehatch.inference_accounts SET held_minor=1200 WHERE tenant_id='studio-a';
INSERT INTO scopehatch.inference_reservations
  (tenant_id,id,idempotency_key,intent,status,provider_id,model,currency,
   price,reserved_minor,cost_minor,usage,dispatched,created_at)
VALUES ('studio-a','rehearsal-outstanding','rehearsal-key',repeat('f',64),'unknown',
  'fixture','fixture-v1','IDR','{}'::jsonb,1200,NULL,
  '{"inputTokens":null,"outputTokens":null,"status":"unknown"}'::jsonb,true,1700000000);
COMMIT;
