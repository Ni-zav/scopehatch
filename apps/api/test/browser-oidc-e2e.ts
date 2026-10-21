/**
 * Synthetic OIDC issuer + real Playwright browser + restricted PostgreSQL
 * integration. Test-only credentials and signing keys exist in this process.
 * No fixture identities, signing private keys, or browser tokens are reusable.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { chromium } from '@playwright/test';
import { buildServer } from '../src/server.ts';
import { oidcVerifier } from '../src/auth.ts';
import { createPgPorts, assertRestrictedPgPool } from '../src/postgres.ts';
import { createInferenceGateway } from '../src/inference.ts';

const pgUrl=process.env.TEST_PG_APP_URL;
if (!pgUrl) throw new Error('TEST_PG_APP_URL is required for real browser security test');
const issuer='http://localhost:3999/';
const audience='scopehatch-api';
const base='http://127.0.0.1:4173';
const clientId='scopehatch-playwright-public';
const authorizations=new Map();
const codes=new Map();
const {privateKey,publicKey}=await generateKeyPair('RS256');
const publicJwk=await exportJWK(publicKey);
publicJwk.kid='test-browser-key';publicJwk.alg='RS256';publicJwk.use='sig';
const pool=new Pool({connectionString:pgUrl,max:12});
await assertRestrictedPgPool(pool);
const ports=createPgPorts(pool);
const api=buildServer({
  ...ports,
  verify:oidcVerifier({issuer,audience,localJwks:{keys:[publicJwk]}}),
  suggestions:createInferenceGateway(pool,ports.store)
});
let idp=null, vite=null, browser=null;
const html=(value)=>String(value).replace(/[&<>"']/g,ch=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
function send(res,status,body,headers={}) {
  res.writeHead(status,{'cache-control':'no-store','content-type':'text/html;charset=utf-8',...headers});
  res.end(body);
}
async function readBody(req) {
  let body='';
  for await(const chunk of req) {
    body+=chunk;
    if(body.length>4096)throw Error('Oversize synthetic OIDC request');
  }
  return new URLSearchParams(body);
}
function startIdp(){
  return createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url??'/',issuer);
      if(req.method==='OPTIONS'){
        send(res,204,'',{'access-control-allow-origin':base,
          'access-control-allow-methods':'POST, OPTIONS',
          'access-control-allow-headers':'content-type'});
        return;
      }
      if(pathname.pathname==='/authorize'&&req.method==='GET'){
        const q=pathname.searchParams;
        if(q.get('response_type')!=='code'||q.get('client_id')!==clientId||
           q.get('redirect_uri')!==base+'/'||
           q.get('code_challenge_method')!=='S256'||
           !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge')??'')||
           !q.get('state')){send(res,400,'Invalid PKCE client');return;}
        const transaction=randomUUID();
        authorizations.set(transaction,{challenge:q.get('code_challenge'),
          redirect:q.get('redirect_uri'),state:q.get('state'),created:Date.now()});
        send(res,200,'<!doctype html><title>Synthetic test identity provider</title>'+
          '<h1>Isolated OIDC Test Identity Provider</h1>'+
          '<form action="/login" method="POST"><input type="hidden" name="tx" value="'+html(transaction)+'">'+
          '<button type="submit" name="subject" value="a-operator">Operator test identity</button>'+
          '<button type="submit" name="subject" value="a-reviewer">Reviewer test identity</button></form>');
        return;
      }
      if(pathname.pathname==='/login'&&req.method==='POST'){
        const q=await readBody(req);
        const tx=q.get('tx'),sub=q.get('subject');
        const auth=authorizations.get(tx);
        authorizations.delete(tx);
        if(!auth || !['a-operator','a-reviewer'].includes(sub)||Date.now()-auth.created>600000){
          send(res,400,'Invalid synthetic login');return;
        }
        const code=randomUUID();
        codes.set(code,{...auth,subject:sub,created:Date.now()});
        const redirect=new URL(auth.redirect);
        redirect.searchParams.set('code',code);
        redirect.searchParams.set('state',auth.state);
        send(res,302,'',{'location':redirect.toString()});return;
      }
      if(pathname.pathname==='/token'&&req.method==='POST'){
        const q=await readBody(req);
        const code=q.get('code'),item=codes.get(code);
        codes.delete(code);
        if(!item||Date.now()-item.created>600000||
           q.get('client_id')!==clientId||q.get('redirect_uri')!==item.redirect||
           q.get('grant_type')!=='authorization_code'){
          send(res,400,JSON.stringify({error:'invalid_grant'}),{'content-type':'application/json',
            'access-control-allow-origin':base});return;
        }
        const verifier=q.get('code_verifier')??'';
        const computed=createHash('sha256').update(verifier).digest('base64url');
        if(computed!==item.challenge){
          send(res,400,JSON.stringify({error:'invalid_grant'}),{'content-type':'application/json',
            'access-control-allow-origin':base});return;
        }
        const token=await new SignJWT({roles:['owner'],tenantId:'studio-b'})
          .setProtectedHeader({alg:'RS256',kid:publicJwk.kid})
          .setIssuer(issuer).setAudience(audience).setSubject(item.subject)
          .setIssuedAt().setExpirationTime('10m').sign(privateKey);
        send(res,200,JSON.stringify({access_token:token,token_type:'Bearer',expires_in:600}),
          {'content-type':'application/json','access-control-allow-origin':base});return;
      }
      send(res,404,'Not found');
    }catch{send(res,500,'Test identity provider failure');}
  });
}
async function readyUrl(url,timeoutMs=45000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});if(r.ok)return;}catch{}
    await pause(250);
  }
  throw Error('Timed out starting isolated browser integration server: '+url);
}
async function login(page,subject) {
  await page.getByRole('button',{name:'Sign in securely'}).click();
  await page.getByRole('button',{
    name:subject==='a-reviewer'?'Reviewer test identity':'Operator test identity'
  }).click();
  await page.getByText('Signed in with an external OIDC provider.',{exact:false})
    .waitFor({state:'visible',timeout:12000});
}
try{
  idp=startIdp();
  await new Promise((resolve,reject)=>{idp.once('error',reject);idp.listen(3999,'localhost',resolve);});
  await api.listen({host:'127.0.0.1',port:3998});
  vite=spawn('npm',['run','dev:api','--workspace','@scopehatch/web','--','--host','127.0.0.1','--port','4173'],
    {cwd:process.cwd(),env:{
      ...process.env,VITE_SCOPEHATCH_DEMO:'false',
      VITE_OIDC_CLIENT_ID:clientId,
      VITE_OIDC_AUTHORIZATION_ENDPOINT:issuer+'authorize',
      VITE_OIDC_TOKEN_ENDPOINT:issuer+'token',
      SCOPEHATCH_API_UPSTREAM:'http://127.0.0.1:3998'
    },stdio:['ignore','pipe','pipe']});
  let viteOutput='';
  vite.stderr.on('data',b=>{viteOutput=(viteOutput+b.toString()).slice(-1500);});
  vite.stdout.on('data',b=>{viteOutput=(viteOutput+b.toString()).slice(-1500);});
  await readyUrl(base+'/');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  try{
    await page.goto(base+'/');
    await login(page,'a-operator');
    await page.getByRole('button',{name:/New brief/}).click();
    const title='OIDC browser integration '+randomUUID();
    await page.getByLabel('Project title').fill(title);
    await page.getByLabel('Original client brief').fill('Please deliver two images');
    await page.getByRole('button',{name:/Create project/}).click();
    await page.getByRole('heading',{name:title}).waitFor({state:'visible'});
    const descriptor=await page.locator('.workspace-intro .overline').innerText();
    const projectId=descriptor.replace(/^PROJECT\s*\/\s*/i,'').trim();
    if(!/^[0-9a-f-]{36}$/i.test(projectId))
      throw Error('Could not identify created PostgreSQL project from UI: '+descriptor);
    await page.getByRole('button',{name:/Add deliverable/}).click();
    await page.getByLabel('Catalog service').last().selectOption('render');
    await page.getByRole('spinbutton',{name:'Quantity'}).fill('2');
    await page.getByLabel('Evidence type').last().selectOption('brief');
    await page.getByRole('textbox',{name:'Exact brief excerpt'}).fill('two images');
    await page.getByRole('button',{name:/Save first scope & estimate/}).click();
    await page.getByText('Ready for review',{exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:/Request review/}).click();
    await page.getByText('Pending review',{exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:'Sign out'}).click();
    await login(page,'a-reviewer');
    await page.getByRole('textbox',{name:'Project ID'}).fill(projectId);
    await page.getByRole('button',{name:'Open project by ID'}).click();
    try {
      await page.getByRole('heading',{name:title}).waitFor({state:'visible',timeout:10000});
    } catch(error) {
      // Diagnostic prints UI error state only, never browser token or source text.
      process.stderr.write('REVIEWER_UI_DIAGNOSTIC: '+
        (await page.locator('#main-content').innerText()).slice(0,900).replace(/\\n/g,' ')+'\\n');
      throw error;
    }
    await page.getByRole('button',{name:/Approve exact revision/}).click();
    await page.getByText('Approved',{exact:true}).waitFor({state:'visible'});
    await page.getByRole('button',{name:/Preview approved draft/}).click();
    await page.getByText('READ-ONLY · r1').waitFor({state:'visible'});
    const result=await page.locator('.proposal-preview pre').innerText();
    if(!result.includes('Approved by: a-reviewer')||!result.includes('400000'))
      throw Error('Actual approved quote did not reach Vue browser');
    await page.getByRole('button',{name:'Sign out'}).click();
    await login(page,'a-operator');
    await page.getByRole('textbox',{name:'Project ID'}).fill(projectId);
    await page.getByRole('button',{name:'Open project by ID'}).click();
    await page.getByRole('spinbutton',{name:'Quantity'}).fill('3');
    await page.getByLabel('Evidence type').last().selectOption('manual');
    await page.getByRole('textbox',{name:'Reason for manual entry'}).fill('Operator correction to 3 images');
    await page.getByRole('button',{name:/Save new revision & estimate/}).click();
    await page.getByText('Prior review superseded',{exact:true}).waitFor({state:'visible'});
    if(!(await page.getByRole('button',{name:/Preview approved draft/}).isDisabled()))
      throw Error('New revision improperly inherited the prior approval');
    const state=await pool.query(
      'SELECT count(*)::int AS n FROM scopehatch.scope_revisions WHERE tenant_id=$1 AND project_id=$2',
      ['studio-a',projectId]);
    if(state.rows[0]?.n!==2)throw Error('Browser workflow did not persist both scope revisions');
    process.stdout.write('PASS signed browser PKCE -> PostgreSQL tenant A -> two actors -> exact export -> superseded revision\n');
  }finally{await page.close();}
  const malicious=await browser.newPage();
  try {
    await malicious.goto(base+'/?code=attacker&state=forged');
    await malicious.getByText('Unsolicited or expired authorization response.',{exact:false})
      .waitFor({state:'visible'});
    process.stdout.write('PASS unsolicited OIDC callback failed closed\n');
  }finally{await malicious.close();}
}finally{
  await browser?.close();
  if(vite){vite.kill('SIGTERM');await pause(350);}
  await api.close();
  if(idp)await new Promise(resolve=>idp.close(resolve));
  await pool.end();
}
