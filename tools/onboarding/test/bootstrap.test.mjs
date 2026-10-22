import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, validateIssuer, provisionTenant, ConflictError, DatabaseError, InputError } from '../bootstrap.mjs';
import { parseArgs } from '../cli.mjs';

const base = () => ({tenantId:'valid-studio', workspaceName:'Valid Studio', ownerSub:'auth0|owner-9a1b2c',issuer:'https://login.acme.co/',expectedIssuer:'https://login.acme.co/',environment:'production',confirmEnvironment:'production', database:'scopehatch',verified:true});
class FakeDb {
  constructor({tenant=null,members=[],admin=true,db='scopehatch',fault=null}={}) {this.tenant=tenant;this.members=members;this.admin=admin;this.db=db;this.fault=fault;this.queries=[];this.tx=[];}
  async query(sql,params=[]) {
    this.queries.push({sql,params});
    if(this.fault && sql.includes(this.fault)) throw new Error('postgres secret=password private-sub');
    if(sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL')) return {};
    if(sql==='COMMIT') { for(const f of this.tx) f(); this.tx=[]; return {}; }
    if(sql==='ROLLBACK') {this.tx=[]; return {};}
    if(sql.includes('current_user AS username'))return {rows:[{username:this.admin?'scopehatch_admin':'scopehatch_runtime',database:this.db,superuser:this.admin,bypassrls:false,tenants:'scopehatch.tenants',memberships:'scopehatch.memberships'}]};
    if(sql.includes('pg_advisory_xact_lock'))return {rows:[{}]};
    if(sql.includes('SELECT id, name FROM scopehatch.tenants'))return {rows:this.tenant?[this.tenant]:[]};
    if(sql.includes('SELECT principal_id, roles, active'))return {rows:this.members};
    if(sql.startsWith('INSERT INTO scopehatch.tenants')) {this.tx.push(()=>this.tenant={id:params[0],name:params[1]});return {};}
    if(sql.startsWith('INSERT INTO scopehatch.memberships')) {this.tx.push(()=>this.members=[{principal_id:params[1],roles:['owner'],active:true}]);return {};}
    throw new Error('unexpected query');
  }
}

test('validates trusted issuer, exact opaque sub and deployment confirmation',()=>{
  assert.equal(validateRequest(base()).tenantId,'valid-studio');
  for(const issuer of ['http://real.example.net','https://issuer.example.invalid/','https://localhost:8443','https://fake.example.com','https://foo.net/?sub=bad'])assert.throws(()=>validateIssuer(issuer),InputError);
  for(const sub of ['a-operator','oidc-subject-from-trusted-issuer',' alice','bob','abc\nsecret'])assert.throws(()=>validateRequest({...base(),ownerSub:sub}),InputError);
  for(const tenantId of ['studio-a','a','../prod','ACME','a'.repeat(64)])assert.throws(()=>validateRequest({...base(),tenantId}),InputError);
  for(const diff of [{expectedIssuer:'https://login.acme.co'},{confirmEnvironment:'staging'},{verified:false},{workspaceName:' Bad '},{database:'scopehatch;DROP'}])assert.throws(()=>validateRequest({...base(),...diff}),InputError);
});

test('new tenant and initial owner commit together with parameterized values',async()=>{
 const db=new FakeDb();assert.equal(await provisionTenant(db,base()),'created');
 assert.equal(db.tenant.id,'valid-studio');assert.deepEqual(db.members,[{principal_id:'auth0|owner-9a1b2c',roles:['owner'],active:true}]);
 const writes=db.queries.filter(x=>x.sql.startsWith('INSERT'));
 assert.equal(writes.length,2);assert(writes.every(x=>x.sql.includes('$1') && x.sql.includes('$2') && !x.sql.includes('auth0|')));
 assert(db.queries.some(x=>x.sql==='COMMIT'));
});

test('identical rerun is read-only even when unrelated non-owner users exist',async()=>{
 const db=new FakeDb({tenant:{id:'valid-studio',name:'Valid Studio'},members:[{principal_id:base().ownerSub,roles:['owner'],active:true},{principal_id:'another-user',roles:['reviewer'],active:true}]});
 assert.equal(await provisionTenant(db,base()),'unchanged');
 assert.equal(db.queries.filter(x=>x.sql.startsWith('INSERT')).length,0);
});

test('conflicting owner, inactive owner, name drift, extra owner, changed owner roles fail without writes',async()=>{
 const request=base();
 for(const params of [
  {tenant:{id:'valid-studio',name:'Different'},members:[{principal_id:request.ownerSub,roles:['owner'],active:true}]},
  {tenant:{id:'valid-studio',name:'Valid Studio'},members:[{principal_id:'other-sub',roles:['owner'],active:true}]},
  {tenant:{id:'valid-studio',name:'Valid Studio'},members:[{principal_id:request.ownerSub,roles:['owner'],active:false}]},
  {tenant:{id:'valid-studio',name:'Valid Studio'},members:[{principal_id:request.ownerSub,roles:['owner','operator'],active:true}]},
  {tenant:{id:'valid-studio',name:'Valid Studio'},members:[{principal_id:request.ownerSub,roles:['owner'],active:true},{principal_id:'other-sub',roles:['owner'],active:false}]},
  {tenant:{id:'valid-studio',name:'Valid Studio'},members:[]},
 ]){
  const db=new FakeDb(params);await assert.rejects(provisionTenant(db,request),ConflictError);
  assert(db.queries.some(x=>x.sql==='ROLLBACK'));
  assert.equal(db.queries.filter(x=>x.sql.startsWith('INSERT')).length,0);
 }
});

test('dry run never mutates even for new tenant',async()=>{
 const db=new FakeDb();assert.equal(await provisionTenant(db,base(),{dryRun:true}),'would-create');
 assert.equal(db.tenant,null);assert.equal(db.members.length,0);
 assert(!db.queries.some(x=>x.sql.includes('pg_advisory_xact_lock')));
 assert(db.queries.some(x=>x.sql==='ROLLBACK'));
});

test('restricted runtime roles and wrong database fail closed',async()=>{
 for(const db of [new FakeDb({admin:false}),new FakeDb({db:'other_database'})]){
  await assert.rejects(provisionTenant(db,base()),InputError);
  assert(db.queries.some(x=>x.sql==='ROLLBACK'));
 }
});

test('raw driver errors are sanitized and transactions rollback',async()=>{
 const db=new FakeDb({fault:'INSERT INTO scopehatch.memberships'});
 await assert.rejects(provisionTenant(db,base()),err=>err instanceof DatabaseError && !err.message.includes('password'));
 assert.equal(db.tenant,null);assert.equal(db.members.length,0);
 assert(db.queries.some(x=>x.sql==='ROLLBACK'));
});

test('CLI parsing rejects duplicates, unrecognized commands and missing credential path',()=>{
 assert.deepEqual(parseArgs(['--help']),{help:true});
 for(const args of [[],['tenant','create'],['tenant','create','--admin-db-url-file','/tmp/a','--admin-db-url-file','/tmp/b'],['tenant','create','--something']]) assert.throws(()=>parseArgs(args),InputError);
});
