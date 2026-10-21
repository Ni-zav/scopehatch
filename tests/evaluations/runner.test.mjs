import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {mockExtract,inspectSuggestion,scoreExtraction,attemptWithRetry,runFaultSimulation,runDomainScenario,runEvaluation} from './runner.mjs';
const fixtures=JSON.parse(await readFile(resolve(dirname(fileURLToPath(import.meta.url)),'cases.json'),'utf8'));
const sample=id=>fixtures.extraction.find(c=>c.id===id);
const catalogIds=new Set(fixtures.catalog.map(c=>c.id));

test('golden deterministic fixture suite reports only fixture conformance',async()=>{
  const report=await runEvaluation({fixtures,mode:'fixture',fixtureHash:'test-hash'});
  assert.equal(report.strictPass,true);
  assert.equal(report.execution.evidenceClass,'deterministic_fixture_conformance_only');
  assert.equal(report.metrics.schemaValidationPassRate,1);
  assert.equal(report.metrics.taskCompletionUnderApprovalRules,1);
  assert.equal(report.metrics.falseCommitmentRate,0);
  assert.equal(report.cases.extraction.length,fixtures.extraction.length);
  assert.ok(report.cases.extraction.every(row=>!('brief' in row)&&!('output' in row)));
});

test('UTF-16 offsets are exact, not Unicode codepoint offsets',()=>{
  const c=sample('unicode-offsets'), o=mockExtract(c);
  assert.equal(c.brief.slice(o.suggestedDeliverables[0].evidence.start,o.suggestedDeliverables[0].evidence.end),'2 interior images');
  assert.ok(inspectSuggestion(o,c.brief,catalogIds).schemaValid);
  o.suggestedDeliverables[0].evidence.start-=1;
  assert.ok(inspectSuggestion(o,c.brief,catalogIds).issues.includes('fabricated_or_invalid_evidence_span'));
});

test('schema rejects invented price and fake self approval, regardless of good JSON',()=>{
  const c=sample('injected-approval-price'),o=mockExtract(c);
  o.totalMinor=1;o.approvedBy='model';
  const result=scoreExtraction(c,o,fixtures.catalog);
  assert.equal(result.falseCommitment,true);
  assert.equal(result.schemaValid,false);
});

test('schema rejects fabricated evidence, unsupported services, wrong quantities and polluted usage',()=>{
  const c=sample('known-interior'),o=mockExtract(c);
  o.suggestedDeliverables[0].evidence={start:0,end:8,quote:'fabricate'};
  assert.ok(inspectSuggestion(o,c.brief,catalogIds).issues.includes('fabricated_or_invalid_evidence_span'));
  o.suggestedDeliverables[0].serviceId='tenant-b-secret';
  assert.ok(inspectSuggestion(o,c.brief,catalogIds).issues.includes('noncatalog_service'));
  o.suggestedDeliverables[0].quantity=1.5;
  assert.ok(inspectSuggestion(o,c.brief,catalogIds).issues.includes('invalid_quantity'));
  o.usage={status:'unknown',inputTokens:0};
  assert.ok(inspectSuggestion(o,c.brief,catalogIds).issues.includes('invalid_usage'));
});

test('schema-valid response can still have poor factual extraction and unsupported provenance',()=>{
  const c=sample('known-interior'),o=mockExtract(c);
  o.suggestedDeliverables[0].quantity=99;
  o.suggestedDeliverables[0].evidence={start:0,end:6,quote:c.brief.slice(0,6)};
  assert.equal(inspectSuggestion(o,c.brief,catalogIds).schemaValid,true);
  const scored=scoreExtraction(c,o,fixtures.catalog);
  assert.equal(scored.correctFields,1);
  assert.equal(scored.attributionCorrect,0);
  assert.equal(scored.spanValid,1);
});

test('wrong service mapping and missing abstention both score as errors',()=>{
  const c=sample('unknown-quantity'),o=mockExtract(c);
  o.suggestedDeliverables[0].quantity=1;
  assert.equal(scoreExtraction(c,o,fixtures.catalog).abstentionCorrect,0);
  const other=sample('noncatalog-service'),extra=mockExtract(other);
  extra.suggestedDeliverables.push({serviceId:'exterior-render',quantity:2,evidence:{start:0,end:2,quote:other.brief.slice(0,2)}});
  assert.equal(scoreExtraction(other,extra,fixtures.catalog).extraMappings,1);
});

test('workflow disallows self approval, stale revisions, tenant crossover and invalid rate cards',()=>{
  for(const c of fixtures.workflow) {
    const outcome=runDomainScenario(c);
    assert.equal(outcome.allowed,c.allowed,c.id);
    if(c.allowed) assert.equal(outcome.priceCorrect,true,c.id);
    else assert.equal(outcome.code,c.code,c.id);
  }
});

test('bounded retries recover transient errors but do not retry validation failure',async()=>{
  for(const c of fixtures.faults) assert.equal((await runFaultSimulation(c)).passed,true,c.id);
  let attempts=0;
  const x=await attemptWithRetry(()=>{attempts++;throw Object.assign(new Error('bad'),{code:'SCHEMA_ERROR'});},{maxAttempts:5});
  assert.equal(x.attempts,1);assert.equal(attempts,1);
});

test('live-mode adapter failures become countable, redacted case-level reports',async()=>{
  const isolated={...fixtures,extraction:[sample('known-interior')]};
  const report=await runEvaluation({fixtures:isolated,mode:'live',extractionAdapter:async()=>{throw new Error('secret-token-not-for-report');}});
  assert.equal(report.metrics.adapterFailureCount,1);
  assert.equal(report.strictPass,false);
  assert.equal(JSON.stringify(report).includes('secret-token-not-for-report'),false);
  assert.equal(report.cases.extraction[0].errorCode,'ADAPTER_ERROR');
});
