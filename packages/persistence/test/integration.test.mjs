import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPersistence } from '../index.mjs';

// THIS SUITE DOES NOT USE pg-mem OR A MOCK. Both URLs are mandatory.
// The admin connection must be allowed to create roles and provision fixtures.
// The app connection MUST be a distinct, unprivileged role without BYPASSRLS.
// Use a disposable DB: fixture identifiers and migrations are persistent.
const adminURL = process.env.TEST_PG_ADMIN_URL;
const appURL = process.env.TEST_PG_APP_URL;
const enabled = Boolean(adminURL && appURL);
let admin, app, store;

const a = { tenantId: 'studio-a', id: 'a-operator' };
const reviewerA = { tenantId: 'studio-a', id: 'a-reviewer' };
const b = { tenantId: 'studio-b', id: 'b-operator' };
const path = relative => fileURLToPath(new URL(relative, import.meta.url));

before(async () => {
  if (!enabled) return;
  const { Pool } = await import('pg');
  admin = new Pool({ connectionString: adminURL, max: 2 });
  app = new Pool({ connectionString: appURL, max: 8 });
  for (const f of [
    '../../../db/migrations/001_initial.sql',
    '../../../db/migrations/002_quote_integrity.sql',
    '../../../db/migrations/003_immutable_children_usage.sql',
    '../../../db/seeds/001_studios.sql'
  ]) await admin.query(await readFile(path(f), 'utf8'));
  store = createPersistence(app);
  const privilege = await app.query(
    "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
  );
  assert.equal(privilege.rows[0].rolsuper, false, 'integration app cannot be superuser');
  assert.equal(privilege.rows[0].rolbypassrls, false, 'integration app cannot bypass RLS');
  const owner = await app.query(
    "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='scopehatch.projects'::regclass"
  );
  const user = await app.query('SELECT current_user AS name');
  assert.notEqual(owner.rows[0].owner, user.rows[0].name,
    'app role must not own the schema (owner bypass is not an isolation test)');
  const active = await app.query("SELECT row_security_active('scopehatch.projects'::regclass) AS active");
  assert.equal(active.rows[0].active, true);
});
after(async () => { await app?.end(); await admin?.end(); });

async function direct(principal, work) {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('scopehatch.tenant_id',$1,true)", [principal.tenantId]);
    await c.query("SELECT set_config('scopehatch.actor_id',$1,true)", [principal.id]);
    const result = await work(c);
    await c.query('ROLLBACK');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}
async function directFailure(principal, sql, args = []) {
  await assert.rejects(() => direct(principal, c => c.query(sql, args)));
}

test('no SQL context: tenant-owned tables fail closed', { skip: !enabled }, async () => {
  const r = await app.query('SELECT tenant_id,id FROM scopehatch.projects');
  assert.deepEqual(r.rows, []);
  await assert.rejects(
    () => store.withPrincipal({ tenantId: 'studio-a', id: 'nonmember' }, tx => tx.listCatalogs()),
    { code: 'FORBIDDEN' }
  );
});

test('direct SQL SELECT does not expose other tenant briefs, quotes, reviews or audit', { skip: !enabled }, async () => {
  const raw = await direct(b, async c => Promise.all([
    c.query('SELECT brief FROM scopehatch.intakes'),
    c.query('SELECT * FROM scopehatch.estimate_revisions'),
    c.query('SELECT * FROM scopehatch.reviews'),
    c.query('SELECT * FROM scopehatch.audit_events'),
    c.query("SELECT id FROM scopehatch.projects WHERE tenant_id='studio-a'"),
    c.query('SELECT * FROM scopehatch.idempotency_records'),
    c.query('SELECT * FROM scopehatch.model_usage_events')
  ]));
  for (const r of raw) assert.ok(r.rows.every(row => row.tenant_id !== 'studio-a'));
  assert.equal(raw[4].rowCount, 0);
  const aBrief = await direct(a, c => c.query("SELECT brief FROM scopehatch.intakes WHERE project_id='a-demo'"));
  assert.equal(aBrief.rowCount, 1);
});

test('raw SQL cannot disable RLS, cross-write tenants or forge references', { skip: !enabled }, async () => {
  await directFailure(b, "SET LOCAL row_security = off; SELECT * FROM scopehatch.projects");
  await directFailure(b,
    "INSERT INTO scopehatch.projects(tenant_id,id,title,created_by) VALUES('studio-a',$1,'forge','b-operator')",
    [randomUUID()]);
  await directFailure(b,
    "INSERT INTO scopehatch.audit_events(tenant_id,id,project_id,actor_id,action,request_id,outcome) " +
    "VALUES('studio-b',$1,'a-demo','b-operator','forged','request','succeeded')",
    [randomUUID()]);
  await directFailure(b,
    "INSERT INTO scopehatch.memberships(tenant_id,principal_id,roles) VALUES('studio-b','intruder',ARRAY['owner'])");
});

test('catalog/intake/estimate and audit cannot be changed with raw SQL', { skip: !enabled }, async () => {
  await directFailure(a,
    "UPDATE scopehatch.catalog_services SET unit_price_minor=1 WHERE tenant_id='studio-a'");
  await directFailure(a,
    "UPDATE scopehatch.intakes SET brief='tampered' WHERE tenant_id='studio-a'");
  await directFailure(a,
    "DELETE FROM scopehatch.estimate_revisions WHERE tenant_id='studio-a'");
  await directFailure(a,
    "INSERT INTO scopehatch.estimate_revisions " +
    "(tenant_id,project_id,revision,scope_revision,catalog_version,created_by,currency,state,total_minor,lines,blockers) " +
    "VALUES('studio-a','a-demo',2,1,1,'a-operator','IDR','ready',1,'[]','[]')");
  await directFailure(a,
    "INSERT INTO scopehatch.catalog_services(tenant_id,catalog_version,service_id,label,unit_price_minor) " +
    "VALUES('studio-a',1,'late-service','forged after commit',1)");
  await directFailure(a,
    "INSERT INTO scopehatch.scope_deliverables" +
    "(tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source) " +
    "VALUES('studio-a','a-demo',1,1,'render',1,'late item','brief')");
  await directFailure(a,
    "UPDATE scopehatch.model_usage_events SET status='reported',input_tokens=0 " +
    "WHERE tenant_id='studio-a'");
  await directFailure(a,
    "UPDATE scopehatch.reviews SET state='approved',approved_by='a-operator',approved_at=now() " +
    "WHERE tenant_id='studio-a' AND id='a-review'");
});

test('intake and revision append-only, ready quote computed from frozen catalog', { skip: !enabled }, async () => {
  const key = randomUUID();
  const data = await store.withPrincipal(a, async tx => {
    const created = await tx.idempotent({
      key, operation: 'POST /projects', payload: { title: key, brief: 'three images' },
      execute: db => db.createProject({ title: key, brief: 'three images' })
    });
    const scope = await tx.createScope({
      projectId: created.result.id,
      deliverables: [{ serviceId: 'render', quantity: 3, evidence: 'three images', source: 'brief' }]
    });
    const estimate = await tx.createEstimate({
      projectId: created.result.id, scopeRevision: scope.revision, catalogVersion: 1
    });
    return { created, scope, estimate };
  });
  assert.equal(data.estimate.totalMinor, 600000);
  assert.equal(data.estimate.state, 'ready');
  const replay = await store.withPrincipal(a, tx => tx.idempotent({
    key, operation: 'POST /projects', payload: { title: key, brief: 'three images' },
    execute: () => { throw new Error('should not execute on replay'); }
  }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.id, data.created.result.id);
  await assert.rejects(
    () => store.withPrincipal(a, tx => tx.idempotent({
      key, operation: 'POST /projects', payload: { title: key, brief: 'changed' },
      execute: () => Promise.resolve(null)
    })),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );
  await assert.rejects(
    () => store.withPrincipal(b, tx => tx.getScope(data.created.result.id)),
    { code: 'NOT_FOUND' }
  );
});

test('usage keeps unknown values null and is isolated by tenant', { skip: !enabled }, async () => {
  const aUsage = await store.withPrincipal(a, tx => tx.listUsage());
  const bUsage = await store.withPrincipal(b, tx => tx.listUsage());
  assert.ok(aUsage.some(u => u.id === 'a-usage' && u.inputTokens === null));
  assert.ok(bUsage.some(u => u.id === 'b-usage' && u.outputTokens === null));
  assert.ok(!bUsage.some(u => u.tenantId === 'studio-a'));
  await assert.rejects(
    () => store.withPrincipal(a, tx => tx.recordUsage({
      provider: 'demo', model: 'synthetic', status: 'unknown', inputTokens: 0
    })),
    { code: 'INVALID_INPUT' }
  );
});

test('concurrent idempotency replay yields exactly one committed side effect', { skip: !enabled }, async () => {
  const key = randomUUID();
  const payload = { title: 'concurrent-' + key, brief: 'single rendering' };
  const run = () => store.withPrincipal(a, tx => tx.idempotent({
    key, operation: 'POST /projects', payload,
    execute: r => r.createProject(payload)
  }));
  const [x, y] = await Promise.all([run(), run()]);
  assert.equal(x.result.id, y.result.id);
  assert.equal(Number(x.replayed) + Number(y.replayed), 1);
});

test('interrupted approval rolls back both decision and audit', { skip: !enabled }, async () => {
  const initial = await store.withPrincipal(reviewerA, tx => tx.getReview('a-demo', 'a-review'));
  assert.equal(initial.state, 'pending');
  await assert.rejects(
    () => store.withPrincipal(reviewerA, async tx => {
      await tx.approveReview({ projectId: 'a-demo', reviewId: 'a-review' });
      throw new Error('simulate crash before COMMIT');
    }),
    /simulate crash/
  );
  const state = await store.withPrincipal(reviewerA, tx => tx.getReview('a-demo', 'a-review'));
  assert.equal(state.state, 'pending');
  const audits = await store.withPrincipal(reviewerA, tx => tx.listAudit({ projectId: 'a-demo' }));
  assert.ok(!audits.items.some(event => event.action === 'review.approved'));
});

test('approved export is bound to exactly one immutable ready estimate', { skip: !enabled }, async () => {
  const projectId = randomUUID();
  const review = await store.withPrincipal(a, async tx => {
    await tx.createProject({ id: projectId, title: 'Approved scenario', brief: 'two images' });
    const scope = await tx.createScope({
      projectId, deliverables: [
        { serviceId: 'render', quantity: 2, evidence: 'two images', source: 'brief' }
      ]
    });
    const quote = await tx.createEstimate({
      projectId, scopeRevision: scope.revision, catalogVersion: 1
    });
    return tx.submitReview({ projectId, estimateRevision: quote.revision });
  });
  assert.equal(review.state, 'pending');
  const approved = await store.withPrincipal(reviewerA, tx => tx.approveReview({
    projectId, reviewId: review.id
  }));
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedBy, reviewerA.id);
  const exported = await store.withPrincipal(a, tx => tx.exportApproved(projectId));
  assert.equal(exported.totalMinor, 400000);
  assert.match(exported.markdown, /Approved by: a-reviewer/);
  const view = await store.withPrincipal(a, tx => tx.getProject(projectId));
  assert.equal(view.status, 'approved');
});

test('concurrent scope replacement and approval cannot export a stale quote', { skip: !enabled }, async () => {
  const projectId = randomUUID();
  const review = await store.withPrincipal(a, async tx => {
    await tx.createProject({ id: projectId, title: 'Race scenario', brief: 'one image' });
    const scope = await tx.createScope({
      projectId, deliverables: [{ serviceId: 'render', quantity: 1, evidence: 'one image', source: 'brief' }]
    });
    const quote = await tx.createEstimate({ projectId, scopeRevision: scope.revision, catalogVersion: 1 });
    return tx.submitReview({ projectId, estimateRevision: quote.revision });
  });
  const operations = await Promise.allSettled([
    store.withPrincipal(a, tx => tx.createScope({
      projectId, deliverables: [
        { serviceId: 'render', quantity: 2, evidence: 'two images', source: 'brief' }
      ]
    })),
    store.withPrincipal(reviewerA, tx => tx.approveReview({
      projectId, reviewId: review.id
    }))
  ]);
  assert.equal(operations[0].status, 'fulfilled', 'replacement must append successfully');
  await assert.rejects(
    () => store.withPrincipal(reviewerA, tx => tx.exportApproved(projectId)),
    { code: 'STALE_REVISION' }
  );
});

test('a new intake invalidates a previously submitted review', { skip: !enabled }, async () => {
  await store.withPrincipal(a, tx => tx.createIntake({
    projectId: 'a-demo', brief: 'now the requirement is different'
  }));
  await assert.rejects(
    () => store.withPrincipal(reviewerA, tx => tx.approveReview({
      projectId: 'a-demo', reviewId: 'a-review'
    })),
    { code: 'STALE_REVISION' }
  );
});
