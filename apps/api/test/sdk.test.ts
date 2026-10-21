import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { buildServer } from '../src/server.ts';
import { oidcVerifier } from '../src/auth.ts';
import { createPgPorts, assertRestrictedPgPool } from '../src/postgres.ts';
import { createInferenceGateway } from '../src/inference.ts';

const connectionString=process.env.TEST_PG_APP_URL;
test('published SDK can run the authenticated two-actor workflow on durable Postgres', {skip:!connectionString},async t=>{
  const {ScopehatchClient,staticBearerToken}=await import('../../../packages/sdk/dist/src/index.js');
  const pool=new Pool({connectionString,max:8});
  t.after(()=>pool.end());
  await assertRestrictedPgPool(pool);
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey);jwk.kid='sdk-integrated-key';jwk.use='sig';jwk.alg='RS256';
  const issuer='https://sdk-identity.scopehatch.invalid/';
  const audience='scopehatch-api';
  const app=buildServer({...createPgPorts(pool),
    verify:oidcVerifier({issuer,audience,localJwks:{keys:[jwk]}}),
    suggestions:createInferenceGateway(pool,createPgPorts(pool).store)});
  await app.ready();t.after(()=>app.close());
  const token=async(subject:string)=>new SignJWT({roles:['owner'],tenantId:'studio-b'})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience(audience)
    .setSubject(subject).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const transport=async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input));
    const response=await app.inject({
      method:(init?.method??'GET') as 'GET'|'POST',url:url.pathname+url.search,
      headers:init?.headers as Record<string,string>??{},
      ...(init?.body===undefined?{}:{payload:String(init.body)})
    });
    return new Response(response.body,{status:response.statusCode,
      headers:{'content-type':response.headers['content-type']?.toString()??'application/json'}});
  };
  const op=new ScopehatchClient({
    baseUrl:'http://localhost:3998',credentials:staticBearerToken(await token('a-operator')),
    workspaceId:()=> 'studio-a',fetch:transport,maxRetries:0
  });
  const reviewer=new ScopehatchClient({
    baseUrl:'http://localhost:3998',credentials:staticBearerToken(await token('a-reviewer')),
    workspaceId:'studio-a',fetch:transport,maxRetries:0
  });
  const other=new ScopehatchClient({
    baseUrl:'http://localhost:3998',credentials:staticBearerToken(await token('b-operator')),
    workspaceId:'studio-b',fetch:transport,maxRetries:0
  });
  const catalogs=await op.listCatalogs();
  assert.equal(catalogs[0].services.find(x=>x.id==='render')?.unitPriceMinor,200000);
  const brief='We need 2 render images';
  const key=randomUUID();
  const created=await op.createProject({title:'SDK signed '+key,brief},{idempotencyKey:key});
  const replay=await op.createProject({title:'SDK signed '+key,brief},{idempotencyKey:key});
  assert.equal(created.id,replay.id);
  await assert.rejects(()=>other.getProject(created.id),(e:unknown)=>
    typeof e==='object'&&e!==null&&'status' in e&&e.status===404);
  const scope=await op.createScope(created.id,{
    deliverables:[{serviceId:'render',quantity:2,evidence:'2 render images',source:'brief'}],
    unknowns:[]
  },{idempotencyKey:randomUUID()});
  const pair={scopeRevision:scope.revision,catalogVersion:1};
  const estimate=await op.createEstimate(created.id,pair,{idempotencyKey:randomUUID()});
  assert.equal(estimate.state,'ready');
  assert.equal(estimate.totalMinor,400000);
  const pending=await op.submitReview(created.id,pair,{idempotencyKey:randomUUID()});
  assert.equal(pending.state,'pending');
  const snapshot=await reviewer.getProject(created.id);
  assert.equal(snapshot.project.id,created.id);
  await assert.rejects(()=>op.approveReview(created.id,pair,{idempotencyKey:randomUUID()}),
    (e:unknown)=>typeof e==='object'&&e!==null&&'status' in e&&e.status===403);
  const approved=await reviewer.approveReview(created.id,pair,{idempotencyKey:randomUUID()});
  assert.equal(approved.approvedBy,'a-reviewer');
  const exported=await op.exportApprovedProposal(created.id,1);
  assert.equal(exported.totalMinor,400000);
  assert.match(exported.markdown,/Approved by: a-reviewer/);
  const audit=await reviewer.listAudit(created.id,{limit:20});
  assert.ok(audit.items.some(x=>x.action==='review.approved'));
});
