import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { buildServer } from '../src/server.ts';
import { oidcVerifier } from '../src/auth.ts';
import { assertRestrictedPgPool, createPgPorts } from '../src/postgres.ts';
import { bindFixtureIssuer } from './identity-fixture.ts';
import { createInferenceGateway } from '../src/inference.ts';
// @ts-expect-error Independently packaged JS governance module.
import { GovernanceEngine } from '../../../packages/governance/src/index.mjs';
// @ts-expect-error Independently packaged JS PG adapter.
import { createPostgresGovernanceStorage } from '../../../packages/governance/pg-storage.mjs';

const adminUrl=process.env.TEST_PG_ADMIN_URL;
const appUrl=process.env.TEST_PG_APP_URL;

test('signed operator can obtain replay-safe, evidence-backed, governed fixture suggestions', {skip: !adminUrl||!appUrl}, async t=>{
  const admin=new Pool({connectionString:adminUrl}),pool=new Pool({connectionString:appUrl,max:8});
  t.after(async()=>{await pool.end();await admin.end()});
  await assertRestrictedPgPool(pool);
  // Budget and model eligibility are migration-owner configured, NOT supplied by the client.
  await admin.query(`INSERT INTO scopehatch.inference_accounts
    (tenant_id,currency,limit_minor) VALUES ('studio-a','IDR',100000)
    ON CONFLICT(tenant_id) DO UPDATE SET limit_minor=100000,held_minor=0,spent_minor=0`);
  await admin.query(`INSERT INTO scopehatch.inference_routes
    (tenant_id,provider_id,model,enabled,currency,residency,capabilities,context_window,
     input_per_million_minor,output_per_million_minor)
    VALUES ('studio-a','fixture','fixture-v1',true,'IDR','local',ARRAY['brief-extraction'],16384,0,0)
    ON CONFLICT(tenant_id,provider_id,model) DO UPDATE SET enabled=true`);
  const ports=createPgPorts(pool);
  const kp=await generateKeyPair('RS256');
  const jwk=await exportJWK(kp.publicKey);jwk.kid='gov-local';jwk.alg='RS256';
  const issuer='https://fixture.test-issuer.invalid/';
  await bindFixtureIssuer(issuer);
  const audience='scopehatch-api';
  const server=buildServer({...ports,
    verify:oidcVerifier({issuer,audience,localJwks:{keys:[jwk]}}),
    suggestions:createInferenceGateway(pool,ports.store)});
  await server.ready();t.after(()=>server.close());
  const token=async(sub:string)=>new SignJWT({roles:['owner'],tenantId:'studio-b'})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience(audience)
    .setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(kp.privateKey);
  const operator=await token('a-operator'), reviewer=await token('a-reviewer'),other=await token('b-operator');
  const call=async(method:'GET'|'POST',path:string,jwt:string,payload?:unknown,key?:string,workspace='studio-a')=>{
    const response=await server.inject({method,url:path,headers:{
      authorization:'Bearer '+jwt,'X-Workspace-Id':workspace,
      ...(key?{'Idempotency-Key':key}:{})
    },...(payload===undefined?{}:{payload})});
    return response;
  };
  const name='Governed '+randomUUID();
  const project=await call('POST','/v1/projects',operator,{title:name,brief:'Please deliver 2 images'},randomUUID());
  assert.equal(project.statusCode,201,project.body);
  const id=project.json().project.id as string;
  const route='/v1/projects/'+encodeURIComponent(id)+'/suggestions';
  const k=randomUUID();
  const first=await call('POST',route,operator,{},k);
  assert.equal(first.statusCode,200,first.body);
  const data=first.json();
  assert.equal(data.model,'fixture-v1');
  assert.equal(data.suggestion.suggestedDeliverables[0].quantity,2);
  assert.equal(data.suggestion.suggestedDeliverables[0].evidence.quote,'2 images');
  assert.equal(data.usage.status,'reported');
  const replay=await call('POST',route,operator,{},k);
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),data);
  const review=await call('POST',route,reviewer,{},randomUUID());
  assert.equal(review.statusCode,403);
  const cross=await call('POST',route,other,{},randomUUID(),'studio-b');
  assert.equal(cross.statusCode,404);
  const ledger=await admin.query('SELECT status,cost_minor::text AS cost,suggestion_result FROM scopehatch.inference_reservations WHERE tenant_id=$1 AND idempotency_key=$2',
    ['studio-a',await import('node:crypto').then(c=>c.createHash('sha256').update('a-operator:'+id+':'+k).digest('hex'))]);
  assert.equal(ledger.rows.length,1);
  assert.equal(ledger.rows[0].status,'settled');
  assert.equal(ledger.rows[0].cost,'0');
  assert.deepEqual(ledger.rows[0].suggestion_result,data);
});

test('two independent governance engines serialize reservations; unknown usage holds cost', {skip: !adminUrl||!appUrl}, async t=>{
  const admin=new Pool({connectionString:adminUrl}),pool=new Pool({connectionString:appUrl,max:8});
  t.after(async()=>{await pool.end();await admin.end()});
  const principal={tenantId:'studio-a',id:'a-operator',roles:['operator']};
  const storage=createPostgresGovernanceStorage(pool,principal);
  const routes={
    tenantId:'studio-a',providerId:'paid-test',model:'model-test',
    enabled:true,capabilities:['brief-extraction'],contextWindow:100000,
    residency:'local',currency:'IDR',
    price:{inputPerMillionMinor:'1000000',outputPerMillionMinor:'0'},priority:1
  };
  const policy={tenantId:'studio-a',currency:'IDR',allowedModels:[{providerId:'paid-test',model:'model-test'}]};
  const req={tenantId:'studio-a',idempotencyKey:randomUUID(),requestDigest:'e'.repeat(64),
    policy,candidates:[routes],capability:'brief-extraction',inputTokens:10000,outputTokens:10};
  const [a,b]=await Promise.all([
    new GovernanceEngine({storage}).reserve(req),new GovernanceEngine({storage}).reserve(req)
  ]);
  assert.equal(a.id,b.id);
  assert.notEqual(a.replay,b.replay);
  let account=(await admin.query("SELECT held_minor::text AS held FROM scopehatch.inference_accounts WHERE tenant_id='studio-a'")).rows[0];
  assert.equal(account.held,'10000');
  const engine=new GovernanceEngine({storage});
  await engine.markDispatched({tenantId:'studio-a',reservationId:a.id});
  await engine.settle({tenantId:'studio-a',reservationId:a.id,eventId:randomUUID(),usage:{status:'unknown'}});
  account=(await admin.query("SELECT held_minor::text AS held,spent_minor::text AS spent FROM scopehatch.inference_accounts WHERE tenant_id='studio-a'")).rows[0];
  assert.equal(account.held,'10000');
  assert.equal(account.spent,'0');
  await engine.reconcile({tenantId:'studio-a',reservationId:a.id,eventId:randomUUID(),
    billedCostMinor:'2500',evidenceRef:'invoice-local-1'});
  account=(await admin.query("SELECT held_minor::text AS held,spent_minor::text AS spent FROM scopehatch.inference_accounts WHERE tenant_id='studio-a'")).rows[0];
  assert.equal(account.held,'0');
  assert.equal(account.spent,'2500');
  await assert.rejects(()=>createPostgresGovernanceStorage(pool,{...principal,tenantId:'studio-b'})
    .withTenantTransaction('studio-a',async()=>true),{code:'FORBIDDEN'});
});
