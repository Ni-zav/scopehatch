/** Opt-in REAL PostgreSQL test: TEST_PG_ADMIN_URL must target a disposable migrated database. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {provisionTenant,ConflictError,InputError} from '../bootstrap.mjs';
import {manageIdentity} from '../identity.mjs';
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

test('disposable PG: issuer binding, independent member lifecycle, audit and rollback', {skip:!url||!process.env.TEST_PG_APP_URL}, async()=>{
  const {Client}=await import('pg');
  const admin=new Client({connectionString:url});
  const concurrent=new Client({connectionString:url});
  const runtime=new Client({connectionString:process.env.TEST_PG_APP_URL});
  await Promise.all([admin.connect(),concurrent.connect(),runtime.connect()]);
  const request={tenantId:'identity-'+randomUUID().replaceAll('-','').slice(0,18),workspaceName:'Synthetic Identity Studio',ownerSub:'external|'+randomUUID(),issuer:'https://login.acme.co/',expectedIssuer:'https://login.acme.co/',environment:'development',confirmEnvironment:'development',database:process.env.TEST_PG_DATABASE||'scopehatch_test',verified:true};
  const memberSub='external|'+randomUUID();
  const add={...request,command:'member add',memberSub,role:'reviewer'};
  const lookup=(issuer,sub=memberSub)=>runtime.query('SELECT * FROM scopehatch.lookup_verified_subject($1,$2)',[sub,issuer]);
  try {
    await provisionTenant(admin,request);
    assert.equal(await manageIdentity(admin,add,{dryRun:true}),'would-be-changed');
    assert.equal((await lookup(request.issuer)).rowCount,0);
    const outcomes=await Promise.all([manageIdentity(admin,add),manageIdentity(concurrent,add)]);
    assert.deepEqual(outcomes.sort(),['changed','unchanged']);
    assert.deepEqual((await lookup(request.issuer)).rows[0].roles,['reviewer']);
    assert.equal((await lookup('https://different.acme.co/')).rowCount,0);
    await assert.rejects(runtime.query('SELECT * FROM scopehatch.lookup_verified_subject($1)',[memberSub]),e=>e.code==='42501');
    await assert.rejects(runtime.query('SELECT * FROM scopehatch.tenant_identity_issuers'),e=>e.code==='42501');
    await assert.rejects(runtime.query("UPDATE scopehatch.memberships SET active=false WHERE tenant_id=$1",[request.tenantId]),e=>e.code==='42501');
    await assert.rejects(manageIdentity(runtime,add),InputError);
    await assert.rejects(manageIdentity(admin,{...add,role:'owner'}),InputError);
    await assert.rejects(manageIdentity(admin,{...add,role:'operator'}),ConflictError);
    await assert.rejects(manageIdentity(admin,{...add,memberSub:request.ownerSub}),InputError);
    await assert.rejects(manageIdentity(admin,{...add,tenantId:'missing-studio'}),ConflictError);
    await assert.rejects(manageIdentity(admin,{...add,ownerSub:'external|unknown-owner'}),ConflictError);
    await assert.rejects(manageIdentity(admin,{...add,issuer:'https://other.acme.co/',expectedIssuer:'https://other.acme.co/'}),ConflictError);
    const disable={...add,command:'member disable',role:undefined};
    assert.equal(await manageIdentity(admin,disable),'changed');
    assert.equal(await manageIdentity(admin,disable),'unchanged');
    assert.equal((await lookup(request.issuer)).rowCount,0);
    await assert.rejects(manageIdentity(admin,add),ConflictError);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM scopehatch.audit_events WHERE tenant_id=$1 AND action LIKE 'admin.%'",[request.tenantId])).rows[0].n,2);

    const rolledBackSub='external|'+randomUUID();
    const fault={query:(sql,params)=>sql.startsWith('INSERT INTO scopehatch.audit_events')?Promise.reject(new Error('private driver error')):admin.query(sql,params)};
    await assert.rejects(manageIdentity(fault,{...add,memberSub:rolledBackSub}),e=>e.exitCode===4&&!e.message.includes('private'));
    assert.equal((await admin.query('SELECT * FROM scopehatch.memberships WHERE tenant_id=$1 AND principal_id=$2',[request.tenantId,rolledBackSub])).rowCount,0);

    // Existing installations require deliberate verification; migration never guesses an issuer.
    await admin.query('DELETE FROM scopehatch.tenant_identity_issuers WHERE tenant_id=$1',[request.tenantId]);
    assert.equal((await lookup(request.issuer,request.ownerSub)).rowCount,0);
    const bind={...request,command:'tenant bind-issuer',membersVerified:true};
    await assert.rejects(manageIdentity(admin,{...bind,membersVerified:false}),InputError);
    assert.equal(await manageIdentity(admin,bind,{dryRun:true}),'would-be-changed');
    assert.equal((await lookup(request.issuer,request.ownerSub)).rowCount,0);
    assert.equal(await manageIdentity(admin,bind),'changed');
    assert.equal(await manageIdentity(admin,bind),'unchanged');
    assert.equal((await lookup(request.issuer,request.ownerSub)).rowCount,1);
    await assert.rejects(manageIdentity(admin,{...bind,issuer:'https://other.acme.co/',expectedIssuer:'https://other.acme.co/'}),ConflictError);

    const foreign={...request,tenantId:'foreign-'+randomUUID().replaceAll('-','').slice(0,18),issuer:'https://other.acme.co/',expectedIssuer:'https://other.acme.co/'};
    await provisionTenant(admin,foreign);
    assert.deepEqual((await lookup(request.issuer,request.ownerSub)).rows.map(m=>m.tenant_id),[request.tenantId]);
    assert.deepEqual((await lookup(foreign.issuer,request.ownerSub)).rows.map(m=>m.tenant_id),[foreign.tenantId]);
  } finally {await Promise.all([admin.end(),concurrent.end(),runtime.end()]);}
});
