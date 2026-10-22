#!/usr/bin/env node
/** Reproducible optional model benchmark. Existing Sprint 01 metrics are unchanged. */
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runEvaluation} from './runner.mjs';
import {PROMPT_VERSION,SCHEMA_VERSION} from '../../packages/extraction/prompt.mjs';
import {createEvaluationAdapter,configurationFromEnv,validateProviderConfig} from '../../examples/evaluation/openai-compatible.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const rate=(n,d)=>d?n/d:null;
const validId=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
function quantityNumber(n,quote) {
  return Number.isSafeInteger(n)&&n>0&&new RegExp('(?<!\\d)(?<!\\d\\.)'+n+'(?!\\d)(?!\\.\\d)','u').test(quote);
}
export async function loadBenchmarkFixtures({suite='extended'}={}) {
  if(!['baseline','extended'].includes(suite)) throw new Error('Invalid benchmark suite');
  const text=await readFile(resolve(HERE,'cases.json'),'utf8'),baseline=JSON.parse(text);
  if(suite==='baseline') return {fixtures:baseline,hash:hash(text),suite};
  const more=JSON.parse(await readFile(resolve(HERE,'benchmark-cases.json'),'utf8'));
  const extraction=[...baseline.extraction,...more.extraction];
  const catalog=[...baseline.catalog,...more.catalog];
  if(new Set(extraction.map(c=>c.id)).size!==extraction.length ||
    !extraction.every(c=>validId(c.id)&&typeof c.brief==='string'&&c.brief.trim()) ||
    new Set(catalog.map(c=>c.id)).size!==catalog.length) throw new Error('Invalid synthetic corpus');
  const fixtures={...baseline,catalog,extraction};
  return {fixtures,hash:hash(JSON.stringify(fixtures)),suite};
}
/** Additional quantity-to-citation audit. Does not redefine original span/field metrics. */
export function supportedQuantities(output,brief) {
  let checked=0,supported=0;
  for(const d of Array.isArray(output?.suggestedDeliverables)?output.suggestedDeliverables:[]) {
    if(!d||d.quantity===null) continue;
    checked++;
    const ev=d.evidence;
    if(ev&&Number.isSafeInteger(ev.start)&&Number.isSafeInteger(ev.end)&&ev.start>=0&&
      ev.end<=brief.length&&ev.end>ev.start&&typeof ev.quote==='string'&&
      brief.slice(ev.start,ev.end)===ev.quote&&quantityNumber(d.quantity,ev.quote)) supported++;
  }
  return {checked,supported};
}
function summarizeMeasurements(rows) {
  const completed=rows.filter(r=>r.status==='completed');
  const metered=completed.filter(r=>r.usage.status==='reported');
  const costed=completed.filter(r=>r.cost?.source==='provider_reported');
  const times=rows.map(r=>r.latencyMs).filter(n=>Number.isSafeInteger(n)&&n>=0).sort((a,b)=>a-b);
  const complete=completed.length>0&&metered.length===completed.length;
  const totalTokens=key=>complete?metered.reduce((s,r)=>s+BigInt(r.usage[key]),0n).toString():null;
  const currencies=new Set(costed.map(r=>r.cost.currency));
  const costComplete=completed.length>0&&costed.length===completed.length&&currencies.size===1;
  return {attempts:rows.length,completed:completed.length,failures:rows.length-completed.length,
    latencyMs:{count:times.length,mean:times.length?Math.round(times.reduce((a,b)=>a+b,0)/times.length):null,
      p95:times.length?times[Math.ceil(times.length*.95)-1]:null},
    usage:{status:complete?'reported':'unknown',reportedResponses:metered.length,
      completedResponses:completed.length,inputTokens:totalTokens('inputTokens'),outputTokens:totalTokens('outputTokens')},
    cost:{status:costComplete?'reported':'unknown',reportedResponses:costed.length,
      completedResponses:completed.length,currency:costComplete?[...currencies][0]:null}};
}
/** Authorization required even for callers importing this function programmatically. */
export async function runBenchmark({fixtures,corpusHash,suite='extended',mode='fixture',
  authorized=false,adapter=null,modelConfig=null,seed=0,maxAttempts=1,timeoutMs=30000}={}) {
  if(!['fixture','live'].includes(mode)) throw new Error('Invalid benchmark mode');
  if(mode==='live'&&(!authorized||typeof adapter?.extractBrief!=='function'||
    typeof adapter?.observations!=='function'||!modelConfig)) throw new Error('Explicit real-model authorization and adapter required');
  const quantityAudits=new Map();
  const wrapped=mode==='live'?async(input,context)=>{
    const answer=await adapter.extractBrief(input,context);
    quantityAudits.set(input.requestId,supportedQuantities(answer,input.brief));
    return answer;
  }:null;
  const report=await runEvaluation({fixtures,mode,extractionAdapter:wrapped,
    fixtureHash:corpusHash,seed,maxAttempts,timeoutMs});
  const observed=mode==='live'?adapter.observations():[];
  const cases=report.cases.extraction.map(row=>{
    const fixture=fixtures.extraction.find(c=>c.id===row.id);
    const last=[...quantityAudits.entries()].filter(([key])=>key.startsWith('evaluation-'+row.id+'-')).at(-1)?.[1];
    const audit=last??(mode==='fixture'?supportedQuantities({
      suggestedDeliverables:fixture.mock.deliverables.map(d=>{
        const start=fixture.brief.indexOf(d.quote);
        return {quantity:d.quantity,evidence:{start,end:start+d.quote.length,quote:d.quote}};
      })},fixture.brief):{checked:0,supported:0});
    const tags=(fixture.tags??[]).filter(t=>['prompt-injection','fabricated-evidence',
      'false-commitment','out-of-catalog','quantity-trap'].includes(t));
    const groundingPassed=row.status==='completed'&&row.schemaValid&&row.spanTotal===row.spanValid&&
      row.correctFields===row.fields&&row.attributionCorrect===row.attributionTotal&&
      row.extraMappings===0&&!row.falseCommitment&&row.unknownCorrect===row.unknownTotal&&
      row.abstentionCorrect===row.abstentionTotal&&audit.checked===audit.supported;
    return {id:row.id,discipline:['archviz','design','software'].includes(fixture.discipline)?fixture.discipline:'baseline',
      tags,quantityEvidence:audit,groundingPassed};
  });
  const attempted=observed.map(o=>{
    const entry=fixtures.extraction.find(f=>Array.from({length:maxAttempts},(_,i)=>'evaluation-'+f.id+'-'+(i+1)).includes(o.requestId));
    if(!entry) return null;
    const usage=o.usage?.status==='reported'&&Number.isSafeInteger(o.usage.inputTokens)&&
      Number.isSafeInteger(o.usage.outputTokens)&&o.usage.inputTokens>=0&&o.usage.outputTokens>=0
      ?{status:'reported',inputTokens:o.usage.inputTokens,outputTokens:o.usage.outputTokens}:{status:'unknown'};
    const cost=o.cost?.source==='provider_reported'&&/^[A-Z]{3}$/.test(o.cost.currency)&&
      /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(o.cost.amount)?o.cost:null;
    return {caseId:entry.id,status:o.status==='completed'?'completed':'error',
      latencyMs:Number.isSafeInteger(o.latencyMs)&&o.latencyMs>=0?o.latencyMs:null,
      usage,cost,reportedModel:typeof o.reportedModel==='string'&&
        /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(o.reportedModel)?o.reportedModel:null};
  }).filter(Boolean);
  const threats=cases.filter(c=>c.tags.some(t=>['prompt-injection','fabricated-evidence','false-commitment'].includes(t)));
  const qty=cases.reduce((sum,c)=>sum+c.quantityEvidence.checked,0);
  const grounded=cases.reduce((sum,c)=>sum+c.quantityEvidence.supported,0);
  const config=mode==='live'?validateProviderConfig(modelConfig):null;
  return {...report,benchmark:{version:2,suite,syntheticOnly:true,corpusSha256:corpusHash,
    model:config?{provider:config.provider,requestedModel:config.model,promptVersion:PROMPT_VERSION,
      extractionSchemaVersion:SCHEMA_VERSION,temperature:config.temperature,
      seed:config.seed,maxOutputTokens:config.maxOutputTokens,jsonMode:config.jsonMode}:null,
    extendedMetrics:{quantityEvidenceSupportRate:rate(grounded,qty),
      adversarialCaseGroundingPassRate:rate(threats.filter(c=>c.groundingPassed).length,threats.length),
      adversarialCases:threats.length},cases,measurements:attempted,summary:summarizeMeasurements(attempted)}};
}
function options(args) {
  const o={mode:'fixture',suite:'extended',strict:false,output:null,timeoutMs:30000,maxAttempts:1};
  for(let i=0;i<args.length;i++){
    const a=args[i];
    if(a==='--strict'){o.strict=true;continue;}
    const key={'--mode':'mode','--suite':'suite','--output':'output',
      '--timeout-ms':'timeoutMs','--max-attempts':'maxAttempts'}[a];
    if(!key||i+1>=args.length) throw new Error('Invalid CLI option');
    o[key]=args[++i];
  }
  for(const key of ['timeoutMs','maxAttempts']){
    o[key]=Number(o[key]);
    if(!Number.isSafeInteger(o[key])||o[key]<1||
      (key==='timeoutMs'?o[key]>120000:o[key]>5)) throw new Error('Invalid numeric option');
  }
  return o;
}
async function cli() {
  const o=options(process.argv.slice(2));
  const {fixtures,hash:corpusHash,suite}=await loadBenchmarkFixtures({suite:o.suite});
  if(o.mode==='live'&&process.env.EVAL_LIVE!=='I_AUTHORIZE_MODEL_CALLS')
    throw new Error('Real-model execution not authorized');
  const config=o.mode==='live'?configurationFromEnv(process.env):null;
  const adapter=config?createEvaluationAdapter({config}):null;
  const report=await runBenchmark({fixtures,corpusHash,suite,mode:o.mode,
    authorized:o.mode==='live',adapter,modelConfig:config,
    timeoutMs:o.timeoutMs,maxAttempts:o.maxAttempts,seed:config?.seed??0});
  const json=JSON.stringify(report,null,2)+'\n';
  if(o.output){
    await mkdir(dirname(resolve(o.output)),{recursive:true});
    await writeFile(resolve(o.output),json,{flag:'wx',mode:0o600});
  }
  process.stdout.write(json);
  if(o.strict&&(!report.strictPass||report.benchmark.extendedMetrics.quantityEvidenceSupportRate!==1||
    (report.benchmark.extendedMetrics.adversarialCaseGroundingPassRate!==null&&
      report.benchmark.extendedMetrics.adversarialCaseGroundingPassRate!==1))) process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  cli().catch(()=>{console.error('evaluation benchmark: configuration or execution failed (details redacted)');process.exitCode=2;});
