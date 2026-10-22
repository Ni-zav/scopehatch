/**
 * PostgreSQL persistence for Scopehatch. The calling API MUST verify the JWT
 * signature, issuer, audience, expiry and selected tenant before passing actor.
 * SQL is parameterized, role is looked up from durable memberships, and every
 * call runs inside a transaction with SET LOCAL tenant/actor context.
 *
 * Never connect using the migration owner, a superuser, or a BYPASSRLS role.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createCatalog as validateCatalog,
  createScopeRevision as validateScope,
  estimateScope,
  submitReview as validateSubmit,
  approveReview as validateApprove,
  exportProposal
} from '../../src/domain.mjs';

export class PersistenceError extends Error {
  constructor(code, message) { super(message); this.name = 'PersistenceError'; this.code = code; }
}
function reject(code, message) { throw new PersistenceError(code, message); }
function string(value, name) {
  if (typeof value !== 'string' || !value.trim()) reject('INVALID_INPUT', name + ' required');
  return value.trim();
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    reject('INVALID_INPUT', name + ' must be an object');
  return value;
}
function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) reject('INVALID_INPUT', name + ' must be a safe integer');
  return value;
}
function minor(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) reject('MONEY_OVERFLOW', 'unsafe DB minor-unit amount');
  return n;
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  reject('INVALID_INPUT', 'idempotency payload must contain JSON values and safe integers');
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');


const EMPTY_PROPOSAL = Object.freeze({
  overview: '', assumptions: [], exclusions: [], commercialTerms: []
});
const PROPOSAL_FIELDS = ['overview', 'assumptions', 'exclusions', 'commercialTerms'];
const CURSOR_SECRET = Buffer.from(process.env.SCOPEHATCH_CURSOR_SECRET || randomBytes(32).toString('hex'));
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
function normalizeProposal(raw) {
  if (raw === undefined) return { overview: '', assumptions: [], exclusions: [], commercialTerms: [] };
  object(raw, 'proposal');
  if (Object.keys(raw).length !== 4 ||
      Object.keys(raw).some(k => !PROPOSAL_FIELDS.includes(k)))
    reject('INVALID_INPUT', 'proposal fields must match contract');
  if (typeof raw.overview !== 'string' || [...raw.overview].length > 4000)
    reject('INVALID_INPUT', 'invalid proposal overview');
  const result = { overview: raw.overview };
  for (const key of PROPOSAL_FIELDS.slice(1)) {
    if (!Array.isArray(raw[key]) || raw[key].length > 50 ||
        raw[key].some(x => typeof x !== 'string' || !x.trim() || [...x.trim()].length > 2000))
      reject('INVALID_INPUT', 'invalid proposal ' + key);
    result[key] = [...raw[key]];
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 65536)
    reject('INVALID_INPUT', 'proposal metadata too large');
  return result;
}
function normalizeDescriptions(deliverables, proposal) {
  const rows = deliverables.map(line => {
    object(line, 'deliverable');
    if (Object.keys(line).some(k => !['serviceId','quantity','evidence','source','clientDescription'].includes(k)))
      reject('INVALID_INPUT', 'unknown deliverable property');
    const description = line.clientDescription ?? '';
    if (typeof description !== 'string' || [...description].length > 2000)
      reject('INVALID_INPUT', 'invalid clientDescription');
    return description;
  });
  if (Buffer.byteLength(JSON.stringify({ proposal, clientDescriptions: rows }), 'utf8') > 65536)
    reject('INVALID_INPUT', 'combined proposal metadata too large');
  return rows;
}
function md(value) {
  return String(value).replace(/[\\`*_{}\[\]()#+.!|<>~>-]/g, '\\function presentCatalog(header, rows) {')
    .replace(/\r?\n/g, '  \n');
}
function proposalMarkdown(scope, estimate, review) {
  const p = scope.proposal ?? EMPTY_PROPOSAL;
  const lines = ['# Proposal draft — ' + md(scope.projectId), ''];
  if (p.overview) lines.push('## Overview', '', md(p.overview), '');
  lines.push('## Deliverables', '');
  estimate.lines.forEach((line, index) => {
    const description = scope.deliverables[index]?.clientDescription ?? '';
    lines.push('- ' + md(line.serviceId) + ': ' + line.quantity + ' x ' +
      line.unitPriceMinor + ' = ' + line.subtotalMinor +
      (description ? ' — ' + md(description) : ''));
  });
  lines.push('', 'Total: ' + estimate.totalMinor + ' ' + md(estimate.currency) + ' minor units', '');
  for (const [key, heading] of [
    ['assumptions','Assumptions'], ['exclusions','Exclusions'],
    ['commercialTerms','Commercial terms']
  ]) if (p[key].length) {
    lines.push('## ' + heading, '');
    for (const entry of p[key]) lines.push('- ' + md(entry));
    lines.push('');
  }
  lines.push('Approved by: ' + md(review.approvedBy), '');
  return lines.join('\n');
}
function cursorMac(encoded) {
  return createHmac('sha256', CURSOR_SECRET).update(encoded).digest('base64url');
}
function makeProjectCursor(tenantId, row) {
  const payload = { v: 1, t: digest(tenantId), d: new Date(row.created_at).toISOString(),
    i: row.id, x: Date.now() + CURSOR_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return 'p1.' + encoded + '.' + cursorMac(encoded);
}
function readProjectCursor(tenantId, cursor) {
  if (typeof cursor !== 'string' || cursor.length > 512 ||
      !/^p1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor))
    reject('INVALID_CURSOR', 'invalid project cursor');
  const [, encoded, mac] = cursor.split('.');
  const expected = Buffer.from(cursorMac(encoded));
  const supplied = Buffer.from(mac);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    reject('INVALID_CURSOR', 'invalid project cursor');
  let value;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { reject('INVALID_CURSOR', 'invalid project cursor'); }
  if (value?.v !== 1 || value.t !== digest(tenantId) ||
      typeof value.i !== 'string' || !value.i || typeof value.d !== 'string' ||
      !Number.isFinite(Date.parse(value.d)) || !Number.isSafeInteger(value.x) ||
      value.x < Date.now() || value.x > Date.now() + CURSOR_TTL_MS)
    reject('INVALID_CURSOR', 'expired or foreign project cursor');
  return { id: value.i, date: value.d };
}
// Shared read-model join: a catalog or scope edit invalidates old current approval.
const PROJECT_READ_MODEL = `
  FROM scopehatch.projects p
  LEFT JOIN LATERAL (
    SELECT revision,brief FROM scopehatch.intakes
    WHERE tenant_id=p.tenant_id AND project_id=p.id
    ORDER BY revision DESC LIMIT 1
  ) i ON true
  LEFT JOIN LATERAL (
    SELECT revision,intake_revision FROM scopehatch.scope_revisions
    WHERE tenant_id=p.tenant_id AND project_id=p.id
    ORDER BY revision DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT version FROM scopehatch.catalog_versions
    WHERE tenant_id=p.tenant_id ORDER BY version DESC LIMIT 1
  ) c ON true
  LEFT JOIN LATERAL (
    SELECT revision,scope_revision,catalog_version,state FROM scopehatch.estimate_revisions
    WHERE tenant_id=p.tenant_id AND project_id=p.id
    ORDER BY revision DESC LIMIT 1
  ) e ON true
  LEFT JOIN scopehatch.reviews r
    ON r.tenant_id=p.tenant_id AND r.project_id=p.id
   AND r.estimate_revision=e.revision
`;
const PROJECT_STATUS = `CASE
    WHEN s.revision IS NULL OR s.intake_revision IS DISTINCT FROM i.revision
       OR e.revision IS NULL OR e.scope_revision IS DISTINCT FROM s.revision
       OR e.catalog_version IS DISTINCT FROM c.version THEN 'draft'
    WHEN e.state='blocked' THEN 'blocked'
    WHEN r.state='approved' THEN 'approved'
    WHEN r.state='pending' THEN 'pending'
    ELSE 'ready' END`;

function presentCatalog(header, rows) {
  return {
    tenantId: header.tenant_id, currency: header.currency, version: header.version,
    services: rows.map(r => ({ id: r.service_id, label: r.label, unitPriceMinor: minor(r.unit_price_minor) }))
  };
}
function presentScope(scope, intake, lines) {
  return {
    tenantId: scope.tenant_id, projectId: scope.project_id, revision: scope.revision,
    authorId: scope.author_id, brief: intake.brief,
    deliverables: lines.map(l => ({
      serviceId: l.service_id, quantity: l.quantity === null ? null : minor(l.quantity),
      evidence: l.evidence, source: l.source, clientDescription: l.client_description ?? ''
    })),
    unknowns: scope.unknowns, proposal: scope.proposal ?? normalizeProposal()
  };
}
function presentEstimate(row) {
  return {
    tenantId: row.tenant_id, projectId: row.project_id,
    scopeRevision: row.scope_revision, catalogVersion: row.catalog_version,
    revision: row.revision, currency: row.currency, state: row.state,
    lines: row.lines, blockers: row.blockers, totalMinor: minor(row.total_minor)
  };
}
function presentReview(row) {
  return {
    id: row.id, tenantId: row.tenant_id, projectId: row.project_id,
    estimateRevision: row.estimate_revision,
    scopeRevision: row.scope_revision, catalogVersion: row.catalog_version,
    state: row.state, submittedBy: row.submitted_by, approvedBy: row.approved_by,
    approvedAt: row.approved_at
  };
}
function requireRole(ctx, options) {
  if (!ctx.roles.some(r => options.includes(r))) reject('FORBIDDEN', 'membership role insufficient');
}
function isUnique(error) { return error?.code === '23505'; }

/**
 * @param {{connect():Promise<{query(sql:string,values?:unknown[]):Promise<{rows:any[],rowCount:number}>,release():void}>}} pool
 */
export function createPersistence(pool) {
  if (!pool || typeof pool.connect !== 'function') reject('INVALID_INPUT', 'PostgreSQL pool required');

  /** principal is issued ONLY by trusted auth middleware; never from HTTP body. */
  async function withPrincipal(principal, work) {
    object(principal, 'verified principal');
    const tenantId = string(principal.tenantId, 'principal.tenantId');
    const actorId = string(principal.id, 'principal.id');
    if (typeof work !== 'function') reject('INVALID_INPUT', 'work callback required');
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query("SELECT set_config('scopehatch.tenant_id', $1, true)", [tenantId]);
      await client.query("SELECT set_config('scopehatch.actor_id', $1, true)", [actorId]);
      const m = await client.query(
        'SELECT roles FROM scopehatch.memberships WHERE tenant_id = $1 AND principal_id = $2 AND active',
        [tenantId, actorId]
      );
      // No raw SQL client is returned to the API adapter.
      if (m.rowCount !== 1) reject('FORBIDDEN', 'verified actor has no active membership');
      const ctx = Object.freeze({ tenantId, actorId, roles: Object.freeze([...m.rows[0].roles]) });
      const q = (sql, args = []) => client.query(sql, args);
      const tenant = ctx.tenantId;

      async function projectRow(projectId, lock = false) {
        const id = string(projectId, 'projectId');
        const r = await q(
          'SELECT * FROM scopehatch.projects WHERE tenant_id=$1 AND id=$2' +
            (lock ? ' FOR UPDATE' : ''), [tenant, id]
        );
        if (!r.rowCount) reject('NOT_FOUND', 'project not found');
        return r.rows[0];
      }
      async function getProject(projectId) {
        const r = await q(
          'SELECT p.id,p.title,i.brief,' + PROJECT_STATUS + ' AS status ' +
          PROJECT_READ_MODEL + ' WHERE p.tenant_id=$1 AND p.id=$2',
          [tenant, string(projectId, 'projectId')]
        );
        if (!r.rowCount) reject('NOT_FOUND', 'project not found');
        return r.rows[0];
      }
      async function listProjects({ limit = 20, cursor } = {}) {
        integer(limit, 'limit', 1);
        if (limit > 100) reject('INVALID_INPUT', 'limit maximum 100');
        const cutoff = cursor === undefined ? null : readProjectCursor(tenant, cursor);
        const args = [tenant];
        let where = ' WHERE p.tenant_id=$1';
        if (cutoff) {
          args.push(cutoff.date, cutoff.id);
          where += ' AND (p.created_at,p.id) < ($2::timestamptz,$3::text)';
        }
        args.push(limit + 1);
        const r = await q(
          'SELECT p.id,p.title,p.created_at,' + PROJECT_STATUS + ' AS status ' +
          PROJECT_READ_MODEL + where +
          ' ORDER BY p.created_at DESC,p.id DESC LIMIT $' + args.length,
          args
        );
        const hasMore = r.rows.length > limit;
        const rows = r.rows.slice(0, limit);
        return {
          items: rows.map(x => ({
            id: x.id, title: x.title, status: x.status,
            createdAt: new Date(x.created_at).toISOString()
          })),
          nextCursor: hasMore ? makeProjectCursor(tenant, rows.at(-1)) : null
        };
      }
      async function listReviews(projectId) {
        await projectRow(projectId);
        const r = await q(
          'SELECT * FROM scopehatch.reviews WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at DESC,id DESC',
          [tenant, projectId]
        );
        return r.rows.map(presentReview);
      }
      async function exportApproved(projectId) {
        // A pending revision in another transaction cannot overtake this export.
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        await projectRow(projectId, true);
        const [scope, estimate, catalog, intake] = await Promise.all([
          getScope(projectId), getEstimate(projectId), getCatalog(), latestIntake(projectId)
        ]);
        const bound = await q(
          'SELECT intake_revision FROM scopehatch.scope_revisions WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',
          [tenant, projectId, scope.revision]
        );
        if (bound.rows[0].intake_revision !== intake.revision ||
            scope.revision !== estimate.scopeRevision ||
            estimate.catalogVersion !== catalog.version)
          reject('STALE_REVISION', 'latest scope, intake and estimate not bound');
        const reviewed = await q(
          "SELECT * FROM scopehatch.reviews WHERE tenant_id=$1 AND project_id=$2 AND estimate_revision=$3 AND state='approved'",
          [tenant, projectId, estimate.revision]
        );
        if (!reviewed.rowCount) reject('APPROVAL_REQUIRED', 'exact quote is not approved');
        const review = presentReview(reviewed.rows[0]);
        // Kernel remains the quote/approval authority; rich text never affects price.
        exportProposal({ scope, estimate, review });
        return {
          projectId: scope.projectId, revision: scope.revision,
          currency: estimate.currency, totalMinor: estimate.totalMinor,
          markdown: proposalMarkdown(scope, estimate, review),
          proposal: scope.proposal
        };
      }
      async function latestIntake(projectId) {
        const r = await q(
          'SELECT * FROM scopehatch.intakes WHERE tenant_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 1',
          [tenant, projectId]
        );
        if (!r.rowCount) reject('NOT_FOUND', 'intake not found');
        return r.rows[0];
      }
      async function getCatalog(version) {
        const where = version === undefined
          ? 'ORDER BY version DESC LIMIT 1'
          : 'AND version=$2';
        if (version !== undefined) integer(version, 'catalog version', 1);
        const r = await q(
          'SELECT * FROM scopehatch.catalog_versions WHERE tenant_id=$1 ' + where,
          version === undefined ? [tenant] : [tenant, version]
        );
        if (!r.rowCount) reject('NOT_FOUND', 'catalog not found');
        const h = r.rows[0];
        const services = await q(
          'SELECT * FROM scopehatch.catalog_services WHERE tenant_id=$1 AND catalog_version=$2 ORDER BY service_id',
          [tenant, h.version]
        );
        return presentCatalog(h, services.rows);
      }
      async function listCatalogs() {
        const r = await q('SELECT version FROM scopehatch.catalog_versions WHERE tenant_id=$1 ORDER BY version DESC', [tenant]);
        return Promise.all(r.rows.map(x => getCatalog(x.version)));
      }
      async function getScope(projectId, revision) {
        await projectRow(projectId);
        const vals = [tenant, projectId];
        const r = await q(
          'SELECT * FROM scopehatch.scope_revisions WHERE tenant_id=$1 AND project_id=$2 ' +
          (revision === undefined ? 'ORDER BY revision DESC LIMIT 1' : 'AND revision=$3'),
          revision === undefined ? vals : [...vals, integer(revision, 'scope revision', 1)]
        );
        if (!r.rowCount) reject('NOT_FOUND', 'scope not found');
        const row = r.rows[0];
        const [intake, lines] = await Promise.all([
          q('SELECT brief FROM scopehatch.intakes WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',
            [tenant, projectId, row.intake_revision]),
          q('SELECT * FROM scopehatch.scope_deliverables WHERE tenant_id=$1 AND project_id=$2 AND scope_revision=$3 ORDER BY line_no',
            [tenant, projectId, row.revision])
        ]);
        return presentScope(row, intake.rows[0], lines.rows);
      }
      async function getEstimate(projectId, revision) {
        await projectRow(projectId);
        const r = await q(
          'SELECT * FROM scopehatch.estimate_revisions WHERE tenant_id=$1 AND project_id=$2 ' +
          (revision === undefined ? 'ORDER BY revision DESC LIMIT 1' : 'AND revision=$3'),
          revision === undefined ? [tenant, projectId] : [tenant, projectId, integer(revision, 'estimate revision', 1)]
        );
        if (!r.rowCount) reject('NOT_FOUND', 'estimate not found');
        return presentEstimate(r.rows[0]);
      }
      async function getReview(projectId, reviewId) {
        await projectRow(projectId);
        const r = await q('SELECT * FROM scopehatch.reviews WHERE tenant_id=$1 AND project_id=$2 AND id=$3',
          [tenant, projectId, string(reviewId, 'reviewId')]);
        if (!r.rowCount) reject('NOT_FOUND', 'review not found');
        return presentReview(r.rows[0]);
      }
      async function audit(action, projectId = null, revision = null, requestId = randomUUID(), metadata = {}) {
        const id = randomUUID();
        await q(
          'INSERT INTO scopehatch.audit_events(tenant_id,id,project_id,actor_id,action,object_revision,request_id,outcome,metadata) ' +
          "VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded',$8::jsonb)",
          [tenant, id, projectId, ctx.actorId, string(action, 'action'),
            revision, string(requestId, 'requestId'), JSON.stringify(metadata)]
        );
        return id;
      }
      async function createProject({ id = randomUUID(), title, brief, requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        const projectId = string(id, 'project.id');
        await q(
          'INSERT INTO scopehatch.projects(tenant_id,id,title,created_by) VALUES($1,$2,$3,$4)',
          [tenant, projectId, string(title, 'title'), ctx.actorId]
        );
        await q(
          'INSERT INTO scopehatch.intakes(tenant_id,project_id,revision,brief,author_id) VALUES($1,$2,1,$3,$4)',
          [tenant, projectId, string(brief, 'brief'), ctx.actorId]
        );
        await audit('project.created', projectId, 1, requestId);
        return { id: projectId, title, brief, status: 'draft' };
      }
      async function createIntake({ projectId, brief, requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        await projectRow(projectId);
        const intake = await latestIntake(projectId);
        const revision = intake.revision + 1;
        await q(
          'INSERT INTO scopehatch.intakes(tenant_id,project_id,revision,brief,author_id) VALUES($1,$2,$3,$4,$5)',
          [tenant, projectId, revision, string(brief, 'brief'), ctx.actorId]
        );
        await audit('intake.created', projectId, revision, requestId);
        return { tenantId: tenant, projectId, revision, brief, authorId: ctx.actorId };
      }
      async function createCatalog({ baseVersion, currency, services, requestId } = {}) {
        requireRole(ctx, ['owner']);
        integer(baseVersion, 'baseVersion');
        if (!Array.isArray(services) || services.length < 1 || services.length > 200)
          reject('INVALID_INPUT', 'catalog requires 1..200 services');
        if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) ||
            !Intl.supportedValuesOf('currency').includes(currency))
          reject('INVALID_INPUT', 'unsupported currency');
        for (const service of services) {
          object(service, 'service');
          if (Object.keys(service).some(k => !['id','label','unitPriceMinor'].includes(k)))
            reject('INVALID_INPUT', 'unknown service property');
        }
        // Validation occurs before locking, but version selection never trusts the caller.
        const catalog = validateCatalog({
          tenantId: tenant, currency, version: baseVersion + 1, services
        });
        if (baseVersion >= 2147483647) reject('INVALID_INPUT', 'catalog version limit reached');
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        const r = await q('SELECT coalesce(max(version),0)::int AS version FROM scopehatch.catalog_versions WHERE tenant_id=$1', [tenant]);
        if (r.rows[0].version !== baseVersion)
          reject('STALE_CATALOG_VERSION', 'latest catalog version changed');
        await q(
          'INSERT INTO scopehatch.catalog_versions(tenant_id,version,currency,created_by,service_count) VALUES($1,$2,$3,$4,$5)',
          [tenant, catalog.version, currency, ctx.actorId, catalog.services.length]
        );
        for (const service of catalog.services)
          await q(
            'INSERT INTO scopehatch.catalog_services(tenant_id,catalog_version,service_id,label,unit_price_minor) VALUES($1,$2,$3,$4,$5)',
            [tenant, catalog.version, service.id, service.label, service.unitPriceMinor]
          );
        await audit('catalog.created', null, catalog.version, requestId);
        return catalog;
      }
      async function createScope({ projectId, deliverables, unknowns = [], proposal, requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        if (!Array.isArray(deliverables)) reject('INVALID_INPUT', 'deliverables required');
        const normalizedProposal = normalizeProposal(proposal);
        const descriptions = normalizeDescriptions(deliverables, normalizedProposal);
        // Locks are tenant then project for all metadata, quote and review writers.
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        await projectRow(projectId, true);
        const intake = await latestIntake(projectId);
        const rev = await q(
          'SELECT coalesce(max(revision),0)::int AS revision FROM scopehatch.scope_revisions WHERE tenant_id=$1 AND project_id=$2',
          [tenant, projectId]
        );
        const revision = rev.rows[0].revision + 1;
        const core = validateScope({
          tenantId: tenant, projectId, revision, authorId: ctx.actorId,
          brief: intake.brief, deliverables, unknowns
        });
        const scope = {
          ...core, proposal: normalizedProposal,
          deliverables: core.deliverables.map((line, index) => ({
            ...line, clientDescription: descriptions[index]
          }))
        };
        await q(
          'INSERT INTO scopehatch.scope_revisions(tenant_id,project_id,revision,intake_revision,author_id,unknowns,line_count,proposal) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',
          [tenant, projectId, revision, intake.revision, ctx.actorId,
            JSON.stringify(scope.unknowns), scope.deliverables.length,
            JSON.stringify(normalizedProposal)]
        );
        for (const [index, line] of scope.deliverables.entries())
          await q(
            'INSERT INTO scopehatch.scope_deliverables(tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source,client_description) ' +
            'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [tenant, projectId, revision, index, line.serviceId, line.quantity,
              line.evidence, line.source, line.clientDescription]
          );
        await audit('scope.created', projectId, revision, requestId);
        return scope;
      }
      async function createEstimate({ projectId, scopeRevision, catalogVersion, requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        await projectRow(projectId, true);
        const scope = await getScope(projectId, integer(scopeRevision, 'scopeRevision', 1));
        const latest = await getScope(projectId);
        if (scope.revision !== latest.revision) reject('STALE_REVISION', 'scope is not latest');
        const catalog = await getCatalog(integer(catalogVersion, 'catalogVersion', 1));
        const newestCatalog = await getCatalog();
        if (catalog.version !== newestCatalog.version) reject('STALE_REVISION', 'catalog is not latest');
        const estimate = estimateScope(scope, catalog);
        const max = await q(
          'SELECT coalesce(max(revision),0)::int AS revision FROM scopehatch.estimate_revisions WHERE tenant_id=$1 AND project_id=$2',
          [tenant, projectId]
        );
        const revision = max.rows[0].revision + 1;
        await q(
          'INSERT INTO scopehatch.estimate_revisions(tenant_id,project_id,revision,scope_revision,catalog_version,created_by,currency,state,total_minor,lines,blockers) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)',
          [tenant, projectId, revision, scopeRevision, catalogVersion, ctx.actorId,
            estimate.currency, estimate.state, estimate.totalMinor,
            JSON.stringify(estimate.lines), JSON.stringify(estimate.blockers)]
        );
        await audit('estimate.created', projectId, revision, requestId, { state: estimate.state });
        return { ...estimate, revision };
      }
      async function submitReview({ projectId, estimateRevision, requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        await projectRow(projectId, true);
        const estimate = await getEstimate(projectId, integer(estimateRevision, 'estimateRevision', 1));
        const scope = await getScope(projectId, estimate.scopeRevision);
        const result = validateSubmit({ scope, estimate, actor: { id: ctx.actorId, tenantId: tenant } });
        const id = randomUUID();
        const r = await q(
          'INSERT INTO scopehatch.reviews(tenant_id,project_id,id,estimate_revision,scope_revision,catalog_version,submitted_by) ' +
          'VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [tenant, projectId, id, estimateRevision, result.scopeRevision, result.catalogVersion, ctx.actorId]
        );
        await audit('review.submitted', projectId, estimate.scopeRevision, requestId);
        return presentReview(r.rows[0]);
      }
      async function approveReview({ projectId, reviewId, requestId } = {}) {
        requireRole(ctx, ['owner', 'reviewer']);
        const review = await getReview(projectId, reviewId);
        const scope = await getScope(projectId, review.scopeRevision);
        const estimate = await getEstimate(projectId, review.estimateRevision);
        validateApprove({ scope, estimate, review, actor: { id: ctx.actorId, tenantId: tenant, roles: ctx.roles } });
        // DB trigger serializes on tenant + project and re-checks newest revisions.
        // A failure aborts this transaction including its audit event.
        const r = await q(
          "UPDATE scopehatch.reviews SET state='approved',approved_by=$4,approved_at=now() " +
          "WHERE tenant_id=$1 AND project_id=$2 AND id=$3 AND state='pending' RETURNING *",
          [tenant, projectId, reviewId, ctx.actorId]
        );
        if (!r.rowCount) reject('STALE_REVIEW', 'already approved or no longer pending');
        await audit('review.approved', projectId, review.scopeRevision, requestId);
        return presentReview(r.rows[0]);
      }
      async function listAudit({ projectId, before, limit = 50 } = {}) {
        if (projectId !== undefined) await projectRow(projectId);
        integer(limit, 'limit', 1);
        if (limit > 100) reject('INVALID_INPUT', 'limit maximum 100');
        // Cursor is an opaque event id scoped by the same tenant and project.
        let cutoff = null;
        if (before !== undefined) {
          const r = await q(
            'SELECT created_at,id FROM scopehatch.audit_events WHERE tenant_id=$1 AND id=$2 ' +
            (projectId === undefined ? '' : 'AND project_id=$3'),
            projectId === undefined ? [tenant, before] : [tenant, before, projectId]
          );
          if (!r.rowCount) reject('INVALID_INPUT', 'invalid cursor');
          cutoff = r.rows[0];
        }
        const values = [tenant];
        let sql = 'SELECT * FROM scopehatch.audit_events WHERE tenant_id=$1';
        if (projectId !== undefined) { values.push(projectId); sql += ' AND project_id=$' + values.length; }
        if (cutoff) {
          values.push(cutoff.created_at, cutoff.id);
          sql += ' AND (created_at,id) < ($' + (values.length-1) + ',$' + values.length + ')';
        }
        values.push(limit + 1);
        const r = await q(sql + ' ORDER BY created_at DESC,id DESC LIMIT $' + values.length, values);
        const hasMore = r.rows.length > limit;
        const items = r.rows.slice(0, limit).map(a => ({
          id: a.id, tenantId: a.tenant_id, projectId: a.project_id,
          actorId: a.actor_id, action: a.action, objectRevision: a.object_revision,
          requestId: a.request_id, outcome: a.outcome, metadata: a.metadata, createdAt: a.created_at
        }));
        return { items, nextCursor: hasMore ? items.at(-1).id : null };
      }
      async function recordUsage({
        projectId = null, provider, model, status = 'unknown',
        inputTokens = null, outputTokens = null, requestId = randomUUID()
      } = {}) {
        if (status !== 'unknown' && status !== 'reported')
          reject('INVALID_INPUT', 'unsupported usage status');
        if (status === 'unknown' && (inputTokens !== null || outputTokens !== null))
          reject('INVALID_INPUT', 'unknown usage cannot be converted to zero');
        if (status === 'reported' && inputTokens === null && outputTokens === null)
          reject('INVALID_INPUT', 'reported usage needs measured tokens');
        if (inputTokens !== null) integer(inputTokens, 'inputTokens');
        if (outputTokens !== null) integer(outputTokens, 'outputTokens');
        if (projectId !== null) await projectRow(projectId);
        const id = randomUUID();
        await q(
          'INSERT INTO scopehatch.model_usage_events' +
          '(tenant_id,id,project_id,actor_id,provider,model,status,input_tokens,output_tokens,request_id)' +
          ' VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [tenant, id, projectId, ctx.actorId, string(provider, 'provider'),
            string(model, 'model'), status, inputTokens, outputTokens,
            string(requestId, 'requestId')]
        );
        return { id, tenantId: tenant, projectId, status, provider, model,
          inputTokens, outputTokens };
      }
      async function listUsage({ projectId, limit = 50 } = {}) {
        if (projectId !== undefined) await projectRow(projectId);
        integer(limit, 'limit', 1);
        if (limit > 100) reject('INVALID_INPUT', 'limit maximum 100');
        const r = await q(
          'SELECT id,tenant_id,project_id,provider,model,status,input_tokens,output_tokens,request_id,created_at ' +
          'FROM scopehatch.model_usage_events WHERE tenant_id=$1' +
          (projectId === undefined ? '' : ' AND project_id=$2') +
          ' ORDER BY created_at DESC,id DESC LIMIT $' +
          (projectId === undefined ? '2' : '3'),
          projectId === undefined ? [tenant, limit] : [tenant, projectId, limit]
        );
        return r.rows.map(row => ({
          id: row.id, tenantId: row.tenant_id, projectId: row.project_id,
          provider: row.provider, model: row.model, status: row.status,
          inputTokens: minor(row.input_tokens), outputTokens: minor(row.output_tokens),
          requestId: row.request_id, createdAt: row.created_at
        }));
      }
      async function idempotent({ key, operation, payload, execute } = {}) {
        string(key, 'idempotency key');
        if (key.length > 255) reject('INVALID_INPUT', 'idempotency key too long');
        string(operation, 'operation');
        if (typeof execute !== 'function') reject('INVALID_INPUT', 'execute callback required');
        const hash = digest({ operation, payload });
        // Advisory lock avoids a temporary, mutable "processing" row.
        // Even hash collisions only cause additional serialization.
        await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenant + '\x1f' + key]);
        const existing = await q(
          'SELECT * FROM scopehatch.idempotency_records WHERE tenant_id=$1 AND key=$2',
          [tenant, key]
        );
        if (existing.rowCount) {
          const record = existing.rows[0];
          if (record.request_hash !== hash || record.operation !== operation ||
              record.actor_id !== ctx.actorId)
            reject('IDEMPOTENCY_CONFLICT', 'key was previously used for another request or actor');
          return { replayed: true, result: record.response };
        }
        const result = await execute(repository);
        // JSON serialization is intentional: stored response is the replay authority.
        if (result === undefined) reject('INVALID_INPUT', 'idempotent result must be JSON serializable');
        await q(
          'INSERT INTO scopehatch.idempotency_records(tenant_id,key,actor_id,operation,request_hash,response) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
          [tenant, key, ctx.actorId, operation, hash, JSON.stringify(result)]
        );
        return { replayed: false, result };
      }
      const repository = Object.freeze({
        context: ctx, getProject, listProjects, createProject, createIntake, createCatalog, getCatalog,
        listCatalogs, createScope, getScope, createEstimate, getEstimate,
        submitReview, getReview, listReviews, approveReview, exportApproved,
        listAudit, recordUsage, listUsage, idempotent
      });
      const result = await work(repository);
      await client.query('COMMIT');
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* original failure is authoritative */ }
      }
      if (isUnique(error)) throw new PersistenceError('CONFLICT', 'duplicate record or revision');
      if (error?.code === '23503') throw new PersistenceError('NOT_FOUND', 'referenced object unavailable');
      if (error?.code === '42501') throw new PersistenceError('FORBIDDEN', 'database authorization rejected');
      if (error?.code === '22023') throw new PersistenceError('INVALID_INPUT', 'request contains invalid data');
      if (error?.code === '23514') throw new PersistenceError('STALE_REVISION', 'database constraint or stale revision');
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({ withPrincipal });
}
