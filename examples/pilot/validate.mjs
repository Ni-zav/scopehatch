#!/usr/bin/env node
// Synthetic-only schema and domain checks. No network, database, credentials or external packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCatalog, createScopeRevision, estimateScope } from '../../src/domain.mjs';

const input = JSON.parse(readFileSync(fileURLToPath(new URL('./scenarios.json', import.meta.url)), 'utf8'));
assert.equal(input.schemaVersion, 1);
assert.equal(input.syntheticOnly, true);
assert.equal(input.catalog.currency, 'IDR');
assert.equal(input.scenarios.length, 5);
const catalog = createCatalog({
  tenantId: 'synthetic-pilot-only',
  version: 1,
  currency: input.catalog.currency,
  services: input.catalog.services
});
const services = new Set(catalog.services.map(service => service.id));
const ids = new Set();
const disciplines = new Set();

for (const caseFile of input.scenarios) {
  assert.match(caseFile.id, /^(A|D|S)\d{2}$/);
  assert(!ids.has(caseFile.id), 'duplicate scenario id');
  ids.add(caseFile.id);
  assert(['archviz', 'design', 'software'].includes(caseFile.discipline));
  disciplines.add(caseFile.discipline);
  assert(caseFile.title.trim() && caseFile.brief.trim());
  assert(Array.isArray(caseFile.referenceDeliverables) && caseFile.referenceDeliverables.length);
  assert(Array.isArray(caseFile.initialUnknowns));
  assert(Array.isArray(caseFile.checks) && caseFile.checks.length);
  const seen = new Set();
  for (const d of caseFile.referenceDeliverables) {
    assert(services.has(d.serviceId), 'unknown service in ' + caseFile.id);
    assert(!seen.has(d.serviceId), 'duplicate reference service in ' + caseFile.id);
    seen.add(d.serviceId);
    assert.equal(d.source, 'brief');
    assert(d.evidence.trim() && caseFile.brief.includes(d.evidence), 'source span absent from original brief');
    assert(d.quantity === null || (Number.isSafeInteger(d.quantity) && d.quantity > 0));
  }
  const initialScope = createScopeRevision({
    tenantId: catalog.tenantId, projectId: caseFile.id, revision: 1,
    authorId: 'synthetic-operator', brief: caseFile.brief,
    deliverables: caseFile.referenceDeliverables, unknowns: caseFile.initialUnknowns
  });
  const initialEstimate = estimateScope(initialScope, catalog);
  const shouldBlock = Boolean(caseFile.initialUnknowns.length ||
    caseFile.referenceDeliverables.some(d => d.quantity === null));
  assert.equal(initialEstimate.state, shouldBlock ? 'blocked' : 'ready', 'initial state mismatch: ' + caseFile.id);
  assert.equal(initialEstimate.totalMinor === null, shouldBlock, 'null total must match blockers');
  if (caseFile.clarification === null) {
    assert(!shouldBlock, 'blocked scenario needs a synthetic clarification: ' + caseFile.id);
  } else {
    assert(shouldBlock, 'clarification must resolve an initially blocked scenario');
    assert(caseFile.clarification.text.startsWith('Synthetic customer clarification:'));
    const resolved = structuredClone(caseFile.referenceDeliverables);
    const replacements = new Set();
    for (const d of caseFile.clarification.resolutions) {
      assert(services.has(d.serviceId) && d.source === 'manual');
      assert(Number.isSafeInteger(d.quantity) && d.quantity > 0);
      assert(d.evidence.startsWith('Synthetic '), 'manual basis must be labeled synthetic');
      assert(!replacements.has(d.serviceId), 'duplicate manual resolution');
      replacements.add(d.serviceId);
      const at = resolved.findIndex(x => x.serviceId === d.serviceId);
      if (at >= 0) resolved[at] = d;
      else resolved.push(d);
    }
    assert(resolved.every(d => d.quantity !== null), 'clarification left quantity unknown');
    const clarifiedScope = createScopeRevision({
      tenantId: catalog.tenantId, projectId: caseFile.id, revision: 2,
      authorId: 'synthetic-operator', brief: caseFile.brief,
      deliverables: resolved, unknowns: []
    });
    const clarifiedEstimate = estimateScope(clarifiedScope, catalog);
    assert.equal(clarifiedEstimate.state, 'ready', 'clarified scenario must become estimable');
    assert(Number.isSafeInteger(clarifiedEstimate.totalMinor) && clarifiedEstimate.totalMinor >= 0);
  }
  process.stdout.write(caseFile.id + ': validated; initial ' + initialEstimate.state +
    (caseFile.clarification ? ', clarified ready' : '') + '\n');
}
for (const discipline of ['archviz','design','software']) assert(disciplines.has(discipline));
process.stdout.write('Validated exactly 5 synthetic scenarios, referenced evidence spans, catalog mappings and blocker transitions.\n');
