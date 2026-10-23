import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Isolate module evaluation to verify the real startup boundary. No database,
// Docker, secrets, or network calls are needed for these checks.
const moduleUrl = new URL('../index.mjs', import.meta.url).href;
function startWith(env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(moduleUrl)})`], {
    env: { ...process.env, NODE_ENV: 'production',
      SCOPEHATCH_CURSOR_SECRET: '', ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}

test('production refuses missing or short project cursor signing keys', () => {
  const missing = startWith({});
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SCOPEHATCH_CURSOR_SECRET is required in production/);

  const weak = startWith({ SCOPEHATCH_CURSOR_SECRET: 'too-short' });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /at least 32 characters/);
});

test('production accepts a sufficiently long configured key; local development can use ephemeral key', () => {
  const configured = startWith({ SCOPEHATCH_CURSOR_SECRET: 'fixture-only-secret'.repeat(3) });
  assert.equal(configured.status, 0, configured.stderr);

  const dev = startWith({ NODE_ENV: 'development', SCOPEHATCH_CURSOR_SECRET: '' });
  assert.equal(dev.status, 0, dev.stderr);
});
