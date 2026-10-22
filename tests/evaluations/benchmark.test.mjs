import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {loadBenchmarkFixtures,runBenchmark,supportedQuantities} from './benchmark.mjs';
import {createEvaluationAdapter,validateProviderConfig} from '../../examples/evaluation/openai-compatible.mjs';
import {inspectSuggestion} from './runner.mjs';

const config={provider:'ollama',endpoint:'http://127.0.0.1:11434/v1/chat/completions',
  model:'synthetic-mock',allowedHosts:['127.0.0.1'],temperature:0,seed:7,maxOutputTokens:1200};
const mock=(brief,id,quantity,quote)=>{
  const start=brief.indexOf(quote);
  return {suggestedDeliverables:[{serviceId:id,quantity,evidence:{start,end:start+quote.length,quote}}],
    unknowns:['revision count']};
};
const response=(answer,usage=null)=>new Response(JSON.stringify({
  model:'synthetic-mock-r2',choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}],
  ...(usage?{usage}:{})}),{headers:{'content-type':'application/json'}});

test('synthetic extended fixture corpus is uniquely labeled; no real model claim',async()=>{
  const {fixtures,hash}=await loadBenchmarkFixtures();
  assert.match(hash,/^[a-f0-9]{64}$/);
  assert.equal(new Set(fixtures.extraction.map(c=>c.id)).size,fixtures.extraction.length);
  for(const discipline of ['archviz','design','software'])
    assert.ok(fixtures.extraction.some(c=>c.discipline===discipline));
  assert.ok(fixtures.extraction.filter(c=>c.tags?.includes('prompt-injection')).length>=3);
  for(const c of fixtures.extraction) for(const d of c.mock.deliverables) assert.ok(c.brief.includes(d.quote),c.id);
  const report=await runBenchmark({fixtures,corpusHash:hash});
  assert.equal(report.strictPass,true);
  assert.equal(report.execution.evidenceClass,'deterministic_fixture_conformance_only');
  assert.equal(report.benchmark.summary.attempts,0);
  assert.equal(report.benchmark.summary.usage.status,'unknown');
  assert.equal(report.benchmark.summary.usage.inputTokens,null);
  assert.equal(report.benchmark.extendedMetrics.quantityEvidenceSupportRate,1);
  assert.equal(report.benchmark.extendedMetrics.adversarialCaseGroundingPassRate,1);
  assert.equal(report.benchmark.model,null);
  assert.ok(!JSON.stringify(report).includes('SYSTEM:'));
});
test('unrelated numeric value does not ground quantity',()=>{
  const brief='The input model has 24 revisions. We need exterior renders.';
  const answer=mock(brief,'exterior-render',24,'exterior renders');
  assert.deepEqual(supportedQuantities(answer,brief),{checked:1,supported:0});
  answer.suggestedDeliverables[0].quantity=null;
  assert.deepEqual(supportedQuantities(answer,brief),{checked:0,supported:0});
});
test('mock real-model transport requires opt-in and retains only reported metering',async()=>{
  const {fixtures,hash}=await loadBenchmarkFixtures({suite:'baseline'});
  const c=fixtures.extraction.find(c=>c.id==='known-interior');
  let sent;
  const adapter=createEvaluationAdapter({config:{...config,apiKey:'private-test-key'},
    fetchImpl:async(url,opts)=>{
      sent=opts;
      const request=JSON.parse(JSON.parse(opts.body).messages[1].content);
      return response(mock(request.brief,'interior-render',12,'12 interior images'),
        {prompt_tokens:100,completion_tokens:15,cost:'0.003',currency:'USD'});
    }});
  const subset={...fixtures,extraction:[c]};
  await assert.rejects(runBenchmark({fixtures:subset,corpusHash:hash,mode:'live',adapter,modelConfig:config}),/authorization/);
  const report=await runBenchmark({fixtures:subset,corpusHash:hash,mode:'live',authorized:true,
    adapter,modelConfig:config});
  assert.equal(sent.redirect,'error');
  assert.equal(sent.headers.authorization,'Bearer private-test-key');
  assert.equal(report.metrics.adapterFailureCount,0);
  assert.equal(report.benchmark.summary.usage.status,'reported');
  assert.equal(report.benchmark.summary.usage.inputTokens,'100');
  assert.equal(report.benchmark.summary.cost.status,'reported');
  assert.equal(report.benchmark.measurements[0].cost.amount,'0.003');
  assert.equal(report.benchmark.measurements[0].cost.source,'provider_reported');
  assert.equal(report.benchmark.cases[0].quantityEvidence.supported,1);
  assert.ok(!JSON.stringify(report).includes('private-test-key'));
  assert.ok(!JSON.stringify(report).includes('Please deliver 12 interior images'));
});
test('missing and partial token metering are unknown, not measured zero',async()=>{
  const {fixtures,hash}=await loadBenchmarkFixtures({suite:'baseline'});
  const c=fixtures.extraction.find(c=>c.id==='known-interior');
  const adapter=createEvaluationAdapter({config,fetchImpl:async()=>
    response(mock(c.brief,'interior-render',12,'12 interior images'),{prompt_tokens:50})});
  const report=await runBenchmark({fixtures:{...fixtures,extraction:[c]},corpusHash:hash,mode:'live',
    authorized:true,adapter,modelConfig:config});
  assert.equal(report.benchmark.summary.usage.status,'unknown');
  assert.equal(report.benchmark.summary.usage.inputTokens,null);
  assert.equal(report.benchmark.summary.cost.status,'unknown');
  assert.deepEqual(report.benchmark.measurements[0].usage,{status:'unknown'});
});
test('malicious model price and approval fields fail established scorer',async()=>{
  const {fixtures,hash}=await loadBenchmarkFixtures({suite:'baseline'});
  const c=fixtures.extraction.find(c=>c.id==='injected-approval-price');
  const adapter=createEvaluationAdapter({config,fetchImpl:async()=>
    response({...mock(c.brief,'exterior-render',3,'3 exterior images'),totalMinor:1,approved:true})});
  const report=await runBenchmark({fixtures:{...fixtures,extraction:[c]},corpusHash:hash,
    mode:'live',authorized:true,adapter,modelConfig:config});
  assert.equal(report.metrics.falseCommitmentRate,1);
  assert.equal(report.metrics.schemaValidationPassRate,0);
  assert.equal(report.strictPass,false);
});
test('endpoint validation rejects cleartext remote, URL secrets and unauthorized hosts',()=>{
  for(const configBad of [
    {...config,endpoint:'http://example.com/v1/chat/completions',allowedHosts:['example.com']},
    {...config,endpoint:'http://127.0.0.1:11434/v1/chat/completions?api_key=x'},
    {...config,endpoint:'http://127.0.0.1:11434/v1/chat/completions#frag'},
    {...config,endpoint:'https://key:pass@example.com/v1/chat/completions',allowedHosts:['example.com']},
    {...config,allowedHosts:[]},{...config,model:''},{...config,provider:'other'}
  ]) assert.throws(()=>validateProviderConfig(configBad),{code:'INVALID_PROVIDER_CONFIG'});
  assert.equal(validateProviderConfig({...config,endpoint:'https://models.example/v1/chat/completions',
    allowedHosts:['models.example']}).provider,'ollama');
});
test('live CLI rejects unapproved execution before contacting any provider',()=>{
  const cwd=dirname(fileURLToPath(import.meta.url));
  const result=spawnSync(process.execPath,[resolve(cwd,'benchmark.mjs'),'--mode','live'],{
    env:{...process.env,EVAL_LIVE:'',EVAL_MODEL_URL:config.endpoint,EVAL_MODEL:'dummy',
      EVAL_PROVIDER:'ollama',EVAL_ALLOWED_HOSTS:'127.0.0.1'},encoding:'utf8'});
  assert.equal(result.status,2);
  assert.match(result.stderr,/redacted/);
  assert.equal(result.stdout,'');
});

test('an unquantified draft may correctly abstain with null evidence',()=>{
  const output={suggestedDeliverables:[{serviceId:'interior-render',quantity:null,evidence:null}],
    unknowns:['quantity'],provider:'ollama',model:'synthetic-mock',usage:{status:'unknown'}};
  assert.equal(inspectSuggestion(output,'Render the interior.',new Set(['interior-render'])).schemaValid,true);
  output.suggestedDeliverables[0].quantity=2;
  assert.ok(inspectSuggestion(output,'Render the interior.',new Set(['interior-render'])).issues.includes('invalid_evidence_object'));
});
test('non-2xx and oversize provider replies fail safely without raw response disclosure',async()=>{
  const request={requestId:'fixture',brief:'Render 2 images.',serviceCatalog:[{id:'interior-render',label:'Interior'}]};
  const throttle=createEvaluationAdapter({config,fetchImpl:async()=>new Response('{}',{status:429})});
  await assert.rejects(throttle.extractBrief(request),{code:'RATE_LIMIT'});
  const enormous=createEvaluationAdapter({config,fetchImpl:async()=>new Response('private-data'.repeat(7000))});
  await assert.rejects(enormous.extractBrief(request),{code:'SCHEMA_ERROR'});
  assert.deepEqual(enormous.observations()[0].usage,{status:'unknown'});
  assert.ok(!JSON.stringify(enormous.observations()).includes('private-data'));
});
test('legacy model adapter also refuses unapproved calls',()=>{
  const root=dirname(fileURLToPath(import.meta.url));
  const modulePath=resolve(root,'../../examples/evaluation/openai-compatible.mjs');
  const script="import {extractBrief} from "+JSON.stringify('file://'+modulePath)+
    ";extractBrief({brief:'test',serviceCatalog:[],requestId:'a'},{}).catch(e=>{console.log(e.code)});";
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    env:{...process.env,EVAL_LIVE:''},encoding:'utf8'});
  assert.equal(result.status,0);
  assert.match(result.stdout,/PROVIDER_NOT_AUTHORIZED/);
});
