import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { assertRestrictedPgPool } from '../src/postgres.ts';

test('startup rejects table-owner inheritance, identity writes and disabled RLS', {
  skip: !process.env.TEST_PG_APP_URL || !process.env.TEST_PG_ADMIN_URL,
}, async t => {
  const app = new Pool({ connectionString: process.env.TEST_PG_APP_URL, max: 1 });
  const admin = new Pool({ connectionString: process.env.TEST_PG_ADMIN_URL, max: 1 });
  const quote = (name:string) => '"' + name.replaceAll('"','""') + '"';
  const runtime = (await app.query('SELECT current_user AS name')).rows[0].name as string;
  const owner = 'drift_owner_' + randomBytes(8).toString('hex');
  const qRuntime = quote(runtime), qOwner = quote(owner);
  const tenant = 'drift-tenant-' + randomBytes(8).toString('hex');
  try {
    await assertRestrictedPgPool(app);
    await admin.query('CREATE ROLE '+qOwner+' NOLOGIN NOSUPERUSER NOBYPASSRLS');
    await admin.query('INSERT INTO scopehatch.tenants(id,name) VALUES ($1,$1)',[tenant]);
    await admin.query("INSERT INTO scopehatch.memberships(tenant_id,principal_id,roles) VALUES ($1,'drift-subject',ARRAY['operator'])",[tenant]);
    assert.equal((await app.query('SELECT count(*)::int AS n FROM scopehatch.memberships WHERE tenant_id=$1',[tenant])).rows[0].n,0);
    for (const table of ['scopehatch.memberships','scopehatch.projects',
      'scopehatch.tenant_identity_issuers','scopehatch_private.context_key']) {
      await t.test('reject inherited owner of '+table, async () => {
        const original = (await admin.query('SELECT pg_get_userbyid(relowner) AS name FROM pg_class WHERE oid=$1::regclass',[table])).rows[0].name as string;
        try {
          await admin.query('ALTER TABLE '+table+' OWNER TO '+qOwner);
          await admin.query('GRANT '+qOwner+' TO '+qRuntime);
          assert.equal((await admin.query("SELECT has_schema_privilege($1,'scopehatch','CREATE') AS allowed",[owner])).rows[0].allowed,false);
          if (table==='scopehatch.memberships') {
            assert.equal((await app.query("SELECT row_security_active('scopehatch.memberships') AS active")).rows[0].active,false);
            assert.equal((await app.query('SELECT count(*)::int AS n FROM scopehatch.memberships WHERE tenant_id=$1',[tenant])).rows[0].n,1);
            const client = await app.connect();
            try {
              await client.query('BEGIN');
              const changed = await client.query("UPDATE scopehatch.memberships SET roles=ARRAY['owner'] WHERE tenant_id=$1",[tenant]);
              assert.equal(changed.rowCount,1);
            } finally { await client.query('ROLLBACK'); client.release(); }
            await admin.query('GRANT '+qOwner+' TO '+qRuntime+' WITH INHERIT FALSE, SET TRUE');
            assert.equal((await app.query("SELECT row_security_active('scopehatch.memberships') AS active")).rows[0].active,true);
            await assert.rejects(assertRestrictedPgPool(app),/Refusing privileged/);
            await admin.query('GRANT '+qOwner+' TO '+qRuntime+' WITH INHERIT TRUE');
          }
          await assert.rejects(assertRestrictedPgPool(app),/Refusing privileged/);
        } finally {
          await admin.query('REVOKE '+qOwner+' FROM '+qRuntime);
          await admin.query('ALTER TABLE '+table+' OWNER TO '+quote(original));
        }
        await assertRestrictedPgPool(app);
      });
    }
    for (const table of ['scopehatch.memberships','scopehatch.tenant_identity_issuers']) {
      await t.test('reject direct identity writes on '+table, async () => {
        await admin.query('GRANT UPDATE ON '+table+' TO '+qRuntime);
        try { await assert.rejects(assertRestrictedPgPool(app),/Refusing privileged/); }
        finally { await admin.query('REVOKE UPDATE ON '+table+' FROM '+qRuntime); }
        await assertRestrictedPgPool(app);
      });
      await t.test('reject column identity writes on '+table, async () => {
        const column = table==='scopehatch.memberships' ? 'roles' : 'issuer';
        await admin.query('GRANT UPDATE('+column+') ON '+table+' TO '+qRuntime);
        try { await assert.rejects(assertRestrictedPgPool(app),/Refusing privileged/); }
        finally { await admin.query('REVOKE UPDATE('+column+') ON '+table+' FROM '+qRuntime); }
        await assertRestrictedPgPool(app);
      });
    }
    for (const table of ['scopehatch.memberships','scopehatch.tenant_identity_issuers','scopehatch.projects']) {
      await t.test('reject disabled RLS on '+table, async () => {
        await admin.query('ALTER TABLE '+table+' DISABLE ROW LEVEL SECURITY');
        try { await assert.rejects(assertRestrictedPgPool(app),/Refusing privileged/); }
        finally { await admin.query('ALTER TABLE '+table+' ENABLE ROW LEVEL SECURITY'); }
        await assertRestrictedPgPool(app);
      });
    }
    await t.test('reject removed FORCE RLS on issuer bindings',async () => {
      await admin.query('ALTER TABLE scopehatch.tenant_identity_issuers NO FORCE ROW LEVEL SECURITY');
      try { await assert.rejects(assertRestrictedPgPool(app),/Refusing privileged/); }
      finally { await admin.query('ALTER TABLE scopehatch.tenant_identity_issuers FORCE ROW LEVEL SECURITY'); }
    });
    await assertRestrictedPgPool(app);
  } finally {
    // Synthetic append-only tenants remain in the disposable database.
    try { await admin.query('DROP ROLE IF EXISTS '+qOwner); }
    finally { await Promise.all([app.end(),admin.end()]); }
  }
});

test('startup rejects key mismatch and unsafe runtime grants', {
  skip: !process.env.TEST_PG_APP_URL || !process.env.TEST_PG_ADMIN_URL,
}, async () => {
  const app = new Pool({ connectionString: process.env.TEST_PG_APP_URL, max: 1 });
  const admin = new Pool({ connectionString: process.env.TEST_PG_ADMIN_URL, max: 1 });
  const prior = process.env.SCOPEHATCH_CONTEXT_KEY_FILE;
  const dir = mkdtempSync(join(tmpdir(), 'scopehatch-startup-'));
  const role = (await app.query('SELECT current_user AS name')).rows[0].name as string;
  const quoted = '"' + role.replaceAll('"', '""') + '"';
  try {
    await assertRestrictedPgPool(app);
    const path = join(dir, 'key');
    writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 });
    process.env.SCOPEHATCH_CONTEXT_KEY_FILE = path;
    await assert.rejects(assertRestrictedPgPool(app), /identity was not verified/);
    const startup = spawnSync(process.execPath, ['--experimental-transform-types',
      fileURLToPath(new URL('../src/index.ts', import.meta.url))], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_PG_APP_URL,
        OIDC_ISSUER: 'https://startup.fixture.invalid/', OIDC_AUDIENCE: 'scopehatch-api',
        OIDC_JWKS_URI: 'https://startup.fixture.invalid/jwks', HOST: '127.0.0.1', PORT: '0' },
      encoding: 'utf8', timeout: 10000,
    });
    assert.equal(startup.status, 78);
    assert.match(startup.stderr, /Authenticated API startup failed/);
    assert.doesNotMatch(startup.stdout + startup.stderr, /Server listening/);
    process.env.SCOPEHATCH_CONTEXT_KEY_FILE = prior;
    for (const [grant, revoke] of [
      ['GRANT pg_read_all_data TO ', 'REVOKE pg_read_all_data FROM '],
      ['GRANT CREATE ON SCHEMA scopehatch TO ', 'REVOKE CREATE ON SCHEMA scopehatch FROM '],
      ['GRANT SELECT ON scopehatch_private.context_key TO ', 'REVOKE SELECT ON scopehatch_private.context_key FROM '],
      ['GRANT UPDATE ON scopehatch_private.context_key TO ', 'REVOKE UPDATE ON scopehatch_private.context_key FROM '],
      ['GRANT EXECUTE ON FUNCTION scopehatch_private.context_mac(text) TO ',
        'REVOKE EXECUTE ON FUNCTION scopehatch_private.context_mac(text) FROM '],
      ['GRANT EXECUTE ON FUNCTION scopehatch.admin_bind_context(text,text) TO ',
        'REVOKE EXECUTE ON FUNCTION scopehatch.admin_bind_context(text,text) FROM '],
    ]) {
      await admin.query(grant + quoted);
      try { await assert.rejects(assertRestrictedPgPool(app), /Refusing privileged/); }
      finally { await admin.query(revoke + quoted); }
      await assertRestrictedPgPool(app);
    }
  } finally {
    if (prior === undefined) delete process.env.SCOPEHATCH_CONTEXT_KEY_FILE;
    else process.env.SCOPEHATCH_CONTEXT_KEY_FILE = prior;
    rmSync(dir, { recursive: true, force: true });
    await Promise.all([app.end(), admin.end()]);
  }
});
