import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { oidcVerifier } from '../src/auth.ts';
import { buildServer } from '../src/server.ts';
import { FakeMemberships, MemoryTestDouble } from '../src/memory-test-double.ts';

const issuer = 'https://identity.scopehatch.test';
const audience = 'scopehatch-api';
const catalog = { tenantId: 'tenant-one', version: 1, currency: 'USD', services: [{ id: 'render', label: 'Render', unitPriceMinor: 2500 }] };
const members = [
  { subject: 'subject-1', actorId: 'alice', tenantId: 'tenant-one', roles: ['operator'] as const, active: true },
  { subject: 'subject-2', actorId: 'bob', tenantId: 'tenant-one', roles: ['reviewer'] as const, active: true },
  { subject: 'subject-3', actorId: 'mallory', tenantId: 'tenant-two', roles: ['owner'] as const, active: true }
];

async function harness() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256'; jwk.use = 'sig';
  const verifier = oidcVerifier({ issuer, audience, localJwks: { keys: [jwk] } });
  const app = buildServer({ store: new MemoryTestDouble([catalog]), memberships: new FakeMemberships(members.map(m => ({...m, roles: [...m.roles]}))), verify: verifier });
  await app.ready();
  const sign = async (sub: string, overrides: { issuer?: string; audience?: string; expires?: number; claims?: Record<string, unknown> } = {}) => {
    const token = new SignJWT({ ...(overrides.claims ?? {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(sub).setIssuedAt().setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience).setExpirationTime(overrides.expires ?? '15m');
    return token.sign(privateKey);
  };
  const send = (method: string, url: string, token: string, payload?: object, key?: string, workspace?: string) => app.inject({
    method: method as 'GET' | 'POST', url,
    headers: { authorization: 'Bearer ' + token, ...(key ? { 'idempotency-key': key } : {}), ...(workspace ? { 'x-workspace-id': workspace } : {}) },
    ...(payload !== undefined && { payload })
  });
  return { app, sign, send };
}

test('JWT signature, issuer, audience, expiry and trusted membership enforced', async t => {
  const h = await harness(); t.after(() => h.app.close());
  const owner = await h.sign('subject-1', { claims: { tenantId: 'tenant-two', actorId: 'mallory', roles: ['owner'] } });
  assert.equal((await h.send('GET', '/v1/catalogs', owner)).statusCode, 200);
  assert.equal((await h.send('GET', '/v1/catalogs', await h.sign('subject-1', { issuer: 'https://wrong.test' }))).statusCode, 401);
  assert.equal((await h.send('GET', '/v1/catalogs', await h.sign('subject-1', { audience: 'wrong-api' }))).statusCode, 401);
  assert.equal((await h.send('GET', '/v1/catalogs', await h.sign('subject-1', { expires: Math.floor(Date.now()/1000) - 10 }))).statusCode, 401);
  const segments = owner.split('.');
  segments[2] = (segments[2]!.startsWith('A') ? 'B' : 'A') + segments[2]!.slice(1);
  assert.equal((await h.send('GET', '/v1/catalogs', segments.join('.'))).statusCode, 401);
  assert.equal((await h.send('GET', '/v1/catalogs', await h.sign('unregistered'))).statusCode, 403);
  assert.equal((await h.send('GET', '/v1/catalogs', owner, undefined, undefined, 'tenant-two')).statusCode, 403);
  const noAuth = await h.app.inject({ method: 'GET', url: '/v1/catalogs' });
  assert.equal(noAuth.statusCode, 401);
  assert.equal((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
});

test('complete Fastify workflow, permission boundaries and replay', async t => {
  const h = await harness(); t.after(() => h.app.close());
  const alice = await h.sign('subject-1'); const bob = await h.sign('subject-2'); const mallory = await h.sign('subject-3');
  const fakePrivileges = await h.send('POST', '/v1/projects', alice, { title: 'House', brief: 'One rendering', roles: ['owner'], tenantId: 'tenant-two' }, 'p-evil');
  assert.equal(fakePrivileges.statusCode, 422);
  const initial = await h.send('POST', '/v1/projects', alice, { title: 'House', brief: 'One rendering' }, 'p-1');
  assert.equal(initial.statusCode, 201);
  const projectId = initial.json().project.id;
  const replay = await h.send('POST', '/v1/projects', alice, { brief: 'One rendering', title: 'House' }, 'p-1');
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().project.id, projectId);
  assert.equal((await h.send('POST', '/v1/projects', alice, { title: 'Changed', brief: 'One rendering' }, 'p-1')).statusCode, 409);
  assert.equal((await h.send('POST', '/v1/projects', alice, { title: 'Other', brief: 'One rendering' })).statusCode, 422);
  assert.equal((await h.send('GET', '/v1/projects/' + projectId, mallory)).statusCode, 404);
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/scopes', mallory, { deliverables: [], unknowns: [] }, 's-evil')).statusCode, 404);
  const scope = { deliverables: [{ serviceId: 'render', quantity: 1, source: 'brief', evidence: 'One rendering' }], unknowns: [] };
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/scopes', alice, scope, 's-1')).statusCode, 201);
  const pair = { scopeRevision: 1, catalogVersion: 1 };
  const quote = await h.send('POST', '/v1/projects/' + projectId + '/estimates', alice, pair, 'e-1');
  assert.equal(quote.statusCode, 201);
  assert.equal(quote.json().estimate.totalMinor, 2500);
  assert.equal((await h.send('GET', '/v1/projects/' + projectId + '/exports/1', alice)).statusCode, 409);
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/reviews', alice, pair, 'r-1')).statusCode, 201);
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/approve', alice, pair, 'a-bad')).statusCode, 403);
  const approval = await h.send('POST', '/v1/projects/' + projectId + '/approve', bob, pair, 'a-1');
  assert.equal(approval.statusCode, 200);
  assert.equal(approval.json().review.approvedBy, 'bob');
  assert.equal((await h.send('GET', '/v1/projects/' + projectId + '/exports/1', alice)).statusCode, 200);
  const audit = await h.send('GET', '/v1/projects/' + projectId + '/audit?limit=2', bob);
  assert.equal(audit.statusCode, 200);
  assert.equal(audit.json().items.length, 2);
  assert.ok(audit.json().nextCursor);
  assert.equal((await h.send('GET', '/v1/projects/' + projectId + '/audit?cursor=invalid', alice)).statusCode, 422);
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/suggestions', alice, {}, 'sug-1')).statusCode, 503);
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/scopes', alice, scope, 's-2')).statusCode, 201);
  assert.equal((await h.send('GET', '/v1/projects/' + projectId + '/exports/1', alice)).statusCode, 409);
  assert.equal((await h.send('POST', '/v1/projects/' + projectId + '/approve', bob, pair, 'a-2')).statusCode, 409);
});
