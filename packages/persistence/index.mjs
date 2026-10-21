/**
 * PostgreSQL persistence for Scopehatch. The calling API MUST verify the JWT
 * signature, issuer, audience, expiry and selected tenant before passing actor.
 * SQL is parameterized, role is looked up from durable memberships, and every
 * call runs inside a transaction with SET LOCAL tenant/actor context.
 *
 * Never connect using the migration owner, a superuser, or a BYPASSRLS role.
 */
import { createHash, randomUUID } from 'node:crypto';
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
      evidence: l.evidence, source: l.source
    })),
    unknowns: scope.unknowns
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
        const project = await projectRow(projectId);
        const intake = await latestIntake(projectId);
        const scope = await q(
          'SELECT revision,intake_revision FROM scopehatch.scope_revisions WHERE tenant_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 1',
          [tenant, projectId]
        );
        const estimate = await q(
          'SELECT revision,scope_revision,catalog_version,state FROM scopehatch.estimate_revisions WHERE tenant_id=$1 AND project_id=$2 ORDER BY revision DESC LIMIT 1',
          [tenant, projectId]
        );
        const catalog = await q('SELECT max(version) AS version FROM scopehatch.catalog_versions WHERE tenant_id=$1', [tenant]);
        let status = 'draft';
        const scopeRow = scope.rows[0], estimateRow = estimate.rows[0];
        if (scopeRow && scopeRow.intake_revision === intake.revision && estimateRow &&
            estimateRow.scope_revision === scopeRow.revision &&
            estimateRow.catalog_version === catalog.rows[0].version) {
          status = estimateRow.state;
          if (status === 'ready') {
            const review = await q(
              'SELECT state FROM scopehatch.reviews WHERE tenant_id=$1 AND project_id=$2 AND estimate_revision=$3',
              [tenant, projectId, estimateRow.revision]
            );
            status = review.rows[0]?.state ?? 'ready';
          }
        }
        return { id: project.id, title: project.title, brief: intake.brief, status };
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
        return exportProposal({ scope, estimate, review: presentReview(reviewed.rows[0]) });
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
      async function createCatalog({ currency, services, requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        const r = await q('SELECT coalesce(max(version),0)::int AS version FROM scopehatch.catalog_versions WHERE tenant_id=$1', [tenant]);
        const version = r.rows[0].version + 1;
        const catalog = validateCatalog({ tenantId: tenant, currency, version, services });
        await q(
          'INSERT INTO scopehatch.catalog_versions(tenant_id,version,currency,created_by,service_count) VALUES($1,$2,$3,$4,$5)',
          [tenant, version, currency, ctx.actorId, catalog.services.length]
        );
        for (const s of catalog.services)
          await q(
            'INSERT INTO scopehatch.catalog_services(tenant_id,catalog_version,service_id,label,unit_price_minor) VALUES($1,$2,$3,$4,$5)',
            [tenant, version, s.id, s.label, s.unitPriceMinor]
          );
        await audit('catalog.created', null, version, requestId);
        return catalog;
      }
      async function createScope({ projectId, deliverables, unknowns = [], requestId } = {}) {
        requireRole(ctx, ['owner', 'operator']);
        // Lock order is the same in DB triggers: tenant first, project second.
        await q('SELECT id FROM scopehatch.tenants WHERE id=$1 FOR UPDATE', [tenant]);
        await projectRow(projectId, true);
        const intake = await latestIntake(projectId);
        const rev = await q(
          'SELECT coalesce(max(revision),0)::int AS revision FROM scopehatch.scope_revisions WHERE tenant_id=$1 AND project_id=$2',
          [tenant, projectId]
        );
        const revision = rev.rows[0].revision + 1;
        const scope = validateScope({
          tenantId: tenant, projectId, revision, authorId: ctx.actorId,
          brief: intake.brief, deliverables, unknowns
        });
        await q(
          'INSERT INTO scopehatch.scope_revisions(tenant_id,project_id,revision,intake_revision,author_id,unknowns,line_count) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',
          [tenant, projectId, revision, intake.revision, ctx.actorId, JSON.stringify(scope.unknowns), scope.deliverables.length]
        );
        for (const [index, d] of scope.deliverables.entries())
          await q(
            'INSERT INTO scopehatch.scope_deliverables(tenant_id,project_id,scope_revision,line_no,service_id,quantity,evidence,source) ' +
            'VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [tenant, projectId, revision, index, d.serviceId, d.quantity, d.evidence, d.source]
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
          ' ORDER BY created_at DESC,id DESC LIMIT 
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
        context: ctx, getProject, createProject, createIntake, createCatalog, getCatalog,
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
      if (error?.code === '23514') throw new PersistenceError('STALE_REVISION', 'database constraint or stale revision');
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({ withPrincipal });
}
 +
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
        context: ctx, getProject, createProject, createIntake, createCatalog, getCatalog,
        listCatalogs, createScope, getScope, createEstimate, getEstimate,
        submitReview, getReview, listReviews, approveReview, exportApproved, listAudit, idempotent
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
      if (error?.code === '23514') throw new PersistenceError('STALE_REVISION', 'database constraint or stale revision');
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({ withPrincipal });
}
