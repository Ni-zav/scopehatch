import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createContextBinder } from '../identity-context.mjs';
import { createPersistence } from '../index.mjs';

const enabled = Boolean(process.env.TEST_PG_ADMIN_URL && process.env.TEST_PG_APP_URL);
const a = { tenantId:'boundary-a-'+randomUUID(), id:'a-operator' };
const b = { tenantId:'boundary-b-'+randomUUID(), id:'b-operator' };
const issuer = 'https://'+randomUUID()+'.boundary.fixture.invalid/';

test('arbitrary runtime SQL cannot select another identity, forge authority or replay attestations', {skip:!enabled}, async t => {
  const app = new Pool({connectionString:process.env.TEST_PG_APP_URL,max:2});
  const admin = new Pool({connectionString:process.env.TEST_PG_ADMIN_URL,max:1});
  const bind = createContextBinder();
  const lookup = createContextBinder('membership');
  const c = await app.connect();
  const other = await app.connect();
  let released = false;
  const context = async client => (await client.query("SELECT current_setting('scopehatch.identity') AS payload,current_setting('scopehatch.identity_mac') AS mac")).rows[0];
  const install = (client, value, local=true) => client.query("SELECT set_config('scopehatch.identity',$1,$3),set_config('scopehatch.identity_mac',$2,$3)",[value.payload,value.mac,local]);
  const count = async (client,tenant) => (await client.query('SELECT count(*)::int AS n FROM scopehatch.projects WHERE tenant_id=$1',[tenant])).rows[0].n;
  try {
    const seed = (await readFile(new URL('../../../db/seeds/001_studios.sql',import.meta.url),'utf8'))
      .replaceAll('studio-a',a.tenantId).replaceAll('studio-b',b.tenantId);
    await admin.query(seed);
    await admin.query('INSERT INTO scopehatch.tenant_identity_issuers(tenant_id,issuer) VALUES ($1,$3),($2,$3)',[a.tenantId,b.tenantId,issuer]);
    await t.test('legacy tenant/actor GUCs and unsigned membership lookup grant nothing', async () => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('scopehatch.tenant_id',$1,true),set_config('scopehatch.actor_id',$2,true)",[b.tenantId,b.id]);
      assert.equal(await count(c,b.tenantId),0);
      assert.equal((await c.query('SELECT * FROM scopehatch.lookup_verified_subject($1,$2)',[b.id,issuer])).rowCount,0);
      await c.query('ROLLBACK');
    });
    await t.test('same-tenant reviewer substitution and cross-tenant substitution fail closed', async () => {
      await c.query('BEGIN');
      await bind(c,a);
      const original = await context(c);
      assert.equal(await count(c,a.tenantId),1);
      await c.query("SELECT set_config('scopehatch.tenant_id',$1,true),set_config('scopehatch.actor_id','b-reviewer',true)",[b.tenantId]);
      assert.equal(await count(c,b.tenantId),0);
      assert.equal((await c.query('SELECT scopehatch.actor_id() AS actor')).rows[0].actor,a.id);
      for (const forged of [{tenant:b.tenantId,actor:b.id},{tenant:a.tenantId,actor:'a-reviewer'}]) {
        const payload=JSON.stringify({...JSON.parse(original.payload),...forged});
        await install(c,{payload,mac:original.mac});
        assert.equal(await count(c,forged.tenant),0);
        assert.equal((await c.query("UPDATE scopehatch.reviews SET state='approved',approved_by='a-reviewer',approved_at=now() WHERE tenant_id=$1 AND id='a-review'",[a.tenantId])).rowCount,0);
      }
      await install(c,original);
      await c.query('SAVEPOINT denied_self_approval');
      await assert.rejects(c.query("UPDATE scopehatch.reviews SET state='approved',approved_by='a-reviewer',approved_at=now() WHERE tenant_id=$1 AND id='a-review'",[a.tenantId]),e=>['42501','23514'].includes(e.code));
      await c.query('ROLLBACK TO SAVEPOINT denied_self_approval');
      await c.query('ROLLBACK');
    });
    await t.test('SQL login cannot read the key, sign arbitrary identities, replace helpers or elevate role', async () => {
      for (const sql of [
        'SELECT key FROM scopehatch_private.context_key',
        "SELECT scopehatch_private.context_mac('forged')",
        "SELECT scopehatch.admin_bind_context('studio-b','b-reviewer')",
        "CREATE OR REPLACE FUNCTION scopehatch.actor_id() RETURNS text LANGUAGE sql AS 'SELECT ''b-reviewer''::text'",
        'SET ROLE postgres',
        'SET SESSION AUTHORIZATION postgres',
        'GRANT postgres TO scopehatch_runtime'
      ]) {
        await c.query('BEGIN');
        await assert.rejects(c.query(sql),e=>e.code==='42501');
        await c.query('ROLLBACK');
      }
    });
    await t.test('valid signature from another backend or transaction cannot be replayed', async () => {
      await c.query('BEGIN'); await bind(c,a);
      const old = await context(c);
      await other.query('BEGIN'); await bind(other,b);
      const foreign = await context(other);
      assert.equal(await count(other,b.tenantId),1);
      await install(c,foreign);
      assert.equal(await count(c,b.tenantId),0);
      await other.query('ROLLBACK');
      await install(c,old,false); // Simulate malicious session-level persistence into the pool.
      await c.query('COMMIT');
      await c.query('BEGIN');
      assert.equal(await count(c,a.tenantId),0);
      await install(c,old);
      assert.equal(await count(c,a.tenantId),0);
      await c.query('ROLLBACK');
      await c.query('RESET scopehatch.identity');
      await c.query('RESET scopehatch.identity_mac');
    });
    await t.test('membership discovery is bound to verified subject and issuer, with no row authority', async () => {
      await c.query('BEGIN');
      await lookup(c,{subject:a.id,issuer});
      assert.equal((await c.query('SELECT * FROM scopehatch.lookup_verified_subject($1,$2)',[a.id,issuer])).rowCount,1);
      assert.equal((await c.query('SELECT * FROM scopehatch.lookup_verified_subject($1,$2)',[b.id,issuer])).rowCount,0);
      assert.equal((await c.query('SELECT * FROM scopehatch.lookup_verified_subject($1,$2)',[a.id,issuer+'wrong'])).rowCount,0);
      assert.equal(await count(c,a.tenantId),0);
      await c.query('ROLLBACK');
    });
    await t.test('savepoints, SET ROLE and pooled failures cannot transfer context', async () => {
      await c.query('BEGIN'); await bind(c,a);
      await c.query('SET LOCAL ROLE scopehatch_app');
      await c.query('SAVEPOINT injection');
      await c.query("SELECT set_config('scopehatch.identity','{}',true)");
      assert.equal(await count(c,b.tenantId),0);
      await c.query('ROLLBACK TO SAVEPOINT injection');
      assert.equal(await count(c,a.tenantId),1);
      assert.equal(await count(c,b.tenantId),0);
      await c.query('ROLLBACK');
      const store=createPersistence(app);
      // Release both checked-out clients before using the deliberately small pool.
      c.release(); other.release(); released = true;
      await assert.rejects(store.withPrincipal(a,async()=>{throw new Error('synthetic rollback');}));
      assert.equal((await app.query('SELECT scopehatch.verified_context() IS NULL AS clear')).rows[0].clear,true);
      const catalogs=await store.withPrincipal(b,repo=>repo.listCatalogs());
      assert.ok(catalogs.every(x=>x.tenantId===b.tenantId));
    });
  } finally {
    // May already be released by the pool-reuse subtest.
    if (!released) { try { await c.query('ROLLBACK'); c.release(); } catch {} }
    if (!released) { try { await other.query('ROLLBACK'); other.release(); } catch {} }
    await Promise.all([app.end(),admin.end()]);
  }
});
