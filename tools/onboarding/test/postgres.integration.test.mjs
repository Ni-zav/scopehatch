/** Opt-in REAL PostgreSQL test: TEST_PG_ADMIN_URL must target a disposable migrated database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {provisionTenant,ConflictError,InputError} from '../bootstrap.mjs';
const url=process.env.TEST_PG_ADMIN_URL;
test('disposable PG: atomic bootstrap, concurrent idempotency, conflict and restricted-role refusal', {skip:!url && 'requires TEST_PG_ADMIN_URL pointing to disposable PostgreSQL with migrations'}, async()=>{
  const {Client}=await import('pg');
  const first=new Client({connectionString:url});const second=new Client({connectionString:url});
  await first.connect(); await second.connect();
  const tenantId='test-boot-'+randomUUID().replaceAll('-','').slice(0,18);
  const request={tenantId,workspaceName:'Disposable Test Studio',ownerSub:'external|'+randomUUID(),issuer:'https://login.acme.co/',expectedIssuer:'https://login.acme.co/',environment:'development',confirmEnvironment:'development',database:process.env.TEST_PG_DATABASE||'scopehatch_test',verified:true};
  try {
    const outcomes=await Promise.all([provisionTenant(first,request),provisionTenant(second,request)]);
    assert.deepEqual(outcomes.sort(),['created','unchanged']);
    const t=await first.query('SELECT id,name FROM scopehatch.tenants WHERE id=$1',[tenantId]);
    const m=await first.query('SELECT principal_id,roles,active FROM scopehatch.memberships WHERE tenant_id=$1',[tenantId]);
    assert.equal(t.rows.length,1);assert.equal(m.rows.length,1);assert.equal(m.rows[0].principal_id,request.ownerSub);assert.deepEqual(m.rows[0].roles,['owner']);assert.equal(m.rows[0].active,true);
    await assert.rejects(provisionTenant(first,{...request,ownerSub:'external|'+randomUUID()}),ConflictError);
    assert.equal((await first.query('SELECT count(*)::int AS total FROM scopehatch.memberships WHERE tenant_id=$1',[tenantId])).rows[0].total,1);
    assert.equal(await provisionTenant(first,request,{dryRun:true}),'would-be-unchanged');
    if(process.env.TEST_PG_APP_URL) {
      const restricted=new Client({connectionString:process.env.TEST_PG_APP_URL});await restricted.connect();
      try {await assert.rejects(provisionTenant(restricted,request),InputError);}finally{await restricted.end();}
    }
  } finally {await Promise.all([first.end(),second.end()]);}
});
