/** Sprint 02 real Fastify + restricted PostgreSQL + published SDK contract.
 * Test-only OIDC signing keys and tenant; this MUST run only on disposable PG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { buildServer } from '../src/server.ts';
import { oidcVerifier } from '../src/auth.ts';
import { createPgPorts, assertRestrictedPgPool } from '../src/postgres.ts';
import { bindFixtureIssuer } from './identity-fixture.ts';
// @ts-expect-error Host-only JS module exercised solely by disposable integration tests.
import { manageIdentity } from '../../../tools/onboarding/identity.mjs';
import { createInferenceGateway } from '../src/inference.ts';
import { provisionTenant } from '../../../tools/onboarding/bootstrap.mjs';

const adminUrl = process.env.TEST_PG_ADMIN_URL;
const appUrl = process.env.TEST_PG_APP_URL;
const needsPg = !adminUrl || !appUrl;
const isHttp = (status:number) => (error:unknown) =>
  !!error && typeof error === 'object' && 'status' in error && error.status === status;

test('S02 SDK + live Fastify + RLS PG: bootstrap/catalog/index/proposal/review/export/invalidation', {
  skip: needsPg ? 'Requires disposable TEST_PG_ADMIN_URL and TEST_PG_APP_URL' : false,
}, async () => {
  const { ScopehatchClient, staticBearerToken } =
    await import('../../../packages/sdk/dist/src/index.js');
  const tenantId = 's02-gate-' + randomUUID().replaceAll('-', '').slice(0, 20);
  const ownerSub = 'oidc-owner-' + randomUUID();
  const reviewerSub = 'oidc-reviewer-' + randomUUID();
  const issuer = 'https://idp.acme.co/';
  const audience = 'scopehatch-api';
  const admin = new Client({connectionString:adminUrl});
  const pool = new Pool({connectionString:appUrl,max:8});
  await admin.connect();
  let app:ReturnType<typeof buildServer>|undefined;
  try {
    await bindFixtureIssuer(issuer);
    assert.equal(await provisionTenant(admin,{
      tenantId, workspaceName:'Isolated S02 Integration',
      ownerSub, issuer, expectedIssuer:issuer,
      environment:'development', confirmEnvironment:'development',
      database:process.env.TEST_PG_DATABASE || 'scopehatch', verified:true
    }),'created');
    await manageIdentity(admin,{tenantId,ownerSub,memberSub:reviewerSub,role:'reviewer',command:'member add',issuer,expectedIssuer:issuer,environment:'development',confirmEnvironment:'development',database:process.env.TEST_PG_DATABASE||'scopehatch',verified:true});
    await assertRestrictedPgPool(pool);
    const {publicKey,privateKey}=await generateKeyPair('RS256');
    const jwk=await exportJWK(publicKey);
    jwk.kid='s02-test';jwk.use='sig';jwk.alg='RS256';
    const ports=createPgPorts(pool);
    app=buildServer({...ports,verify:oidcVerifier({issuer,audience,localJwks:{keys:[jwk]}}),
      suggestions:createInferenceGateway(pool,ports.store)});
    const address=await app.listen({host:'127.0.0.1',port:0});
    const token=async(subject:string)=>new SignJWT({tenantId:'untrusted-claim',roles:['owner']})
      .setProtectedHeader({alg:'RS256',kid:jwk.kid})
      .setIssuer(issuer).setAudience(audience).setSubject(subject)
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
    const client=(subject:string,workspace:string,accessToken:string)=>new ScopehatchClient({
      baseUrl:address,workspaceId:workspace,credentials:staticBearerToken(accessToken),maxRetries:0
    });
    const owner=client(ownerSub,tenantId,await token(ownerSub));
    const reviewer=client(reviewerSub,tenantId,await token(reviewerSub));
    const foreign=client('b-operator','studio-b',await token('b-operator'));
    const seed=await owner.listCatalogs();
    assert.deepEqual(seed,[]);
    const rates=[{id:'render',label:'Render angle',unitPriceMinor:750000}];
    const key=randomUUID();
    const v1=await owner.createCatalog({baseVersion:0,currency:'IDR',services:rates},{idempotencyKey:key});
    assert.equal(v1.version,1);
    assert.deepEqual(await owner.createCatalog({baseVersion:0,currency:'IDR',services:rates},{idempotencyKey:key}),v1);
    await assert.rejects(reviewer.createCatalog({baseVersion:1,currency:'IDR',services:rates},
      {idempotencyKey:randomUUID()}),isHttp(403));
    const brief='Studio requires 2 render angles for the lobby.';
    const p1=await owner.createProject({title:'S02 Studio project',brief},{idempotencyKey:randomUUID()});
    const p2=await owner.createProject({title:'S02 Second project',brief:'No quote yet'},{
      idempotencyKey:randomUUID()});
    await assert.rejects(foreign.getProject(p1.id),isHttp(404));
    const page=await owner.listProjects({limit:1});
    assert.equal(page.items.length,1);assert.equal(page.items[0].id,p2.id);
    assert.ok(page.nextCursor);
    const second=await owner.listProjects({limit:1,cursor:page.nextCursor!});
    assert.equal(second.items[0].id,p1.id);
    assert.deepEqual(second.items[0].status,'draft');
    const proposal={
      overview:'A two-image preliminary lobby study',
      assumptions:['Approved concept drawings supplied'],
      exclusions:['Construction documents'],
      commercialTerms:['Terms require independent human review']
    };
    const scope=await owner.createScope(p1.id,{
      deliverables:[{serviceId:'render',quantity:2,evidence:'2 render angles',
        source:'brief',clientDescription:'Two lobby render angles'}],
      unknowns:[],proposal
    },{idempotencyKey:randomUUID()});
    assert.equal(scope.revision,1);assert.deepEqual(scope.proposal,proposal);
    assert.equal(scope.deliverables[0].clientDescription,'Two lobby render angles');
    const binding={scopeRevision:scope.revision,catalogVersion:v1.version};
    const quote=await owner.createEstimate(p1.id,binding,{idempotencyKey:randomUUID()});
    assert.equal(quote.state,'ready');assert.equal(quote.totalMinor,1500000);
    const pending=await owner.submitReview(p1.id,binding,{idempotencyKey:randomUUID()});
    assert.equal(pending.state,'pending');
    await assert.rejects(owner.approveReview(p1.id,binding,{idempotencyKey:randomUUID()}),isHttp(403));
    const approved=await reviewer.approveReview(p1.id,binding,{idempotencyKey:randomUUID()});
    assert.equal(approved.state,'approved');assert.equal(approved.approvedBy,reviewerSub);
    const exported=await owner.exportApprovedProposal(p1.id,1);
    assert.equal(exported.totalMinor,1500000);
    assert.deepEqual(exported.proposal,proposal);
    assert.equal(exported.markdown.split('A two-image preliminary lobby study').length,2,
      'Overview must be rendered exactly once');
    const indexed=await owner.listProjects({limit:100});
    assert.equal(indexed.items.find(p=>p.id===p1.id)?.status,'approved');
    const edited=await owner.createScope(p1.id,{
      deliverables:[{serviceId:'render',quantity:2,evidence:'2 render angles',
        source:'brief',clientDescription:'Two lobby render angles'}],
      unknowns:[],proposal:{...proposal,overview:'Changed terms require new review'}
    },{idempotencyKey:randomUUID()});
    assert.equal(edited.revision,2);
    await assert.rejects(owner.exportApprovedProposal(p1.id,1),isHttp(409));
    const stale=await owner.listProjects({limit:100});
    assert.notEqual(stale.items.find(p=>p.id===p1.id)?.status,'approved');
    const v2=await owner.createCatalog({
      baseVersion:1,currency:'IDR',services:[{id:'render',label:'Render angle',unitPriceMinor:850000}]
    },{idempotencyKey:randomUUID()});
    assert.equal(v2.version,2);
    await assert.rejects(owner.createCatalog({
      baseVersion:1,currency:'IDR',services:rates
    },{idempotencyKey:randomUUID()}),isHttp(409));
    const audit=await owner.listAudit(p1.id,{limit:100});
    assert.ok(audit.items.some(x=>x.action==='review.approved'));
    const changedIssuer='https://changed.idp.acme.co/';
    const replacement=buildServer({...ports,verify:oidcVerifier({issuer:changedIssuer,audience,localJwks:{keys:[jwk]}})});
    try {
      const collision=await new SignJWT({}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
        .setIssuer(changedIssuer).setAudience(audience).setSubject(ownerSub)
        .setIssuedAt().setExpirationTime('5m').sign(privateKey);
      const denied=await replacement.inject({method:'GET',url:'/v1/catalogs',headers:{authorization:'Bearer '+collision}});
      assert.equal(denied.statusCode,403,'Changing configured issuer must not transfer an existing subject membership');
    } finally {await replacement.close();}
    await manageIdentity(admin,{tenantId,ownerSub,memberSub:reviewerSub,command:'member disable',issuer,expectedIssuer:issuer,environment:'development',confirmEnvironment:'development',database:process.env.TEST_PG_DATABASE||'scopehatch',verified:true});
    await assert.rejects(reviewer.listCatalogs(),isHttp(403));
  } finally {
    if(app) await app.close();
    await pool.end();
    await admin.end();
  }
});
