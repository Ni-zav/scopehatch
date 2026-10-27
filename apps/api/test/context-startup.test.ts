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
