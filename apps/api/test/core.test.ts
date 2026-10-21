import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationService, normalizeError } from '../src/core.ts';
import { MemoryTestDouble } from '../src/memory-test-double.ts';
import type { Principal } from '../src/ports.ts';

const operator: Principal = { id: 'alice', tenantId: 'a', roles: ['operator'] };
const reviewer: Principal = { id: 'bob', tenantId: 'a', roles: ['reviewer'] };
const outsider: Principal = { id: 'eve', tenantId: 'b', roles: ['owner'] };
const catalog = { tenantId: 'a', version: 1, currency: 'USD', services: [{ id: 'render', label: 'Render', unitPriceMinor: 100 }] };
function setup() { return new ApplicationService(new MemoryTestDouble([catalog])); }
async function expectError(action: () => Promise<unknown>, code: string, status: number) {
  await assert.rejects(async () => action(), (err: unknown) => {
    const converted = normalizeError(err);
    assert.equal(converted.code, code);
    assert.equal(converted.status, status);
    return true;
  });
}
async function create(service: ApplicationService) {
  const response = await service.createProject(operator, 'project-key', { title: 'Site', brief: 'Two exterior views' }, 'request-a');
  return (response.body as { project: { id: string } }).project.id;
}
const data = { deliverables: [{ serviceId: 'render', quantity: 2, source: 'brief' as const, evidence: 'Two exterior views' }], unknowns: [] };
const pair = { scopeRevision: 1, catalogVersion: 1 };

test('deterministic quote, separate reviewer approval and approved-only export', async () => {
  const service = setup();
  const id = await create(service);
  await service.createScope(operator, id, 'scope-key', data, 'req-2');
  const { body } = await service.createEstimate(operator, id, 'estimate-key', pair, 'req-3');
  assert.equal((body as any).estimate.totalMinor, 200);
  await expectError(() => service.export(operator, id, 1), 'APPROVAL_REQUIRED', 409);
  await service.submit(operator, id, 'review-key', pair, 'req-4');
  await expectError(() => service.approve(operator, id, 'self-key', pair, 'req-5'), 'FORBIDDEN', 403);
  const approved = await service.approve(reviewer, id, 'approve-key', pair, 'req-6');
  assert.equal((approved.body as any).review.approvedBy, 'bob');
  const exported = await service.export(operator, id, 1);
  assert.match(exported.markdown, /Approved by: bob/);
  assert.equal(exported.totalMinor, 200);
  const events = await service.audit(operator, id, undefined, 2);
  assert.equal(events.items.length, 2);
  assert.ok(events.nextCursor);
  const rest = await service.audit(operator, id, events.nextCursor!, 10);
  assert.equal(rest.items.length, 3);
});

test('self-approval rejected even for actor with owner and reviewer role', async () => {
  const actor: Principal = { id: 'self', tenantId: 'a', roles: ['owner', 'reviewer'] };
  const service = setup();
  const { body } = await service.createProject(actor, 'p', { title: 'Site', brief: 'Brief' }, 'req');
  const id = (body as any).project.id;
  await service.createScope(actor, id, 's', data, 'req');
  await service.createEstimate(actor, id, 'e', pair, 'req');
  await service.submit(actor, id, 'r', pair, 'req');
  await expectError(() => service.approve(actor, id, 'a', pair, 'req'), 'SELF_APPROVAL', 403);
});

test('cross-tenant resources hidden with 404 and no side effects', async () => {
  const service = setup();
  const id = await create(service);
  await expectError(() => service.project(outsider, id), 'NOT_FOUND', 404);
  await expectError(() => service.createScope(outsider, id, 's', data, 'req'), 'NOT_FOUND', 404);
  await expectError(() => service.export(outsider, id, 1), 'NOT_FOUND', 404);
});

test('replay returns same result, conflict differs, concurrent same-key creates once', async () => {
  const service = setup();
  const payload = { title: 'Site', brief: 'Brief' };
  const [a, b] = await Promise.all([
    service.createProject(operator, 'concurrent', payload, 'req-a'),
    service.createProject(operator, 'concurrent', payload, 'req-b')
  ]);
  assert.deepEqual(a, b);
  await expectError(() => service.createProject(operator, 'concurrent', { ...payload, title: 'different' }, 'req-c'), 'IDEMPOTENCY_CONFLICT', 409);
  await expectError(() => service.createProject(operator, '', payload, 'req-d'), 'IDEMPOTENCY_KEY_REQUIRED', 422);
});

test('stale scope revisions invalidate previously approved export', async () => {
  const service = setup(); const id = await create(service);
  await service.createScope(operator, id, 's-1', data, 'req');
  await service.createEstimate(operator, id, 'e-1', pair, 'req');
  await service.submit(operator, id, 'r-1', pair, 'req');
  await service.approve(reviewer, id, 'a-1', pair, 'req');
  await service.createScope(operator, id, 's-2', data, 'req');
  await expectError(() => service.export(operator, id, 1), 'STALE_REVISION', 409);
  await expectError(() => service.createEstimate(operator, id, 'e-stale', pair, 'req'), 'STALE_REVISION', 409);
});

test('missing evidence blocks estimates and review', async () => {
  const service = setup(); const id = await create(service);
  await service.createScope(operator, id, 's', { deliverables: [{ ...data.deliverables[0]!, evidence: '' }], unknowns: [] }, 'req');
  const result = await service.createEstimate(operator, id, 'e', pair, 'req');
  assert.equal((result.body as any).estimate.state, 'blocked');
  await expectError(() => service.submit(operator, id, 'r', pair, 'req'), 'BLOCKED_ESTIMATE', 409);
});
