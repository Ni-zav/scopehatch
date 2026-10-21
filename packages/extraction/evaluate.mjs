import { createExtractor, createFixtureProvider } from './index.mjs';
import { golden } from './fixtures/golden.mjs';

/** Fixture replay is a validator smoke check, not a claim about model behavior. */
export async function evaluateFixtures(cases = golden) {
  const extractor = createExtractor({ provider: createFixtureProvider({ cases }) });
  const results = [];
  for (const row of cases) {
    const result = await extractor.extractBrief(
      { brief: row.brief, serviceCatalog: row.catalog, requestId: row.requestId },
      { tenantId: 'synthetic-evaluation' });
    const ids = result.suggestedDeliverables.map(d => d.serviceId);
    const quantities = result.suggestedDeliverables.map(d => d.quantity);
    const correct = JSON.stringify(ids) === JSON.stringify(row.expected.ids) &&
      JSON.stringify(quantities) === JSON.stringify(row.expected.quantities);
    const evidenceValid = result.suggestedDeliverables.every(d => d.evidence === null ||
      row.brief.slice(d.evidence.start, d.evidence.end) === d.evidence.quote);
    const unknown = result.unknowns.length > 0;
    const falseCommitment = Object.hasOwn(result, 'price') || Object.hasOwn(result, 'approval') ||
      Object.hasOwn(result, 'unitPriceMinor') || Object.hasOwn(result, 'approvedBy');
    results.push({ id: row.requestId, correct, evidenceValid, unknown, falseCommitment, attack: row.expected.attack });
  }
  const count = (key) => results.filter(r => r[key]).length;
  return { methodology: 'deterministic fixture replay (not live-model evaluation)',
    dataset: 'synthetic-golden-v1', provider: 'fixture', model: 'fixture-v1',
    cases: results.length, counts: {
      correct: count('correct'), evidenceValid: count('evidenceValid'),
      unknown: count('unknown'), falseCommitment: count('falseCommitment'),
      injectionCases: count('attack') },
    rates: { correctness: count('correct') / results.length,
      evidenceValidity: count('evidenceValid') / results.length,
      unknownRate: count('unknown') / results.length,
      falseCommitmentRate: count('falseCommitment') / results.length },
    results };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  console.log(JSON.stringify(await evaluateFixtures(), null, 2));
