/**
 * Scopehatch deterministic domain kernel: no model, database, or network access.
 * Prices are safe integer minor units from an immutable tenant catalog.
 * The adapter must provide verified principals and enforce current DB revision/catalog
 * checks transactionally; optional current* arguments support defensive domain checks.
 */
function reject(code, message) { const error = new Error(message); error.code = code; throw error; }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) reject('INVALID_INPUT', name + ' is required');
  return value.trim();
}
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min)
    reject('INVALID_INPUT', name + ' must be a safe integer');
  return value;
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    reject('INVALID_INPUT', name + ' must be an object');
  return value;
}
function text(value, name, max, { allowEmpty = true, trim = false } = {}) {
  if (typeof value !== 'string') reject('INVALID_INPUT', name + ' must be text');
  const normalized = trim ? value.trim() : value;
  if ((!allowEmpty && !normalized) || [...normalized].length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized))
    reject('INVALID_INPUT', name + ' has invalid content or length');
  return normalized;
}
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const EMPTY_PROPOSAL = Object.freeze({
  overview: '', assumptions: Object.freeze([]), exclusions: Object.freeze([]),
  commercialTerms: Object.freeze([])
});
const PROPOSAL_KEYS = ['overview', 'assumptions', 'exclusions', 'commercialTerms'];
function validateKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) reject('INVALID_INPUT', 'Unexpected ' + name + ' field: ' + key);
  }
}
/** Normalizes legacy missing proposal fields; does not invent commercial commitments. */
export function normalizeProposal(proposal) {
  if (proposal == null) return EMPTY_PROPOSAL;
  object(proposal, 'proposal');
  validateKeys(proposal, PROPOSAL_KEYS, 'proposal');
  const lists = {};
  for (const key of ['assumptions', 'exclusions', 'commercialTerms']) {
    const input = proposal[key] ?? [];
    if (!Array.isArray(input) || input.length > 50)
      reject('INVALID_INPUT', key + ' must have at most 50 entries');
    lists[key] = Object.freeze(input.map((entry, index) =>
      text(entry, key + '[' + index + ']', 2000, { allowEmpty: false, trim: true })));
  }
  const result = Object.freeze({
    overview: text(proposal.overview ?? '', 'overview', 4000),
    ...lists
  });
  if (new TextEncoder().encode(JSON.stringify(result)).length > 65536)
    reject('INVALID_INPUT', 'Proposal metadata exceeds 64 KiB');
  return result;
}
function validateMetadataSize(proposal, lines) {
  const metadata = { proposal, clientDescriptions: lines.map(d => d.clientDescription) };
  if (new TextEncoder().encode(JSON.stringify(metadata)).length > 65536)
    reject('INVALID_INPUT', 'Total proposal metadata exceeds 64 KiB');
}
function fractionDigits(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
      !Intl.supportedValuesOf('currency').includes(currency))
    reject('INVALID_INPUT', 'Unsupported ISO 4217 currency');
  return new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .resolvedOptions().maximumFractionDigits;
}
/** ISO 4217 display using BigInt division, never Number-based fractional pricing. */
export function formatMoneyMinor(amount, currency) {
  integer(amount, 'amount');
  const digits = fractionDigits(currency);
  const divisor = 10n ** BigInt(digits);
  const whole = BigInt(amount) / divisor;
  const remainder = BigInt(amount) % divisor;
  const grouping = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
    .format(whole);
  return currency + ' ' + grouping +
    (digits ? '.' + remainder.toString().padStart(digits, '0') : '');
}
export function createCatalog({ tenantId, currency, version, services }) {
  fractionDigits(currency);
  if (!Array.isArray(services) || !services.length || services.length > 200)
    reject('INVALID_INPUT', 'services must have 1 to 200 entries');
  const ids = new Set();
  const rows = services.map(s => {
    object(s, 'service');
    const id = required(s.id, 'service id');
    if (ids.has(id)) reject('DUPLICATE_SERVICE', id);
    ids.add(id);
    return Object.freeze({
      id, label: required(s.label, 'service label'),
      unitPriceMinor: integer(s.unitPriceMinor, 'unitPriceMinor')
    });
  });
  return Object.freeze({
    tenantId: required(tenantId, 'tenantId'), currency,
    version: integer(version, 'version', 1), services: Object.freeze(rows)
  });
}
export function createScopeRevision({
  tenantId, projectId, revision, authorId, brief, deliverables, unknowns = [],
  proposal
}) {
  if (!Array.isArray(deliverables) || !Array.isArray(unknowns))
    reject('INVALID_INPUT', 'arrays required');
  const lines = deliverables.map(d => {
    object(d, 'deliverable');
    // The HTTP adapter separately rejects extra keys in public requests. This
    // kernel permits legacy internal fields, but never consumes a line's price.
    const source = d.source === undefined ? 'brief' : d.source;
    if (source !== 'brief' && source !== 'manual')
      reject('INVALID_INPUT', 'Invalid deliverable source');
    return Object.freeze({
      serviceId: required(d.serviceId, 'serviceId'),
      quantity: d.quantity === null ? null : integer(d.quantity, 'quantity', 1),
      evidence: text(d.evidence ?? '', 'evidence', 20000, { trim: true }),
      source,
      clientDescription: text(d.clientDescription ?? '', 'clientDescription', 2000)
    });
  });
  const normalized = normalizeProposal(proposal);
  validateMetadataSize(normalized, lines);
  return Object.freeze({
    tenantId: required(tenantId, 'tenantId'), projectId: required(projectId, 'projectId'),
    revision: integer(revision, 'revision', 1), authorId: required(authorId, 'authorId'),
    brief: required(brief, 'brief'), deliverables: Object.freeze(lines),
    unknowns: Object.freeze(unknowns.map(u => required(u, 'unknown requirement'))),
    proposal: normalized
  });
}
function checkedMoney(value, name) {
  integer(value, name);
  return BigInt(value);
}
function safeMinor(big, name) {
  if (big < 0n || big > MAX_MINOR) reject('MONEY_OVERFLOW', name + ' outside safe integer range');
  return Number(big);
}
/** Prices originate only from the catalog, never from scope, evidence or model text. */
export function estimateScope(scope, catalog) {
  if (scope.tenantId !== catalog.tenantId)
    reject('TENANT_MISMATCH', 'Wrong catalog tenant');
  fractionDigits(catalog.currency);
  const rates = new Map(catalog.services.map(s => [s.id, s]));
  const blockers = scope.unknowns.map(u => Object.freeze({ code: 'UNKNOWN_REQUIREMENT', detail: u }));
  let total = 0n;
  const lines = scope.deliverables.map(d => {
    const rate = rates.get(d.serviceId);
    if (!rate) blockers.push(Object.freeze({ code: 'UNPRICED_SERVICE', detail: d.serviceId }));
    if (d.quantity === null) blockers.push(Object.freeze({ code: 'UNKNOWN_QUANTITY', detail: d.serviceId }));
    if (d.source === 'brief' && !d.evidence)
      blockers.push(Object.freeze({ code: 'MISSING_EVIDENCE', detail: d.serviceId }));
    const price = rate ? checkedMoney(rate.unitPriceMinor, 'unitPriceMinor') : null;
    const quantity = d.quantity === null ? null : checkedMoney(integer(d.quantity, 'quantity', 1), 'quantity');
    const subtotal = price !== null && quantity !== null
      ? safeMinor(price * quantity, 'Subtotal') : null;
    total += BigInt(subtotal ?? 0);
    safeMinor(total, 'Total');
    return Object.freeze({
      serviceId: d.serviceId, quantity: d.quantity,
      unitPriceMinor: rate ? rate.unitPriceMinor : null, subtotalMinor: subtotal,
      evidence: d.evidence, source: d.source
    });
  });
  if (!lines.length) blockers.push(Object.freeze({ code: 'EMPTY_SCOPE', detail: 'No deliverables' }));
  return Object.freeze({
    tenantId: scope.tenantId, projectId: scope.projectId,
    scopeRevision: scope.revision, catalogVersion: catalog.version, currency: catalog.currency,
    lines: Object.freeze(lines), blockers: Object.freeze(blockers),
    state: blockers.length ? 'blocked' : 'ready',
    totalMinor: blockers.length ? null : Number(total)
  });
}
function assertBound(scope, estimate) {
  if (scope.tenantId !== estimate.tenantId ||
      scope.projectId !== estimate.projectId ||
      scope.revision !== estimate.scopeRevision)
    reject('STALE_ESTIMATE', 'Estimate does not match scope revision');
}
function assertCurrent(scope, estimate, currentScopeRevision, currentCatalogVersion) {
  if (currentScopeRevision !== undefined &&
      (integer(currentScopeRevision, 'currentScopeRevision', 1) !== scope.revision))
    reject('STALE_REVISION', 'A newer scope revision exists');
  if (currentCatalogVersion !== undefined &&
      integer(currentCatalogVersion, 'currentCatalogVersion', 1) !== estimate.catalogVersion)
    reject('STALE_REVISION', 'A newer catalog version exists');
}
export function submitReview({ scope, estimate, actor, currentScopeRevision, currentCatalogVersion }) {
  assertBound(scope, estimate);
  assertCurrent(scope, estimate, currentScopeRevision, currentCatalogVersion);
  if (actor.tenantId !== scope.tenantId || actor.id !== scope.authorId)
    reject('FORBIDDEN', 'Only the author may submit');
  if (estimate.state !== 'ready') reject('BLOCKED_ESTIMATE', 'Cannot submit a blocked estimate');
  return Object.freeze({
    tenantId: scope.tenantId, projectId: scope.projectId,
    scopeRevision: scope.revision, catalogVersion: estimate.catalogVersion,
    state: 'pending', submittedBy: actor.id, approvedBy: null
  });
}
export function approveReview({
  scope, estimate, review, actor, currentScopeRevision, currentCatalogVersion
}) {
  assertBound(scope, estimate);
  assertCurrent(scope, estimate, currentScopeRevision, currentCatalogVersion);
  if (estimate.state !== 'ready') reject('BLOCKED_ESTIMATE', 'Blocked estimate');
  if (review.state !== 'pending' || review.scopeRevision !== scope.revision ||
      review.catalogVersion !== estimate.catalogVersion || review.submittedBy !== scope.authorId)
    reject('STALE_REVIEW', 'Review targets an outdated version');
  if (review.tenantId !== scope.tenantId || review.projectId !== scope.projectId ||
      actor.tenantId !== scope.tenantId) reject('TENANT_MISMATCH', 'Cross-tenant review');
  if (!actor.roles?.some(r => r === 'owner' || r === 'reviewer'))
    reject('FORBIDDEN', 'Reviewer role required');
  if (actor.id === review.submittedBy) reject('SELF_APPROVAL', 'Separate reviewer required');
  return Object.freeze({ ...review, state: 'approved', approvedBy: required(actor.id, 'reviewer id') });
}
/** Escape raw user text for Markdown and embedded HTML-capable renderers. */
function markdownText(value) {
  return String(value).replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/([\\\x60*_{}\[\]()#+\-.!|])/g, '\\$1')
    .replace(/\n/g, '  \n');
}
function headingItems(items) {
  return items.length ? items.map(x => '- ' + markdownText(x)).join('\n')
    : '_None specified._';
}
function humanLabel(id) {
  return id.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
// Trusted principal IDs containing only inert characters need no Markdown escapes.
function reviewerLabel(id) {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : markdownText(id);
}
/**
 * Creates an UNSIGNED draft from an exact approved snapshot.
 * Current-version arguments must be supplied from the DB's guarded read for
 * production freshness; pure domain code cannot discover newer DB revisions.
 */
export function exportProposal({
  scope, estimate, review, catalog, currentScopeRevision, currentCatalogVersion
}) {
  assertBound(scope, estimate);
  assertCurrent(scope, estimate, currentScopeRevision, currentCatalogVersion);
  if (review?.state !== 'approved' || review.tenantId !== scope.tenantId ||
      review.projectId !== scope.projectId || review.scopeRevision !== scope.revision ||
      review.catalogVersion !== estimate.catalogVersion ||
      !review.approvedBy || review.approvedBy === review.submittedBy ||
      review.submittedBy !== scope.authorId)
    reject('APPROVAL_REQUIRED', 'Approval of the exact revision required');
  if (estimate.state !== 'ready') reject('BLOCKED_ESTIMATE', 'Blocked estimate');
  if (catalog && (catalog.tenantId !== scope.tenantId ||
      catalog.version !== estimate.catalogVersion || catalog.currency !== estimate.currency))
    reject('STALE_REVISION', 'Catalog does not match approved estimate');
  if (!Array.isArray(estimate.lines) ||
      estimate.lines.length !== scope.deliverables.length)
    reject('STALE_ESTIMATE', 'Estimate lines do not match the scope');
  let total = 0n;
  const rates = catalog ? new Map(catalog.services.map(s => [s.id, s])) : null;
  const items = scope.deliverables.map((d, index) => {
    const line = estimate.lines[index];
    if (line.serviceId !== d.serviceId || line.quantity !== d.quantity ||
        line.evidence !== d.evidence || line.source !== d.source ||
        d.quantity === null || line.unitPriceMinor === null ||
        line.subtotalMinor === null)
      reject('STALE_ESTIMATE', 'Estimate line does not match the scope');
    const subtotal = checkedMoney(line.unitPriceMinor, 'unitPriceMinor') *
      BigInt(integer(d.quantity, 'quantity', 1));
    if (safeMinor(subtotal, 'Subtotal') !== line.subtotalMinor)
      reject('STALE_ESTIMATE', 'Estimate subtotal is inconsistent');
    if (rates && (!rates.has(d.serviceId) ||
        rates.get(d.serviceId).unitPriceMinor !== line.unitPriceMinor))
      reject('STALE_ESTIMATE', 'Estimate rate differs from the approved catalog');
    total += subtotal;
    safeMinor(total, 'Total');
    const label = rates ? rates.get(d.serviceId).label : humanLabel(d.serviceId);
    const basis = d.evidence
      ? '  - Basis (' + d.source + '): ' + markdownText(d.evidence)
      : '  - Basis: Manual scope entry (no cited brief evidence)';
    return '- **' + markdownText(label) + '** — ' + d.quantity + ' × ' +
      formatMoneyMinor(line.unitPriceMinor, estimate.currency) + ' = **' +
      formatMoneyMinor(line.subtotalMinor, estimate.currency) + '**' +
      (d.clientDescription ? '\n  - Description: ' + markdownText(d.clientDescription) : '') +
      '\n' + basis;
  });
  if (checkedMoney(estimate.totalMinor, 'totalMinor') !== total)
    reject('STALE_ESTIMATE', 'Estimate total is inconsistent');
  const proposal = normalizeProposal(scope.proposal);
  const markdown = [
    '# Proposal draft — ' + markdownText(scope.projectId),
    '**Unsigned proposal draft. Not a signed quotation or client acceptance.**',
    '## Overview',
    proposal.overview ? markdownText(proposal.overview) : '_No overview supplied._',
    '## Deliverables',
    items.join('\n'),
    '## Assumptions',
    headingItems(proposal.assumptions),
    '## Exclusions',
    headingItems(proposal.exclusions),
    '## Commercial terms (human-authored)',
    headingItems(proposal.commercialTerms),
    '## Catalog-based estimate',
    '**Total: ' + formatMoneyMinor(estimate.totalMinor, estimate.currency) + '**',
    'Authoritative minor-unit total: ' + estimate.totalMinor + ' ' + estimate.currency + '.',
    'Catalog version: ' + estimate.catalogVersion + '; scope revision: ' + scope.revision + '.',
    'Approved by: ' + reviewerLabel(review.approvedBy) + ' (independent human review of this exact revision).',
    '_Review authorizes export of this draft only; it is not a signature._'
  ].join('\n\n') + '\n';
  return Object.freeze({
    projectId: scope.projectId, revision: scope.revision,
    currency: estimate.currency, totalMinor: estimate.totalMinor,
    markdown, proposal
  });
}
