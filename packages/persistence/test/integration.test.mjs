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
    '../../../db/seeds/001_studios.sql',
    '../../../db/migrations/006_sprint02_catalog_proposals_projects.sql'
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
        { serviceId: 'render', quantity: 2, evidence: 'one image', source: 'brief' }
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

test('restricted SQL reviewer cannot create projects, intakes, scopes, estimates or submit review', { skip: !enabled }, async () => {
  await directFailure(reviewerA,
    "INSERT INTO scopehatch.projects(tenant_id,id,title,created_by) VALUES('studio-a',$1,'forged','a-reviewer')", [randomUUID()]);
  await directFailure(reviewerA,
    "INSERT INTO scopehatch.intakes(tenant_id,project_id,revision,brief,author_id) VALUES('studio-a','a-demo',2,'forged','a-reviewer')");
  await directFailure(reviewerA,
    "INSERT INTO scopehatch.scope_revisions(tenant_id,project_id,revision,intake_revision,author_id,unknowns,line_count) VALUES('studio-a','a-demo',2,1,'a-reviewer','[]',1)");
  await directFailure(reviewerA,
    "INSERT INTO scopehatch.estimate_revisions(tenant_id,project_id,revision,scope_revision,catalog_version,created_by,currency,state,total_minor,lines,blockers) VALUES('studio-a','a-demo',2,1,1,'a-reviewer','IDR','ready',400000,'[]','[]')");
  await directFailure(reviewerA,
    "INSERT INTO scopehatch.reviews(tenant_id,project_id,id,estimate_revision,scope_revision,catalog_version,submitted_by) VALUES('studio-a','a-demo',$1,1,1,1,'a-reviewer')", [randomUUID()]);
});

test('restricted SQL cannot insert invented brief evidence even as operator', { skip: !enabled }, async () => {
  const projectId = randomUUID();
  await assert.rejects(() => direct(a, async c => {
    await c.query(
      "INSERT INTO scopehatch.projects(tenant_id,id,title,created_by) VALUES('studio-a',$1,'Grounding test','a-operator')", [projectId]);
    await c.query(
      "INSERT INTO scopehatch.intakes(tenant_id,project_id,revision,brief,author_id) VALUES('studio-a',$1,1,'one exterior rendering','a-operator')", [projectId]);
    await c.query(
      "INSERT INTO scopehatch.scope_revisions(tenant_id,project_id,revision,intake_revision,author_id,unknowns,line_count) VALUES('studio-a',$1,1,1,'a-operator','[]',1)", [projectId]);
    await c.query(
      "INSERT INTO scopehatch.scope_deliverables(tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source) VALUES('studio-a',$1,1,0,'render',1,'fabricated approval not in brief','brief')", [projectId]);
  }), { code: '22023' });
});

test('identity pool role has no superuser, bypass RLS, or schema ownership', { skip: !enabled }, async () => {
  const r = await app.query(
    "SELECT rolsuper,rolbypassrls,pg_has_role(current_user,'scopehatch_app','member') AS member,"+
    "row_security_active('scopehatch.projects'::regclass) AS active FROM pg_roles WHERE rolname=current_user");
  assert.equal(r.rows[0].rolsuper,false);
  assert.equal(r.rows[0].rolbypassrls,false);
  assert.equal(r.rows[0].member,true);
  assert.equal(r.rows[0].active,true);
});


test('S02: migration backfills normalized metadata; tenant-isolated stable pagination', {skip:!enabled}, async () => {
  const legacy = await store.withPrincipal(a, tx => tx.getScope('a-demo',1));
  assert.deepEqual(legacy.proposal, {overview:'',assumptions:[],exclusions:[],commercialTerms:[]});
  assert.equal(legacy.deliverables[0].clientDescription,'');
  const id = randomUUID();
  const ids = [id + '-a', id + '-b'];
  await store.withPrincipal(a,async tx=>{
    for (const projectId of ids) await tx.createProject({id:projectId,title:projectId,brief:'test'});
  });
  const first = await store.withPrincipal(reviewerA,tx=>tx.listProjects({limit:1}));
  assert.equal(first.items.length,1);
  assert.ok(!('brief' in first.items[0]));
  const seen=[];
  let cursor;
  do {
    const page=await store.withPrincipal(reviewerA,tx=>tx.listProjects({limit:2,cursor}));
    seen.push(...page.items);
    cursor=page.nextCursor??undefined;
  } while(cursor);
  assert.equal(new Set(seen.map(x=>x.id)).size,seen.length);
  assert.deepEqual(seen.filter(x=>ids.includes(x.id)).map(x=>x.id),[ids[1],ids[0]]);
  assert.ok(ids.every(x=>seen.some(row=>row.id===x&&row.status==='draft')));
  const foreign=await store.withPrincipal(b,tx=>tx.listProjects({limit:100}));
  assert.ok(foreign.items.every(row=>!ids.includes(row.id)));
  await assert.rejects(()=>store.withPrincipal(b,tx=>tx.listProjects({cursor:first.nextCursor})),
    {code:'INVALID_CURSOR'});
  await assert.rejects(()=>store.withPrincipal(a,tx=>tx.listProjects({cursor:'malformed'})),
    {code:'INVALID_CURSOR'});
  await assert.rejects(()=>store.withPrincipal(a,tx=>tx.listProjects({limit:101})),
    {code:'INVALID_INPUT'});
});

test('S02: approved proposal uses immutable exact revision and safely rendered metadata', {skip:!enabled}, async () => {
  const projectId=randomUUID();
  const proposal={overview:'Exterior images',assumptions:['Model supplied'],
    exclusions:['No animation <script>alert(1)</script>'],
    commercialTerms:['Payment within 10 days']};
  const line={serviceId:'render',quantity:2,evidence:'two images',source:'brief',
    clientDescription:'Dusk view <img src=x>'};
  const result=await store.withPrincipal(a,async tx=>{
    await tx.createProject({id:projectId,title:'Rich proposal',brief:'two images'});
    const scope=await tx.createScope({projectId,proposal,deliverables:[line]});
    const quote=await tx.createEstimate({projectId,scopeRevision:scope.revision,catalogVersion:1});
    const review=await tx.submitReview({projectId,estimateRevision:quote.revision});
    return {scope,quote,review};
  });
  assert.equal(result.quote.totalMinor,400000);
  await store.withPrincipal(reviewerA,tx=>tx.approveReview({projectId,reviewId:result.review.id}));
  const exported=await store.withPrincipal(a,tx=>tx.exportApproved(projectId));
  assert.deepEqual(exported.proposal,proposal);
  assert.match(exported.markdown,/Payment within 10 days/);
  assert.match(exported.markdown,/Dusk view/);
  assert.match(exported.markdown,/\\<img/);
  assert.match(exported.markdown,/\\<script/);
  const read=await store.withPrincipal(a,tx=>tx.getScope(projectId));
  assert.equal(read.deliverables[0].clientDescription,line.clientDescription);
  await directFailure(a,
    "UPDATE scopehatch.scope_revisions SET proposal='{}' WHERE tenant_id='studio-a' AND project_id=$1",
    [projectId]);
  await directFailure(a,
    "UPDATE scopehatch.scope_deliverables SET client_description='forged' WHERE tenant_id='studio-a' AND project_id=$1",
    [projectId]);
  const revised=await store.withPrincipal(a,tx=>tx.createScope({
    projectId,proposal:{...proposal,commercialTerms:['Payment due immediately']},
    deliverables:[line]
  }));
  assert.equal(revised.revision,result.scope.revision+1);
  assert.equal((await store.withPrincipal(a,tx=>tx.getProject(projectId))).status,'draft');
  await assert.rejects(()=>store.withPrincipal(reviewerA,tx=>tx.exportApproved(projectId)),
    {code:'STALE_REVISION'});
  await assert.rejects(()=>store.withPrincipal(a,tx=>tx.createScope({
    projectId,proposal:{...proposal,commercialTerms:['   ']},deliverables:[line]
  })),{code:'INVALID_INPUT'});
});

test('S02: list and detail share draft/blocked/ready/pending/approved read state', {skip:!enabled}, async () => {
  const projectId=randomUUID();
  const base=await store.withPrincipal(a,async tx=>{
    const catalog=(await tx.listCatalogs())[0];
    await tx.createProject({id:projectId,title:'Status transitions',brief:'one image'});
    const draft=await tx.getProject(projectId);
    assert.equal(draft.status,'draft');
    const blockedScope=await tx.createScope({projectId,deliverables:[
      {serviceId:'render',quantity:null,evidence:'one image',source:'brief'}
    ]});
    await tx.createEstimate({
      projectId,scopeRevision:blockedScope.revision,catalogVersion:catalog.version
    });
    assert.equal((await tx.getProject(projectId)).status,'blocked');
    const readyScope=await tx.createScope({projectId,deliverables:[
      {serviceId:'render',quantity:1,evidence:'one image',source:'brief'}
    ]});
    assert.equal((await tx.getProject(projectId)).status,'draft');
    const quote=await tx.createEstimate({
      projectId,scopeRevision:readyScope.revision,catalogVersion:catalog.version
    });
    assert.equal((await tx.getProject(projectId)).status,'ready');
    const review=await tx.submitReview({projectId,estimateRevision:quote.revision});
    assert.equal((await tx.getProject(projectId)).status,'pending');
    const page=await tx.listProjects({limit:100});
    assert.equal(page.items.find(x=>x.id===projectId)?.status,'pending');
    return review;
  });
  await store.withPrincipal(reviewerA,tx=>tx.approveReview({projectId,reviewId:base.id}));
  const result=await store.withPrincipal(reviewerA,async tx=>{
    const detail=await tx.getProject(projectId);
    const page=await tx.listProjects({limit:100});
    return {detail,summary:page.items.find(x=>x.id===projectId)};
  });
  assert.equal(result.detail.status,'approved');
  assert.equal(result.summary.status,result.detail.status);
});

test('S02: DB denies operator catalogs; owner CAS, replay and stale approval are isolated', {skip:!enabled}, async () => {
  // Do not advance Studio A's catalog: Sprint 01 API tests reuse that fixture database.
  const tenantId='s02-'+randomUUID();
  await admin.query('INSERT INTO scopehatch.tenants(id,name) VALUES($1,$2)',
    [tenantId,'Isolated S02 catalog race']);
  await admin.query(
    "INSERT INTO scopehatch.memberships(tenant_id,principal_id,roles) VALUES " +
    "($1,'s02-owner1',ARRAY['owner']),($1,'s02-owner2',ARRAY['owner'])," +
    "($1,'s02-editor',ARRAY['operator']),($1,'s02-reviewer',ARRAY['reviewer'])",
    [tenantId]
  );
  const writer={tenantId,id:'s02-owner1'};
  const editor={tenantId,id:'s02-editor'};
  const reviewer={tenantId,id:'s02-reviewer'};
  const baseVersion=0;
  const services=[{id:'render',label:'Zero rate allowed',unitPriceMinor:0}];
  assert.deepEqual(await store.withPrincipal(writer,tx=>tx.listCatalogs()),[]);
  await assert.rejects(()=>store.withPrincipal(editor,tx=>tx.createCatalog({
    baseVersion,currency:'IDR',services
  })),{code:'FORBIDDEN'});
  await directFailure(editor,
    "INSERT INTO scopehatch.catalog_versions(tenant_id,version,currency,created_by,service_count) " +
    "VALUES($1,$2,'IDR','s02-editor',1)",[tenantId,1]);
  const payload={baseVersion,currency:'IDR',services};
  const key=randomUUID();
  const run=()=>store.withPrincipal(writer,tx=>tx.idempotent({
    key,operation:'POST /v1/catalogs',payload,execute:db=>db.createCatalog(payload)
  }));
  const [one,two]=await Promise.all([run(),run()]);
  assert.equal(one.result.version,1);
  assert.deepEqual(one.result,two.result);
  assert.equal(Number(one.replayed)+Number(two.replayed),1);
  await directFailure(editor,
    "INSERT INTO scopehatch.catalog_services(tenant_id,catalog_version,service_id,label,unit_price_minor) " +
    "VALUES($1,1,'late','Nope',0)",[tenantId]);
  await assert.rejects(()=>store.withPrincipal(writer,tx=>tx.idempotent({
    key,operation:'POST /v1/catalogs',
    payload:{...payload,currency:'USD'},execute:()=>Promise.resolve(null)
  })),{code:'IDEMPOTENCY_CONFLICT'});
  const projectId=randomUUID();
  const review=await store.withPrincipal(writer,async tx=>{
    await tx.createProject({id:projectId,title:'Catalog freshness',brief:'one image'});
    const scope=await tx.createScope({projectId,deliverables:[
      {serviceId:'render',quantity:1,evidence:'one image',source:'brief'}
    ]});
    const quote=await tx.createEstimate({projectId,scopeRevision:scope.revision,catalogVersion:1});
    return tx.submitReview({projectId,estimateRevision:quote.revision});
  });
  await store.withPrincipal(reviewer,tx=>tx.approveReview({projectId,reviewId:review.id}));
  assert.equal((await store.withPrincipal(writer,tx=>tx.getProject(projectId))).status,'approved');
  const owners=[writer,{tenantId,id:'s02-owner2'}];
  const results=await Promise.allSettled(owners.map(principal=>store.withPrincipal(principal,tx=>
    tx.createCatalog({baseVersion:1,currency:'IDR',
      services:[{id:principal.id,label:'Race',unitPriceMinor:42}]}))));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected'&&
    x.reason?.code==='STALE_CATALOG_VERSION').length,1);
  assert.equal((await store.withPrincipal(writer,tx=>tx.getProject(projectId))).status,'draft');
  await assert.rejects(()=>store.withPrincipal(reviewer,tx=>tx.exportApproved(projectId)),
    {code:'STALE_REVISION'});
});


test('S02: DB rejects malformed metadata and repository rejects overlong terms', {skip:!enabled}, async () => {
  const project=await store.withPrincipal(a,tx=>tx.createProject({
    title:'S02 metadata constraint',brief:'one image'
  }));
  await directFailure(a,
    "INSERT INTO scopehatch.scope_revisions(tenant_id,project_id,revision,intake_revision,"+
    "author_id,unknowns,line_count,proposal) VALUES('studio-a',$1,1,1,'a-operator','[]',0,$2::jsonb)",
    [project.id,JSON.stringify({overview:'',assumptions:[{}],exclusions:[],commercialTerms:[]})]);
  await assert.rejects(()=>store.withPrincipal(a,tx=>tx.createScope({
    projectId:project.id,deliverables:[],proposal:{
      overview:'',assumptions:[],exclusions:[],commercialTerms:['x'.repeat(2001)]
    }
  })),{code:'INVALID_INPUT'});
});
