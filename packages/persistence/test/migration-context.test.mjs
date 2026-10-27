import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

test('protected migration replay preserves the key and refuses implicit rotation', {
  skip: !process.env.TEST_PG_ADMIN_URL || !process.env.SCOPEHATCH_RUNTIME_DB_PASSWORD_FILE,
}, async () => {
  const admin = new Pool({ connectionString: process.env.TEST_PG_ADMIN_URL });
  const dir = mkdtempSync(join(tmpdir(), 'scopehatch-migration-'));
  const run = keyFile => spawnSync(process.execPath, [fileURLToPath(new URL('../migrate.mjs', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: process.env.TEST_PG_ADMIN_URL, SCOPEHATCH_CONTEXT_KEY_FILE: keyFile },
    encoding: 'utf8', timeout: 10000,
  });
  try {
    const original = (await admin.query('SELECT key FROM scopehatch_private.context_key WHERE singleton')).rows[0].key;
    for (let i=0;i<2;i++) {
      const result = run(process.env.SCOPEHATCH_CONTEXT_KEY_FILE);
      assert.equal(result.status,0,result.stderr);
    }
    const wrong = join(dir,'key');
    writeFileSync(wrong,randomBytes(32).toString('hex'),{mode:0o600});
    const mismatch = run(wrong);
    assert.notEqual(mismatch.status,0);
    assert.match(mismatch.stderr,/explicit reviewed rotation required/);
    assert.deepEqual((await admin.query('SELECT key FROM scopehatch_private.context_key WHERE singleton')).rows[0].key,original);
    const helper = (await admin.query("SELECT pg_get_functiondef('scopehatch.actor_id()'::regprocedure) AS definition")).rows[0].definition;
    assert.match(helper,/verified_context/);
    assert.doesNotMatch(helper,/current_setting/);
  } finally {
    rmSync(dir,{recursive:true,force:true});
    await admin.end();
  }
});
