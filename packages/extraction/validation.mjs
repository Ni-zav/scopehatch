import { fail } from './errors.mjs';

export const LIMITS = Object.freeze({
  briefLength: 20000, catalogSize: 100, catalogLabelLength: 160,
  serviceIdLength: 100, requestIdLength: 128, tenantIdLength: 128,
  outputBytes: 32768, deliverables: 100, unknowns: 100,
  unknownLength: 300, evidenceLength: 1200, modelLength: 200
});

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => isObj(v) && Object.keys(v).length === expected.length &&
  expected.every(k => Object.hasOwn(v, k));
const meaningful = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const boundary = (text, i) => i <= 0 || i >= text.length ||
  !(text.charCodeAt(i - 1) >= 0xD800 && text.charCodeAt(i - 1) <= 0xDBFF &&
    text.charCodeAt(i) >= 0xDC00 && text.charCodeAt(i) <= 0xDFFF);

export function validateInput(input, context) {
  if (!isObj(input) || !meaningful(input.brief, LIMITS.briefLength) ||
      !meaningful(input.requestId, LIMITS.requestIdLength) ||
      !Array.isArray(input.serviceCatalog) || !input.serviceCatalog.length ||
      input.serviceCatalog.length > LIMITS.catalogSize ||
      !isObj(context) || !meaningful(context.tenantId, LIMITS.tenantIdLength)) {
    fail('INVALID_INPUT', 'Invalid brief, catalog, request ID, or trusted tenant context');
  }
  if (context.signal !== undefined && !(context.signal instanceof AbortSignal))
    fail('INVALID_INPUT', 'signal must be an AbortSignal');
  const catalog = [], ids = new Set();
  for (const item of input.serviceCatalog) {
    if (!isObj(item) || !meaningful(item.id, LIMITS.serviceIdLength) ||
        !meaningful(item.label, LIMITS.catalogLabelLength) || ids.has(item.id))
      fail('INVALID_INPUT', 'Catalog entries need unique service IDs and labels');
    ids.add(item.id);
    catalog.push(Object.freeze({ id: item.id, label: item.label }));
  }
  return Object.freeze({ brief: input.brief, requestId: input.requestId, serviceCatalog: Object.freeze(catalog) });
}

function quantityInEvidence(quantity, quote) {
  // Fail closed on implicitly inferred counts (including "a dozen"). They need operator review.
  // Match numeric token boundaries, not "12" inside "120". Decimal and scientific forms are excluded.
  const escaped = String(quantity);
  const expr = new RegExp(`(?<!\\d)(?<!\\d\\.)${escaped}(?!\\d)(?!\\.\\d)`, 'u');
  return expr.test(quote);
}

export function validateCompletion(content, { brief, serviceCatalog }) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > LIMITS.outputBytes)
    fail('INVALID_MODEL_OUTPUT', 'Model output is missing or exceeds the size limit');
  let object;
  try { object = JSON.parse(content); }
  catch { fail('INVALID_MODEL_OUTPUT', 'Model returned invalid JSON'); }
  if (!keys(object, ['suggestedDeliverables', 'unknowns']) ||
      !Array.isArray(object.suggestedDeliverables) ||
      !Array.isArray(object.unknowns) ||
      object.suggestedDeliverables.length > LIMITS.deliverables ||
      object.unknowns.length > LIMITS.unknowns)
    fail('INVALID_MODEL_OUTPUT', 'Model response violates the extraction schema');
  const serviceIds = new Set(serviceCatalog.map(s => s.id));
  const suggestedDeliverables = [];
  for (const item of object.suggestedDeliverables) {
    if (!keys(item, ['serviceId', 'quantity', 'evidence']) || !serviceIds.has(item.serviceId) ||
       !(item.quantity === null || (Number.isSafeInteger(item.quantity) && item.quantity > 0)))
      fail('INVALID_MODEL_OUTPUT', 'Invalid service ID, quantity, or disallowed model field');
    let evidence = null;
    if (item.evidence !== null) {
      const e = item.evidence;
      if (!keys(e, ['start', 'end', 'quote']) || !Number.isSafeInteger(e.start) ||
          !Number.isSafeInteger(e.end) || e.start < 0 || e.end <= e.start ||
          e.end > brief.length || !boundary(brief, e.start) || !boundary(brief, e.end) ||
          !meaningful(e.quote, LIMITS.evidenceLength) || brief.slice(e.start, e.end) !== e.quote)
        fail('UNVERIFIABLE_EVIDENCE', 'Evidence offsets do not resolve to the exact submitted brief');
      evidence = Object.freeze({ start: e.start, end: e.end, quote: e.quote });
    }
    if (item.quantity !== null && (!evidence || !quantityInEvidence(item.quantity, evidence.quote)))
      fail('UNVERIFIABLE_QUANTITY', 'Quantity is not supported by its cited evidence');
    suggestedDeliverables.push(Object.freeze({ serviceId: item.serviceId, quantity: item.quantity, evidence }));
  }
  const unknowns = [];
  const seen = new Set();
  for (const unknown of object.unknowns) {
    if (!meaningful(unknown, LIMITS.unknownLength) || seen.has(unknown.trim()))
      fail('INVALID_MODEL_OUTPUT', 'Unknowns must be unique, nonempty, bounded strings');
    unknowns.push(unknown.trim());
    seen.add(unknown.trim());
  }
  return Object.freeze({ suggestedDeliverables: Object.freeze(suggestedDeliverables), unknowns: Object.freeze(unknowns) });
}
