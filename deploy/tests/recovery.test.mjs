import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const rehearsal = resolve(root, 'deploy/scripts/rehearse-recovery.sh');
const upgrade = resolve(root, 'deploy/scripts/verify-upgrade.sh');
const shell = (script, ...args) => spawnSync('sh', [script, ...args], {
  cwd: root, encoding: 'utf8', timeout: 5000,
});

test('recovery and upgrade scripts have no side effects in help mode', () => {
  for (const script of [rehearsal, upgrade]) {
    const result = shell(script, '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});
test('malformed script arguments are rejected without starting containers', () => {
  for (const [script, args] of [
    [rehearsal, ['--not-a-command']],
    [rehearsal, ['--keep-report']],
    [upgrade, ['delete']],
    [upgrade, ['after', 'unexpected']],
  ]) {
    const result = shell(script, ...args);
    assert.equal(result.status, 64, result.stderr);
  }
});
test('recovery has strict container isolation and never targets Compose volumes', () => {
  const text = read('deploy/scripts/rehearse-recovery.sh');
  assert.match(text, /--network none/);
  assert.match(text, /--rm --network none/);
  assert.match(text, /trap cleanup EXIT/);
  assert.match(text, /pg_dump/);
  assert.match(text, /pg_restore --list/);
  assert.match(text, /pg_restore -U postgres -d scopehatch_dr/);
  assert.match(text, /--exit-on-error/);
  assert.match(text, /cmp -s/);
  assert.match(text, /migrate "\$target_id"/);
  assert.doesNotMatch(text, /docker compose\s+down|docker volume rm|--volumes|down -v/);
  assert.doesNotMatch(text, /DATABASE_URL|COMPOSE_PROJECT_NAME|docker exec.*scopehatch_admin/);
});
test('recovery assertions include all financial, tenancy and held-inference invariants', () => {
  const sql = read('deploy/tests/recovery-integrity.sql');
  for (const name of [
    'tenants', 'memberships', 'projects', 'catalog_versions', 'catalog_services',
    'scope_revisions', 'scope_deliverables', 'estimate_revisions', 'reviews',
    'audit_events', 'idempotency_records', 'inference_reservations',
    'inference_accounts', 'model_usage_events',
  ]) assert.match(sql, new RegExp(name));
  assert.match(sql, /SET LOCAL ROLE scopehatch_rehearsal_runtime/);
  assert.match(sql, /submitted_by <> r\.approved_by/);
  assert.match(sql, /cost_minor IS NULL/);
  assert.match(sql, /immutable scope mutation unexpectedly succeeded/);
});
test('upgrade verification reads status only and never invokes a rollout', () => {
  const script = read('deploy/scripts/verify-upgrade.sh');
  assert.match(script, /preflight\.sh prod/);
  assert.match(script, /migration_id=/);
  assert.match(script, /exited:0/);
  assert.match(script, /_healthz \/healthz/);
  assert.doesNotMatch(script, /docker compose.*\b(up|down|run|restart)\b|docker volume rm/);
});
test('default Compose requires neither worker, Redis nor GPU', () => {
  const base = read('deploy/compose.yaml');
  const prod = read('deploy/compose.prod.yaml');
  assert.match(base, /profiles: \[cache\]/);
  assert.match(base, /profiles: \[local-inference\]/);
  assert.match(prod, /profiles: \[worker\]/);
  assert.doesNotMatch(base + prod, /runtime:\s*nvidia|devices:\s*\[.*gpu/);
});
test('full two-container PostgreSQL restore, RLS and migration replay (opt-in Docker)', {
  skip: process.env.RUN_SCOPEHATCH_DOCKER_RECOVERY !== '1'
    ? 'Requires RUN_SCOPEHATCH_DOCKER_RECOVERY=1 and an accessible disposable Docker daemon'
    : false,
}, () => {
  const result = spawnSync('sh', [rehearsal], {
    cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS: source and restored dataset/);
});
