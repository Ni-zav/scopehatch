-- Synthetic, reproducible tenants. No customer assets or proprietary rates.
-- Run on a dedicated DEMO database as a privileged provisioning/migration role
-- (BYPASSRLS or superuser), NOT with the restricted API role.
BEGIN;
INSERT INTO scopehatch.tenants(id,name) VALUES
 ('studio-a','Studio A (synthetic)'), ('studio-b','Studio B (synthetic)')
ON CONFLICT (id) DO NOTHING;
INSERT INTO scopehatch.memberships(tenant_id,principal_id,roles) VALUES
 ('studio-a','a-operator',ARRAY['owner','operator']),
 ('studio-a','a-reviewer',ARRAY['reviewer']),
 ('studio-b','b-operator',ARRAY['owner','operator']),
 ('studio-b','b-reviewer',ARRAY['reviewer'])
ON CONFLICT (tenant_id,principal_id) DO NOTHING;

SELECT set_config('scopehatch.tenant_id','studio-a',true);
SELECT set_config('scopehatch.actor_id','a-operator',true);
DO $seed$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM scopehatch.catalog_versions
   WHERE tenant_id='studio-a' AND version=1) THEN
   INSERT INTO scopehatch.catalog_versions(tenant_id,version,currency,created_by)
   VALUES ('studio-a',1,'IDR','a-operator');
   INSERT INTO scopehatch.catalog_services(tenant_id,catalog_version,service_id,label,unit_price_minor)
   VALUES ('studio-a',1,'render','Synthetic rendering',200000),
          ('studio-a',1,'revision','Synthetic revision round',50000);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM scopehatch.projects
   WHERE tenant_id='studio-a' AND id='a-demo') THEN
   INSERT INTO scopehatch.projects(tenant_id,id,title,created_by)
   VALUES ('studio-a','a-demo','Studio A demo','a-operator');
   INSERT INTO scopehatch.intakes(tenant_id,project_id,revision,brief,author_id)
   VALUES ('studio-a','a-demo',1,'Studio A confidential synthetic brief: two images','a-operator');
   INSERT INTO scopehatch.scope_revisions
     (tenant_id,project_id,revision,intake_revision,author_id,unknowns)
   VALUES ('studio-a','a-demo',1,1,'a-operator','[]');
   INSERT INTO scopehatch.scope_deliverables
     (tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source)
   VALUES ('studio-a','a-demo',1,0,'render',2,'two images','brief');
   INSERT INTO scopehatch.estimate_revisions
     (tenant_id,project_id,revision,scope_revision,catalog_version,
      created_by,currency,state,total_minor,lines,blockers)
   VALUES ('studio-a','a-demo',1,1,1,'a-operator','IDR','ready',400000,
     '[{"serviceId":"render","quantity":2,"unitPriceMinor":200000,"subtotalMinor":400000,"evidence":"two images","source":"brief"}]'::jsonb,'[]'::jsonb);
   INSERT INTO scopehatch.reviews
     (tenant_id,project_id,id,estimate_revision,scope_revision,catalog_version,submitted_by)
   VALUES ('studio-a','a-demo','a-review',1,1,1,'a-operator');
 END IF;
END $seed$;

SELECT set_config('scopehatch.tenant_id','studio-b',true);
SELECT set_config('scopehatch.actor_id','b-operator',true);
DO $seed$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM scopehatch.catalog_versions
   WHERE tenant_id='studio-b' AND version=1) THEN
   INSERT INTO scopehatch.catalog_versions(tenant_id,version,currency,created_by)
   VALUES ('studio-b',1,'USD','b-operator');
   INSERT INTO scopehatch.catalog_services(tenant_id,catalog_version,service_id,label,unit_price_minor)
   VALUES ('studio-b',1,'render','Synthetic rendering',30000);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM scopehatch.projects
   WHERE tenant_id='studio-b' AND id='b-demo') THEN
   INSERT INTO scopehatch.projects(tenant_id,id,title,created_by)
   VALUES ('studio-b','b-demo','Studio B demo','b-operator');
   INSERT INTO scopehatch.intakes(tenant_id,project_id,revision,brief,author_id)
   VALUES ('studio-b','b-demo',1,'Studio B confidential synthetic brief: one image','b-operator');
   INSERT INTO scopehatch.scope_revisions
     (tenant_id,project_id,revision,intake_revision,author_id,unknowns)
   VALUES ('studio-b','b-demo',1,1,'b-operator','[]');
   INSERT INTO scopehatch.scope_deliverables
     (tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source)
   VALUES ('studio-b','b-demo',1,0,'render',1,'one image','brief');
   INSERT INTO scopehatch.estimate_revisions
     (tenant_id,project_id,revision,scope_revision,catalog_version,
      created_by,currency,state,total_minor,lines,blockers)
   VALUES ('studio-b','b-demo',1,1,1,'b-operator','USD','ready',30000,
     '[{"serviceId":"render","quantity":1,"unitPriceMinor":30000,"subtotalMinor":30000,"evidence":"one image","source":"brief"}]'::jsonb,'[]'::jsonb);
 END IF;
END $seed$;
COMMIT;
