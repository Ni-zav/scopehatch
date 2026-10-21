/**
 * Scopehatch domain kernel. Pure functions: no model, database, or network access.
 * Currency is an integer count of the currency's smallest units.
 * The HTTP adapter must supply an authenticated principal; it must not trust a body-provided role.
 */
function reject(code, message) { const error = new Error(message); error.code = code; throw error; }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) reject('INVALID_INPUT', name + ' is required');
  return value.trim();
}
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) reject('INVALID_INPUT', name + ' must be a safe integer');
  return value;
}

export function createCatalog({ tenantId, currency, version, services }) {
  if (!/^[A-Z]{3}$/.test(currency)) reject('INVALID_INPUT', 'Invalid ISO currency');
  if (!Array.isArray(services)) reject('INVALID_INPUT', 'services must be an array');
  const ids = new Set();
  const rows = services.map(s => {
    const id = required(s.id, 'service id');
    if (ids.has(id)) reject('DUPLICATE_SERVICE', id);
    ids.add(id);
    return Object.freeze({
      id, label: required(s.label, 'service label'),
      unitPriceMinor: integer(s.unitPriceMinor, 'unitPriceMinor')
    });
  });
  return Object.freeze({
    tenantId: required(tenantId, 'tenantId'), currency, version: integer(version, 'version', 1),
    services: Object.freeze(rows)
  });
}

export function createScopeRevision({ tenantId, projectId, revision, authorId, brief, deliverables, unknowns = [] }) {
  if (!Array.isArray(deliverables) || !Array.isArray(unknowns)) reject('INVALID_INPUT', 'arrays required');
  const lines = deliverables.map(d => Object.freeze({
    serviceId: required(d.serviceId, 'serviceId'),
    quantity: d.quantity === null ? null : integer(d.quantity, 'quantity', 1),
    evidence: typeof d.evidence === 'string' ? d.evidence.trim() : '',
    source: d.source === 'manual' ? 'manual' : 'brief'
  }));
  return Object.freeze({
    tenantId: required(tenantId, 'tenantId'), projectId: required(projectId, 'projectId'),
    revision: integer(revision, 'revision', 1), authorId: required(authorId, 'authorId'),
    brief: required(brief, 'brief'), deliverables: Object.freeze(lines),
    unknowns: Object.freeze(unknowns.map(u => required(u, 'unknown requirement')))
  });
}

/** An LLM suggestion can never override service prices or remove blockers. */
export function estimateScope(scope, catalog) {
  if (scope.tenantId !== catalog.tenantId) reject('TENANT_MISMATCH', 'Wrong catalog tenant');
  const rates = new Map(catalog.services.map(s => [s.id, s]));
  const blockers = scope.unknowns.map(u => ({ code: 'UNKNOWN_REQUIREMENT', detail: u }));
  const lines = scope.deliverables.map(d => {
    const rate = rates.get(d.serviceId);
    if (!rate) blockers.push({ code: 'UNPRICED_SERVICE', detail: d.serviceId });
    if (d.quantity === null) blockers.push({ code: 'UNKNOWN_QUANTITY', detail: d.serviceId });
    if (d.source === 'brief' && !d.evidence) blockers.push({ code: 'MISSING_EVIDENCE', detail: d.serviceId });
    const subtotalMinor = rate && d.quantity !== null ? rate.unitPriceMinor * d.quantity : null;
    if (subtotalMinor !== null && !Number.isSafeInteger(subtotalMinor))
      reject('MONEY_OVERFLOW', 'Subtotal outside safe integer range');
    return { serviceId: d.serviceId, quantity: d.quantity,
      unitPriceMinor: rate ? rate.unitPriceMinor : null, subtotalMinor,
      evidence: d.evidence, source: d.source };
  });
  if (!lines.length) blockers.push({ code: 'EMPTY_SCOPE', detail: 'No deliverables' });
  const sum = lines.reduce((s, line) => s + (line.subtotalMinor ?? 0), 0);
  if (!Number.isSafeInteger(sum)) reject('MONEY_OVERFLOW', 'Total outside safe integer range');
  return Object.freeze({
    tenantId: scope.tenantId, projectId: scope.projectId,
    scopeRevision: scope.revision, catalogVersion: catalog.version, currency: catalog.currency,
    lines, blockers, state: blockers.length ? 'blocked' : 'ready',
    totalMinor: blockers.length ? null : sum
  });
}

function assertBound(scope, estimate) {
  if (scope.tenantId !== estimate.tenantId ||
      scope.projectId !== estimate.projectId ||
      scope.revision !== estimate.scopeRevision)
    reject('STALE_ESTIMATE', 'Estimate does not match scope revision');
}

export function submitReview({ scope, estimate, actor }) {
  assertBound(scope, estimate);
  if (actor.tenantId !== scope.tenantId || actor.id !== scope.authorId)
    reject('FORBIDDEN', 'Only the author may submit');
  if (estimate.state !== 'ready') reject('BLOCKED_ESTIMATE', 'Cannot submit a blocked estimate');
  return Object.freeze({
    tenantId: scope.tenantId, projectId: scope.projectId,
    scopeRevision: scope.revision, catalogVersion: estimate.catalogVersion,
    state: 'pending', submittedBy: actor.id, approvedBy: null
  });
}

export function approveReview({ scope, estimate, review, actor }) {
  assertBound(scope, estimate);
  if (review.state !== 'pending' || review.scopeRevision !== scope.revision ||
      review.catalogVersion !== estimate.catalogVersion)
    reject('STALE_REVIEW', 'Review targets an outdated version');
  if (review.tenantId !== scope.tenantId || review.projectId !== scope.projectId ||
      actor.tenantId !== scope.tenantId) reject('TENANT_MISMATCH', 'Cross-tenant review');
  if (!actor.roles?.some(r => r === 'owner' || r === 'reviewer')) reject('FORBIDDEN', 'Reviewer role required');
  if (actor.id === review.submittedBy) reject('SELF_APPROVAL', 'Separate reviewer required');
  return Object.freeze({ ...review, state: 'approved', approvedBy: actor.id });
}

export function exportProposal({ scope, estimate, review }) {
  assertBound(scope, estimate);
  if (review?.state !== 'approved' || review.tenantId !== scope.tenantId ||
      review.projectId !== scope.projectId || review.scopeRevision !== scope.revision ||
      review.catalogVersion !== estimate.catalogVersion)
    reject('APPROVAL_REQUIRED', 'Approval of the exact revision required');
  if (estimate.state !== 'ready') reject('BLOCKED_ESTIMATE', 'Blocked estimate');
  const items = estimate.lines.map(l =>
    '- ' + l.serviceId + ': ' + l.quantity + ' x ' + l.unitPriceMinor + ' = ' + l.subtotalMinor
  ).join('\n');
  return {
    projectId: scope.projectId, revision: scope.revision, currency: estimate.currency,
    totalMinor: estimate.totalMinor,
    markdown: '# Proposal draft — ' + scope.projectId + '\n\n' + items +
      '\n\nTotal: ' + estimate.totalMinor + ' ' + estimate.currency +
      ' minor units\n\nApproved by: ' + review.approvedBy + '\n'
  };
}
