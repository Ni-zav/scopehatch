import test from 'node:test';
import assert from 'node:assert/strict';
import {exportJWK,generateKeyPair,SignJWT} from 'jose';
import {oidcVerifier} from '../src/auth.ts';
import {buildServer} from '../src/server.ts';
import {FakeMemberships,MemoryTestDouble} from '../src/memory-test-double.ts';

const issuer='https://oidc.scopehatch.test',audience='scopehatch-api';
const members=[
  {subject:'own',actorId:'owner',tenantId:'studio-a',roles:['owner'] as const,active:true},
  {subject:'edit',actorId:'editor',tenantId:'studio-a',roles:['operator'] as const,active:true},
  {subject:'review',actorId:'reviewer',tenantId:'studio-a',roles:['reviewer'] as const,active:true},
  {subject:'other',actorId:'other-owner',tenantId:'studio-b',roles:['owner'] as const,active:true}
];
async function setup(){
  const {publicKey,privateKey}=await generateKeyPair('RS256');
  const jwk=await exportJWK(publicKey);jwk.kid='signed-sprint02';jwk.use='sig';jwk.alg='RS256';
  const store=new MemoryTestDouble();
  const app=buildServer({store,memberships:new FakeMemberships(members.map(m=>({...m,roles:[...m.roles]}))),
    verify:oidcVerifier({issuer,audience,localJwks:{keys:[jwk]}})});
  await app.ready();
  const token=async(sub:string,claims:Record<string,unknown>={})=>new SignJWT(claims)
    .setProtectedHeader({alg:'RS256',kid:'signed-sprint02'})
    .setIssuer(issuer).setAudience(audience).setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const send=(method:'GET'|'POST',url:string,jwt:string,payload?:object,key?:string,workspace?:string)=>app.inject({
    method,url,headers:{authorization:'Bearer '+jwt,...(key?{'idempotency-key':key}:{}),
      ...(workspace?{'x-workspace-id':workspace}:{})},...(payload!==undefined?{payload}:{})
  });
  return {app,token,send};
}
const service={id:'render',label:'Rendering',unitPriceMinor:2500};
const terms={overview:'Facade visualization',assumptions:['Client provides plans'],
  exclusions:['No animation'],commercialTerms:['Milestones require signed acceptance']};

test('owner catalog CAS, signed identity, forged roles, replay and fail-closed tenant selector',async t=>{
  const h=await setup();t.after(()=>h.app.close());
  const owner=await h.token('own'),operator=await h.token('edit',{roles:['owner'],tenantId:'studio-b'});
  const outsider=await h.token('other'),reviewer=await h.token('review');
  const payload={baseVersion:0,currency:'USD',services:[service]};
  assert.equal((await h.send('POST','/v1/catalogs',operator,payload,'forged')).statusCode,403);
  assert.equal((await h.send('POST','/v1/catalogs',reviewer,payload,'reviewer')).statusCode,403);
  assert.equal((await h.send('POST','/v1/catalogs',owner,payload,'unauthorized-selector','studio-b')).statusCode,403);
  const created=await h.send('POST','/v1/catalogs',owner,payload,'first');
  assert.equal(created.statusCode,201,created.body);
  assert.equal(created.json().catalog.version,1);
  const replay=await h.send('POST','/v1/catalogs',owner,{currency:'USD',services:[service],baseVersion:0},'first');
  assert.deepEqual(replay.json(),created.json());
  assert.equal((await h.send('POST','/v1/catalogs',owner,{...payload,currency:'IDR'},'first')).statusCode,409);
  const stale=await h.send('POST','/v1/catalogs',owner,payload,'second');
  assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'STALE_CATALOG_VERSION');
  assert.equal((await h.send('POST','/v1/catalogs',owner,{...payload,baseVersion:1,services:[service,service]},'duplicate')).json().error.code,'DUPLICATE_SERVICE');
  assert.equal((await h.send('POST','/v1/catalogs',owner,{...payload,currency:'ZZZ'},'bad-currency')).statusCode,422);
  assert.equal((await h.send('POST','/v1/catalogs',owner,{...payload,services:[{...service,unitPriceMinor:Number.MAX_SAFE_INTEGER+1}]},'overflow')).statusCode,422);
  assert.equal((await h.send('POST','/v1/catalogs',owner,{...payload,tenantId:'studio-b'},'client-tenant')).statusCode,422);
  assert.equal((await h.send('POST','/v1/catalogs',outsider,payload,'other-catalog')).statusCode,201);
  assert.equal((await h.send('GET','/v1/catalogs',operator,undefined,undefined,'studio-b')).statusCode,403);
  const forged=await h.token('edit',{actorId:'owner',roles:['owner'],tenantId:'studio-a'});
  assert.equal((await h.send('POST','/v1/catalogs',forged,{...payload,baseVersion:1},'still-editor')).statusCode,403);
  const expired=await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject('own').setIssuer(issuer)
    .setAudience(audience).setExpirationTime('1m').sign(new TextEncoder().encode('untrusted'));
  assert.equal((await h.send('GET','/v1/projects',expired)).statusCode,401);
});

test('tenant-concealed project listing traverses stable cursor and returns derived statuses',async t=>{
  const h=await setup();t.after(()=>h.app.close());
  const owner=await h.token('own'),editor=await h.token('edit'),reviewer=await h.token('review'),other=await h.token('other');
  await h.send('POST','/v1/catalogs',owner,{baseVersion:0,currency:'USD',services:[service]},'catalog');
  const ids:string[]=[];
  for(let i=0;i<5;i++){
    const result=await h.send('POST','/v1/projects',editor,{title:'Project '+i,brief:'Two rendering views'},'project-'+i);
    assert.equal(result.statusCode,201,result.body);ids.push(result.json().project.id);
  }
  const first=await h.send('GET','/v1/projects?limit=2',reviewer);
  assert.equal(first.statusCode,200);assert.equal(first.json().items.length,2);
  assert.ok(first.json().nextCursor);
  assert.equal(first.json().items[0].brief,undefined);
  const page2=await h.send('GET','/v1/projects?limit=2&cursor='+first.json().nextCursor,reviewer);
  const page3=await h.send('GET','/v1/projects?limit=2&cursor='+page2.json().nextCursor,reviewer);
  assert.deepEqual([first,page2,page3].flatMap(p=>p.json().items.map((x:{id:string})=>x.id)).sort(),[...ids].sort());
  assert.equal(page3.json().nextCursor,null);
  assert.equal((await h.send('GET','/v1/projects?limit=0',owner)).statusCode,422);
  assert.equal((await h.send('GET','/v1/projects?limit=101',owner)).statusCode,422);
  assert.equal((await h.send('GET','/v1/projects?tenantId=studio-b',owner)).statusCode,422);
  assert.equal((await h.send('GET','/v1/projects?cursor=%2Fbad',owner)).statusCode,422);
  assert.equal((await h.send('GET','/v1/projects?cursor='+first.json().nextCursor,other)).json().error.code,'INVALID_CURSOR');
  assert.deepEqual((await h.send('GET','/v1/projects',other)).json().items,[]);
  assert.equal((await h.send('GET','/v1/projects/'+ids[0],other)).statusCode,404);
});

test('proposal is immutable scope metadata; text-only revision revokes export and status',async t=>{
  const h=await setup();t.after(()=>h.app.close());
  const owner=await h.token('own'),editor=await h.token('edit'),reviewer=await h.token('review');
  await h.send('POST','/v1/catalogs',owner,{baseVersion:0,currency:'USD',services:[service]},'c0');
  const created=await h.send('POST','/v1/projects',editor,{title:'House',brief:'Two rendering views'},'p0');
  const id=created.json().project.id,prefix='/v1/projects/'+id;
  const line={serviceId:'render',quantity:2,evidence:'Two rendering views',source:'brief',clientDescription:'<script>pay me</script>'};
  const body={deliverables:[line],unknowns:[],proposal:terms};
  const first=await h.send('POST',prefix+'/scopes',editor,body,'s0');
  assert.equal(first.statusCode,201,first.body);
  assert.deepEqual(first.json().scope.proposal,terms);
  assert.equal(first.json().scope.deliverables[0].clientDescription,line.clientDescription);
  assert.equal((await h.send('GET',prefix,reviewer)).json().latestScope.proposal.overview,terms.overview);
  assert.equal((await h.send('POST',prefix+'/scopes',editor,{...body,proposal:{...terms,assumptions:['   ']}},'bad')).statusCode,422);
  assert.equal((await h.send('POST',prefix+'/scopes',editor,{...body,proposal:{...terms,sneaky:true}},'bad-key')).statusCode,422);
  const pair={scopeRevision:1,catalogVersion:1};
  await h.send('POST',prefix+'/estimates',editor,pair,'e0');
  assert.equal((await h.send('GET','/v1/projects',owner)).json().items[0].status,'ready');
  await h.send('POST',prefix+'/reviews',editor,pair,'r0');
  assert.equal((await h.send('GET','/v1/projects',owner)).json().items[0].status,'pending');
  await h.send('POST',prefix+'/approve',reviewer,pair,'a0');
  assert.equal((await h.send('GET',prefix,reviewer)).json().project.status,'approved');
  const export0=await h.send('GET',prefix+'/exports/1',editor);
  assert.equal(export0.statusCode,200,export0.body);
  assert.deepEqual(export0.json().proposal,terms);
  assert.match(export0.json().markdown,/Commercial terms/);
  assert.doesNotMatch(export0.json().markdown,/<script>/);
  const second=await h.send('POST',prefix+'/scopes',editor,
    {...body,proposal:{...terms,commercialTerms:['Changed terms only']}},'s1');
  assert.equal(second.statusCode,201,second.body);
  assert.equal(second.json().scope.revision,2);
  assert.equal((await h.send('GET',prefix+'/exports/1',editor)).statusCode,409);
  assert.equal((await h.send('GET','/v1/projects',owner)).json().items[0].status,'draft');
  assert.equal((await h.send('POST',prefix+'/approve',reviewer,pair,'stale')).statusCode,409);
  const legacy=await h.send('POST',prefix+'/scopes',editor,{deliverables:[{...line,clientDescription:undefined}],unknowns:[]},'legacy');
  assert.equal(legacy.statusCode,201,legacy.body);
  assert.deepEqual(legacy.json().scope.proposal,{overview:'',assumptions:[],exclusions:[],commercialTerms:[]});
  assert.equal(legacy.json().scope.deliverables[0].clientDescription,'');
  // Even a same-priced replacement catalog supersedes the old approval.
  const next=await h.send('POST','/v1/catalogs',owner,{baseVersion:1,currency:'USD',services:[service]},'c1');
  assert.equal(next.statusCode,201,next.body);
  assert.equal((await h.send('GET',prefix,owner)).json().project.status,'draft');
});
