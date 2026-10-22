import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, createScopeRevision, estimateScope, submitReview, approveReview, exportProposal } from '../src/domain.mjs';

const author = { id: 'alice', tenantId: 'studio-a', roles: ['owner'] };
const reviewer = { id: 'bob', tenantId: 'studio-a', roles: ['reviewer'] };
const catalog = createCatalog({
  tenantId: 'studio-a', currency: 'USD', version: 1,
  services: [{ id: 'render', label: 'Architectural render', unitPriceMinor: 18000 }]
});
const scope = createScopeRevision({
  tenantId: 'studio-a', projectId: 'p-1', revision: 1, authorId: 'alice',
  brief: '4 exterior renders, please.',
  deliverables: [{ serviceId: 'render', quantity: 4, evidence: '4 exterior renders' }]
});
const quote = estimateScope(scope, catalog);
const review = submitReview({ scope, estimate: quote, actor: author });

test('catalog quote uses integer arithmetic only', () => {
  assert.equal(quote.state, 'ready');
  assert.equal(quote.totalMinor, 72000);
});

test('approved exact revision can be exported', () => {
  const approved = approveReview({ scope, estimate: quote, review, actor: reviewer });
  assert.match(exportProposal({ scope, estimate: quote, review: approved }).markdown, /72000/);
});

test('missing quantities and unknown requirements block review', () => {
  const incomplete = createScopeRevision({
    ...scope, revision: 2, unknowns: ['revision count'],
    deliverables: [{ serviceId: 'render', quantity: null, evidence: '' }]
  });
  const result = estimateScope(incomplete, catalog);
  assert.equal(result.totalMinor, null);
  assert.equal(result.state, 'blocked');
  assert.throws(() => submitReview({ scope: incomplete, estimate: result, actor: author }),
    { code: 'BLOCKED_ESTIMATE' });
});

test('never price from model-suggested unknown service', () => {
  const changed = createScopeRevision({
    ...scope, revision: 2,
    deliverables: [{ serviceId: 'premium-from-model', quantity: 5, evidence: '' }]
  });
  assert.deepEqual(estimateScope(changed, catalog).blockers.map(b => b.code),
    ['UNPRICED_SERVICE', 'MISSING_EVIDENCE']);
});

test('catalog of another tenant is rejected', () => {
  assert.throws(() => estimateScope({ ...scope, tenantId: 'studio-b' }, catalog),
    { code: 'TENANT_MISMATCH' });
  assert.throws(() => approveReview({
    scope, estimate: quote, review, actor: { ...reviewer, tenantId: 'studio-b' }
  }), { code: 'TENANT_MISMATCH' });
});

test('self-approval and missing reviewer permissions fail', () => {
  assert.throws(() => approveReview({ scope, estimate: quote, review, actor: author }),
    { code: 'SELF_APPROVAL' });
  assert.throws(() => approveReview({
    scope, estimate: quote, review,
    actor: { id: 'guest', tenantId: 'studio-a', roles: [] }
  }), { code: 'FORBIDDEN' });
});

test('revision changes invalidate quote and approval', () => {
  const next = createScopeRevision({ ...scope, revision: 2 });
  const approved = approveReview({ scope, estimate: quote, review, actor: reviewer });
  assert.throws(() => exportProposal({ scope: next, estimate: quote, review: approved }),
    { code: 'STALE_ESTIMATE' });
});

test('duplicate service, invalid quantity and integer overflow fail', () => {
  assert.throws(() => createCatalog({ ...catalog, services: [...catalog.services, ...catalog.services] }),
    { code: 'DUPLICATE_SERVICE' });
  assert.throws(() => createScopeRevision({
    ...scope, deliverables: [{ serviceId: 'render', quantity: 0, evidence: 'x' }]
  }), { code: 'INVALID_INPUT' });
  const large = createCatalog({
    tenantId: 'studio-a', currency: 'USD', version: 2,
    services: [{ id: 'render', label: 'Architectural render', unitPriceMinor: Number.MAX_SAFE_INTEGER }]
  });
  assert.throws(() => estimateScope(scope, large), { code: 'MONEY_OVERFLOW' });
});


test('legacy scope normalizes immutable proposal and client descriptions', () => {
  assert.deepEqual(scope.proposal, {overview:'', assumptions:[], exclusions:[], commercialTerms:[]});
  assert.equal(scope.deliverables[0].clientDescription, '');
  assert.ok(Object.isFrozen(scope.proposal) && Object.isFrozen(scope.proposal.assumptions));
  assert.ok(Object.isFrozen(scope.deliverables[0]));
  assert.throws(() => { scope.proposal.assumptions.push('new term'); }, TypeError);
});

test('proposal metadata is exact, human-authored, ordered and deeply immutable', () => {
  const source = { overview: 'Architectural visualization', assumptions: ['  Model supplied  ', 'Scale approved'],
    exclusions: ['Animation'], commercialTerms: ['30-day validity'] };
  const changed = createScopeRevision({...scope, revision:2, proposal:source,
    deliverables:[{...scope.deliverables[0], clientDescription:'Two client-approved angles'}]});
  source.assumptions.push('Injected later');
  assert.deepEqual(changed.proposal, {overview:'Architectural visualization',
    assumptions:['Model supplied','Scale approved'], exclusions:['Animation'],
    commercialTerms:['30-day validity']});
  assert.equal(changed.deliverables[0].clientDescription, 'Two client-approved angles');
  assert.ok(Object.isFrozen(changed.proposal.commercialTerms));
  assert.notEqual(changed.proposal, source);
  const changedEstimate = estimateScope(changed, catalog);
  assert.equal(changedEstimate.totalMinor, quote.totalMinor);
  assert.deepEqual(changedEstimate.lines, quote.lines);
  assert.throws(() => exportProposal({scope:changed, estimate:quote, review:approveReview({
    scope, estimate:quote, review, actor:reviewer})}), {code:'STALE_ESTIMATE'});
});

test('rejects blank entries, invalid lengths and oversized serialized metadata', () => {
  for (const proposal of [
    {assumptions:['  ']}, {exclusions:['x'.repeat(2001)]},
    {overview:'x'.repeat(4001)}, {commercialTerms:Array(51).fill('ok')},
    {priceMinor:1}, {assumptions:[null]}
  ]) assert.throws(() => createScopeRevision({...scope,proposal}), {code:'INVALID_INPUT'});
  assert.throws(() => createScopeRevision({...scope,
    deliverables:[{...scope.deliverables[0],clientDescription:'x'.repeat(2001)}]}),
  {code:'INVALID_INPUT'});
  assert.throws(() => createScopeRevision({...scope,
    proposal:{assumptions:Array(50).fill('x'.repeat(1700))}}), {code:'INVALID_INPUT'});
});

test('renders HTML-escaped, Markdown-inert human text, with honest unsigned status', () => {
  const malicious = createScopeRevision({...scope, revision:2,
    proposal:{overview:'<img src=x onerror=alert(1)> ![remote](https://host/x)',
      assumptions:['<script>evil</script>'], exclusions:['## Header'],
      commercialTerms:['Price is $0 <iframe src=x>']},
    deliverables:[{...scope.deliverables[0],clientDescription:'**Click** <b>bold</b>'}]});
  const priced = estimateScope(malicious,catalog);
  const pending = submitReview({scope:malicious,estimate:priced,actor:author});
  const approved = approveReview({scope:malicious,estimate:priced,review:pending,actor:reviewer});
  const output = exportProposal({scope:malicious,estimate:priced,review:approved,catalog});
  assert.equal(output.totalMinor,72000);
  assert.equal(output.proposal.overview, malicious.proposal.overview);
  assert.match(output.markdown,/Unsigned proposal draft/);
  assert.match(output.markdown,/Architectural render/);
  assert.match(output.markdown,/Description:/);
  assert.match(output.markdown,/## Assumptions/);
  assert.match(output.markdown,/## Exclusions/);
  assert.match(output.markdown,/## Commercial terms/);
  assert.doesNotMatch(output.markdown, /<img|<script|<iframe|<b>/);
  assert.doesNotMatch(output.markdown, /!\[remote\]/);
  assert.match(output.markdown, /&lt;img/);
  assert.match(output.markdown, /\\!\\\[remote\\\]/);
  assert.match(output.markdown, /not a signed quotation/i);
});

test('uses ISO 4217 fractional digits with BigInt, never floating point currency math', async () => {
  const {formatMoneyMinor} = await import('../src/domain.mjs');
  assert.equal(formatMoneyMinor(12345,'USD'),'USD 123.45');
  assert.equal(formatMoneyMinor(12345,'JPY'),'JPY 12,345');
  assert.equal(formatMoneyMinor(12345,'KWD'),'KWD 12.345');
  assert.equal(formatMoneyMinor(Number.MAX_SAFE_INTEGER,'USD'),
    'USD 90,071,992,547,409.91');
  assert.throws(() => formatMoneyMinor(1,'ZZZ'), {code:'INVALID_INPUT'});
  assert.throws(() => createCatalog({...catalog,currency:'ZZZ'}), {code:'INVALID_INPUT'});
  assert.throws(() => formatMoneyMinor(0.5,'USD'), {code:'INVALID_INPUT'});
});

test('a new catalog version or scope revision makes old approvals ineligible', () => {
  const approved = approveReview({scope,estimate:quote,review,actor:reviewer});
  const nextCatalog = createCatalog({...catalog,version:2});
  assert.throws(() => exportProposal({scope,estimate:quote,review:approved,
    currentCatalogVersion:nextCatalog.version}), {code:'STALE_REVISION'});
  assert.throws(() => submitReview({scope,estimate:quote,actor:author,
    currentScopeRevision:2}), {code:'STALE_REVISION'});
  assert.throws(() => approveReview({scope,estimate:quote,review,actor:reviewer,
    currentCatalogVersion:2}), {code:'STALE_REVISION'});
  assert.throws(() => exportProposal({scope,estimate:quote,review:approved,
    currentScopeRevision:2}), {code:'STALE_REVISION'});
  assert.throws(() => exportProposal({scope,estimate:quote,review:approved,
    catalog:nextCatalog}), {code:'STALE_REVISION'});
});

test('unknown quantity, missing evidence and unknown service never export', () => {
  const missingEvidence = createScopeRevision({...scope,revision:2,
    deliverables:[{serviceId:'render', quantity:3, evidence:'',source:'brief'}]});
  assert.equal(estimateScope(missingEvidence,catalog).state,'blocked');
  for (const d of [
    {serviceId:'render',quantity:null,evidence:'unknown',source:'manual'},
    {serviceId:'model-added',quantity:3,evidence:'text',source:'manual'}
  ]) {
    const candidate=createScopeRevision({...scope,revision:2,deliverables:[d]});
    const estimated=estimateScope(candidate,catalog);
    assert.equal(estimated.state,'blocked');
    assert.throws(() => exportProposal({scope:candidate,estimate:estimated,review:{...review,state:'approved',approvedBy:'bob'}}),
      {code:'APPROVAL_REQUIRED'});
  }
});

test('forged estimate arithmetic, tenant catalog and reviewer separation are denied', () => {
  const approved = approveReview({scope,estimate:quote,review,actor:reviewer});
  assert.throws(() => exportProposal({scope,estimate:{...quote,totalMinor:72001},
    review:approved}), {code:'STALE_ESTIMATE'});
  assert.throws(() => exportProposal({scope,estimate:{...quote,
    lines:[{...quote.lines[0],unitPriceMinor:1}]},review:approved}),
    {code:'STALE_ESTIMATE'});
  assert.throws(() => exportProposal({scope,estimate:quote,review:approved,
    catalog:createCatalog({...catalog,tenantId:'studio-b'})}), {code:'STALE_REVISION'});
  assert.throws(() => exportProposal({scope,estimate:quote,
    review:{...approved,approvedBy:'alice'}}), {code:'APPROVAL_REQUIRED'});
  assert.throws(() => approveReview({scope,estimate:quote,review:{...review,submittedBy:'mallory'},
    actor:reviewer}), {code:'STALE_REVIEW'});
  assert.throws(() => createScopeRevision({...scope,deliverables:[
    {...scope.deliverables[0],source:'model'}]}), {code:'INVALID_INPUT'});
});

test('zero-priced catalog rates are valid but overflowing totals never produce a quote', () => {
  const free = createCatalog({...catalog,services:[{id:'render',label:'Render',unitPriceMinor:0}]});
  assert.equal(estimateScope(scope,free).totalMinor,0);
  const near = createCatalog({...catalog,services:[
    {id:'render',label:'Render',unitPriceMinor:Number.MAX_SAFE_INTEGER}
  ]});
  const two = createScopeRevision({...scope,deliverables:[
    {serviceId:'render',quantity:1,evidence:'first'},
    {serviceId:'render',quantity:1,evidence:'second'}
  ]});
  assert.throws(() => estimateScope(two,near), {code:'MONEY_OVERFLOW'});
});
