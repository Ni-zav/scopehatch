import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve(import.meta.dirname, '../scripts/service-entrypoint.mjs');
const temp = mkdtempSync(join(tmpdir(), 'scopehatch-entry-'));
const dbSecret = join(temp, 'db');
const modelSecret = join(temp, 'model');
writeFileSync(dbSecret, 'synthetic-test-only-secret\n', { mode: 0o600 });
writeFileSync(modelSecret, 'synthetic-test-only-provider-key', { mode: 0o600 });
writeFileSync(join(temp, 'npm'), '#!/bin/sh\nprintf "ROLE:%s\\n" "$*"\n', { mode: 0o755 });
process.on('exit', () => rmSync(temp, { recursive: true, force: true }));

const env = {
  PATH: `${temp}:${process.env.PATH}`,
  POSTGRES_PASSWORD_FILE: dbSecret,
  PROVIDER_API_KEY_FILE: modelSecret,
  POSTGRES_HOST: 'postgres', POSTGRES_PORT: '5432',
  POSTGRES_DB: 'scopehatch', POSTGRES_USER: 'scopehatch',
  OIDC_ISSUER: 'https://test-issuer.local/',
  OIDC_AUDIENCE: 'scopehatch-api',
  OIDC_JWKS_URI: 'https://test-issuer.local/jwks',
  SCOPEHATCH_INFERENCE_PROVIDER: 'fixture',
};
function run(role, extra = {}) {
  return spawnSync(process.execPath, [script, role], {
    env: { ...env, ...extra }, encoding: 'utf8', timeout: 2500,
  });
}
test('fixture API launches the expected workspace script', () => {
  const r = run('api');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROLE:run start --workspace @scopehatch\/api/);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-test-only-secret/);
});
test('worker is an independent process role', () => {
  const r = run('worker');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROLE:run start:worker --workspace @scopehatch\/api/);
});
test('unsupported role is refused', () => {
  const r = run('delete');
  assert.equal(r.status, 64);
  assert.doesNotMatch(r.stdout, /ROLE:/);
});
test('placeholder OIDC issuer fails closed', () => {
  const r = run('api', { OIDC_ISSUER: 'https://issuer.example.invalid/' });
  assert.equal(r.status, 78);
  assert.doesNotMatch(r.stdout, /ROLE:/);
});
test('missing DB secret fails without exposing credentials', () => {
  const r = run('api', { POSTGRES_PASSWORD_FILE: join(temp, 'missing') });
  assert.equal(r.status, 78);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-test-only-secret/);
});
test('missing hosted model ID fails closed', () => {
  const r = run('api', {
    SCOPEHATCH_INFERENCE_PROVIDER: 'openai-compatible',
    SCOPEHATCH_INFERENCE_BASE_URL: 'https://model.example.invalid/v1',
    SCOPEHATCH_INFERENCE_MODEL: '',
  });
  assert.equal(r.status, 78);
});
test('BYOK secret is never printed', () => {
  const r = run('api', {
    SCOPEHATCH_INFERENCE_PROVIDER: 'openai-compatible',
    SCOPEHATCH_INFERENCE_BASE_URL: 'https://model.example.invalid/v1',
    SCOPEHATCH_INFERENCE_MODEL: 'fixture-model',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /synthetic-test-only-provider-key/);
});
test('migration does not depend on provider credentials', () => {
  const r = run('migrate', {
    SCOPEHATCH_INFERENCE_PROVIDER: 'openai-compatible',
    SCOPEHATCH_INFERENCE_BASE_URL: 'https://model.example.invalid/v1',
    SCOPEHATCH_INFERENCE_MODEL: 'fixture-model',
    PROVIDER_API_KEY_FILE: join(temp, 'missing-provider'),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROLE:run db:migrate --workspace @scopehatch\/persistence/);
});
