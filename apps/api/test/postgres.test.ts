import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildServer } from '../src/server.ts';
import { oidcVerifier } from '../src/auth.ts';
import { assertRestrictedPgPool, createPgPorts } from '../src/postgres.ts';

const appUrl = process.env.TEST_PG_APP_URL;
const issuer = 'https://test-issuer.scopehatch.invalid/';
const audience = 'scopehatch-api';

test('signed HTTP workflow uses restricted real PostgreSQL and independent approval', {skip: !appUrl}, async t => {
  const pool = new Pool({connectionString:appUrl,max:8});
  t.after(()=>pool.end());
  await assertRestrictedPgPool(pool);
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey);
  jwk.kid='integration-test-key';jwk.use='sig';jwk.alg='RS256';
  const verify=oidcVerifier({issuer,audience,localJwks:{keys:[jwk]}});
  const app=buildServer({...createPgPorts(pool),verify});
  await app.ready();
  t.after(()=>app.close());
  const token=async (subject:string, extra:Record<string,unknown>={})=>new SignJWT(extra)
    .setProtectedHeader({alg:'RS256',kid:jwk.kid})
    .setIssuer(issuer).setAudience(audience).setSubject(subject)
    .setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const operator=await token('a-operator',{roles:['reviewer'],tenantId:'studio-b'});
  const reviewer=await token('a-reviewer',{roles:['operator']});
  const other=await token('b-operator');
  const send=(method:'GET'|'POST',path:string,jwt:string,payload?:object,key?:string)=>app.inject({
    method,url:path,
    headers:{authorization:'Bearer '+jwt,...(key?{'idempotency-key':key}:{})},
    ...(payload===undefined?{}:{payload})
  });
  const expect=async (status:number,method:'GET'|'POST',path:string,jwt:string,payload?:object,key?:string)=>{
    const result=await send(method,path,jwt,payload,key);
    assert.equal(result.statusCode,status,result.body.slice(0,700));
    return result.json();
  };
  const catalogs=await expect(200,'GET','/v1/catalogs',operator);
  assert.ok(catalogs.items.some((x:{version:number})=>x.version===1));
  await expect(401,'GET','/v1/catalogs',await token('a-operator',{iss:'untrusted'}).then(async signed=>{
    const parts=signed.split('.');
    parts[2]='invalid-signature';
    return parts.join('.');
  }));
  await expect(403,'GET','/v1/catalogs',await token('unregistered'));
  const uniq=randomUUID();
  const initial=await expect(201,'POST','/v1/projects',operator,
    {title:'Signed workflow '+uniq,brief:'Please deliver two images'},uniq+'-project');
  const projectId=initial.project.id as string;
  assert.ok(projectId);
  const replay=await expect(201,'POST','/v1/projects',operator,
    {brief:'Please deliver two images',title:'Signed workflow '+uniq},uniq+'-project');
  assert.equal(replay.project.id,projectId);
  await expect(409,'POST','/v1/projects',operator,
    {title:'Changed',brief:'Please deliver two images'},uniq+'-project');
  const prefix='/v1/projects/'+encodeURIComponent(projectId);
  await expect(404,'GET',prefix,other);
  await expect(404,'POST',prefix+'/scopes',other,{deliverables:[],unknowns:[]},uniq+'-cross');
  await expect(403,'POST',prefix+'/scopes',reviewer,
    {deliverables:[],unknowns:[]},uniq+'-reviewer-write');
  await expect(422,'POST',prefix+'/scopes',operator,{
    deliverables:[{serviceId:'render',quantity:2,source:'brief',evidence:'invented approval'}],
    unknowns:[]},uniq+'-fake-evidence');
  const scopePayload={deliverables:[{serviceId:'render',quantity:2,source:'brief',evidence:'two images'}],unknowns:[]};
  await expect(201,'POST',prefix+'/scopes',operator,scopePayload,uniq+'-scope1');
  const pair={scopeRevision:1,catalogVersion:1};
  const estimate=await expect(201,'POST',prefix+'/estimates',operator,pair,uniq+'-estimate1');
  assert.equal(estimate.estimate.totalMinor,400000);
  await expect(409,'GET',prefix+'/exports/1',operator);
  await expect(201,'POST',prefix+'/reviews',operator,pair,uniq+'-review1');
  await expect(403,'POST',prefix+'/approve',operator,pair,uniq+'-self');
  const approval=await expect(200,'POST',prefix+'/approve',reviewer,pair,uniq+'-approve1');
  assert.equal(approval.review.approvedBy,'a-reviewer');
  const exported=await expect(200,'GET',prefix+'/exports/1',operator);
  assert.equal(exported.revision,1);
  assert.equal(exported.totalMinor,400000);
  assert.match(exported.markdown,/Approved by: a-reviewer/);
  const audit=await expect(200,'GET',prefix+'/audit?limit=2',reviewer);
  assert.equal(audit.items.length,2);
  assert.ok(audit.nextCursor);
  await expect(201,'POST',prefix+'/scopes',operator,
    {deliverables:[{serviceId:'render',quantity:3,source:'brief',evidence:'two images'}],unknowns:[]},
    uniq+'-scope2');
  await expect(409,'GET',prefix+'/exports/1',operator);
  await expect(409,'POST',prefix+'/approve',reviewer,pair,uniq+'-stale');
});
