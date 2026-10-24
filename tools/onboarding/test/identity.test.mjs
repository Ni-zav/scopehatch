import test from 'node:test';
import assert from 'node:assert/strict';
import { manageIdentity } from '../identity.mjs';
import { InputError } from '../bootstrap.mjs';
import { parseArgs } from '../cli.mjs';

const base={tenantId:'valid-studio',ownerSub:'external|owner-345',memberSub:'external|reviewer-678',issuer:'https://login.acme.co/',expectedIssuer:'https://login.acme.co/',environment:'staging',confirmEnvironment:'staging',database:'scopehatch',verified:true,command:'member add',role:'reviewer'};
test('identity commands fail invalid role, self enrollment, issuer or confirmation before any query',async()=>{
  const client={query:()=>assert.fail('Invalid input reached database')};
  for(const changes of [{role:'owner'},{memberSub:base.ownerSub},{issuer:'https://other.acme.co/'},{verified:false},{memberSub:'a-reviewer'},{command:'member disable'},{command:'tenant bind-issuer',membersVerified:false},{command:'anything'}]) {
    await assert.rejects(manageIdentity(client,{...base,...changes}),InputError);
  }
});
test('CLI distinguishes member and issuer operations without accepting irrelevant options',()=>{
  for(const command of [['member','add'],['member','disable'],['tenant','bind-issuer']]) {
    assert.equal(parseArgs([...command,'--admin-db-url-file','/secure/url']).command,command.join(' '));
    assert.deepEqual(parseArgs([...command,'--help']),{help:true});
  }
  for(const args of [
    ['tenant','create','--role','reviewer'],
    ['tenant','bind-issuer','--member-sub','external|member-456'],
    ['member','add','--workspace-name','Other Name'],
    ['member','add','--confirm-existing-memberships-verified']
  ]) assert.throws(()=>parseArgs([...args,'--admin-db-url-file','/secure/url']),InputError);
});
