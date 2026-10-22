import { createHash, randomUUID } from 'node:crypto';
import type { AuditEvent, Catalog, Deliverable, Estimate, HttpResult, PersistencePort, Principal, Project, Review, Scope, UnitOfWork, ProposalMetadata } from './ports.ts';
import { normalizeScope, normalizeProposal, validateProposal } from './proposal.ts';
// Root JS domain kernel is frozen by another owner and has no TS declaration file.
// @ts-expect-error External .mjs boundary; model typing is enforced by local port types.
import { createScopeRevision, estimateScope, submitReview, approveReview, exportProposal } from '../../../src/domain.mjs';

export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
const fail = (code: string, status: number, message: string): never => { throw new ApiError(code, status, message); };
export const validRoles = ['owner', 'operator', 'reviewer'] as const;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

function requireProject(project: Project | null): Project {
  return project ?? fail('NOT_FOUND', 404, 'Resource not found');
}
function requireRole(principal: Principal, ...roles: string[]): void {
  if (!principal.roles.some(r => roles.includes(r))) fail('FORBIDDEN', 403, 'Insufficient permission');
}
function latestOrConflict<T>(record: T | null, kind: string): T {
  return record ?? fail('STALE_REVISION', 409, 'No current ' + kind + ' exists');
}
function requireCurrent(scope: Scope | null, revision: number): Scope {
  if (!scope || scope.revision !== revision) fail('STALE_REVISION', 409, 'Scope revision is no longer current');
  return scope!;
}
function requireCatalog(catalogs: readonly Catalog[], version: number): Catalog {
  if (catalogs[0]?.version !== version) fail('STALE_REVISION', 409, 'Catalog version is no longer current');
  return catalogs[0]!;
}
function requireBoundEstimate(estimate: Estimate | null): Estimate {
  return latestOrConflict(estimate, 'estimate');
}
function audit(tx: UnitOfWork, principal: Principal, projectId: string, requestId: string, action: string, scopeRevision: number | null): Promise<void> {
  const event: AuditEvent = { id: randomUUID(), tenantId: principal.tenantId, projectId,
    actorId: principal.id, requestId, action, scopeRevision, outcome: 'success', createdAt: new Date().toISOString() };
  return tx.appendAudit(event);
}

export class ApplicationService {
  constructor(private readonly store: PersistencePort) {}
  private read<T>(principal: Principal, action: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.store.transaction(principal, action);
  }
  private write(principal: Principal, method: string, path: string, key: string, body: unknown, operation: (tx: UnitOfWork) => Promise<HttpResult>): Promise<HttpResult> {
    if (!key || key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) fail('IDEMPOTENCY_KEY_REQUIRED', 422, 'A valid Idempotency-Key is required');
    const identity = [principal.tenantId, principal.id, method, path, key].join('\0');
    const inputHash = digest(body);
    if (this.store.idempotent) {
      return this.store.idempotent(principal, {
        key, operation: method + ' ' + path, payload: body, execute: operation
      });
    }
    return this.store.transaction(principal, async tx => {
      const previous = await tx.getIdempotency(identity);
      if (previous) {
        if (previous.digest !== inputHash) fail('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key was already used with different input');
        return previous.response;
      }
      const response = await operation(tx);
      await tx.insertIdempotency(identity, { digest: inputHash, response });
      return response;
    });
  }
  catalogs(principal: Principal) { return this.read(principal, async tx => ({ items: await tx.listCatalogs() })); }
  createCatalog(principal: Principal, key: string, data: {baseVersion:number;currency:string;services:{id:string;label:string;unitPriceMinor:number}[]}, requestId:string):Promise<HttpResult> {
    requireRole(principal, 'owner');
    if(!Number.isSafeInteger(data.baseVersion)||data.baseVersion<0||!(/^[A-Z]{3}$/.test(data.currency))||
      !Intl.supportedValuesOf('currency').includes(data.currency))
      fail('INVALID_INPUT',422,'Invalid catalog version or ISO currency');
    if(!Array.isArray(data.services)||data.services.length<1||data.services.length>200)
      fail('INVALID_INPUT',422,'Catalog requires 1 to 200 services');
    const seen=new Set<string>();
    for(const entry of data.services) {
      if(!entry.id.trim()||!entry.label.trim())fail('INVALID_INPUT',422,'Service ID and label are required');
      if(seen.has(entry.id.trim()))fail('DUPLICATE_SERVICE',422,'Duplicate service ID');
      seen.add(entry.id.trim());
      if(!Number.isSafeInteger(entry.unitPriceMinor)||entry.unitPriceMinor<0)fail('MONEY_OVERFLOW',422,'Invalid rate');
    }
    return this.write(principal,'POST','/v1/catalogs',key,data,async tx=>{
      if(!tx.createCatalogVersion)fail('DEPENDENCY_UNAVAILABLE',503,'Catalog persistence adapter unavailable');
      const catalog=await tx.createCatalogVersion!({baseVersion:data.baseVersion,currency:data.currency,services:data.services});
      // Persistence owns catalog audit in the same tenant-serialized transaction.
      return {status:201,body:{catalog}};
    });
  }
  listProjects(principal:Principal, cursor:string|undefined, limit:number) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('INVALID_INPUT',422,'Invalid project page size');
    if(cursor!==undefined&&(!/^[A-Za-z0-9._~-]{1,512}$/.test(cursor)))fail('INVALID_CURSOR',422,'Invalid project cursor');
    return this.read(principal,async tx=>{
      if(!tx.listProjects)fail('DEPENDENCY_UNAVAILABLE',503,'Project index adapter unavailable');
      return tx.listProjects!({limit,cursor});
    });
  }
  project(principal: Principal, id: string) {
    return this.read(principal, async tx => {
      const project = requireProject(await tx.getProject(id));
      const latestScope = await tx.getLatestScope(id);
      const catalogs = await tx.listCatalogs();
      const latestEstimate = latestScope && catalogs[0] ? await tx.getEstimate(id, latestScope.revision, catalogs[0].version) : null;
      const currentReview = latestScope && catalogs[0] ? await tx.getReview(id, latestScope.revision, catalogs[0].version) : null;
      const review = currentReview ?? await tx.getLatestReview?.(id) ?? null;
      return { project, ...(latestScope && { latestScope: normalizeScope(latestScope) }), ...(latestEstimate && { latestEstimate }), ...(review && { review }) };
    });
  }
  createProject(principal: Principal, key: string, data: { title: string; brief: string }, requestId: string): Promise<HttpResult> {
    requireRole(principal, 'owner', 'operator');
    return this.write(principal, 'POST', '/v1/projects', key, data, async tx => {
      if (!data.title.trim() || !data.brief.trim()) fail('INVALID_INPUT', 422, 'Title and brief must not be blank');
      const project: Project = { id: randomUUID(), tenantId: principal.tenantId,
        title: data.title.trim(), brief: data.brief.trim(), status: 'draft' };
      await tx.insertProject(project);
      await audit(tx, principal, project.id, requestId, 'project.created', null);
      return { status: 201, body: { project: { id: project.id, title: project.title, brief: project.brief, status: project.status } } };
    });
  }
  createScope(principal: Principal, id: string, key: string, data: { deliverables: Deliverable[]; unknowns: string[]; proposal?:ProposalMetadata }, requestId: string): Promise<HttpResult> {
    requireRole(principal, 'owner', 'operator');
    return this.write(principal, 'POST', '/v1/projects/' + id + '/scopes', key, data, async tx => {
      const project = requireProject(await tx.getProject(id));
      validateProposal(data.proposal,data.deliverables);
      const prior = await tx.getLatestScope(id);
      for (const d of data.deliverables) {
        if (d.source === 'brief' && (!d.evidence.trim() || !project.brief.includes(d.evidence)))
          fail('EVIDENCE_NOT_IN_BRIEF', 422, 'Brief evidence must quote the source text exactly');
      }
      // The frozen Sprint 01 kernel validates evidence and quantities, but knows no proposal fields.
      // These additional fields belong to exactly this immutable scope revision.
      const checked: Scope = createScopeRevision({ tenantId: principal.tenantId, projectId: id,
        authorId: principal.id, revision: (prior?.revision ?? 0) + 1, brief: project.brief,
        deliverables: data.deliverables, unknowns: data.unknowns });
      const scope=normalizeScope({...checked,deliverables:checked.deliverables.map((d,i)=>({
        ...d,clientDescription:data.deliverables[i]?.clientDescription??''
      })),proposal:normalizeProposal(data.proposal)});
      await tx.insertScope(scope);
      await audit(tx, principal, id, requestId, 'scope.created', scope.revision);
      return { status: 201, body: { scope } };
    });
  }
  createEstimate(principal: Principal, id: string, key: string, data: { scopeRevision: number; catalogVersion: number }, requestId: string): Promise<HttpResult> {
    requireRole(principal, 'owner', 'operator');
    return this.write(principal, 'POST', '/v1/projects/' + id + '/estimates', key, data, async tx => {
      requireProject(await tx.getProject(id));
      const scope = requireCurrent(await tx.getLatestScope(id), data.scopeRevision);
      const catalog = requireCatalog(await tx.listCatalogs(), data.catalogVersion);
      const prior = await tx.getEstimate(id, scope.revision, catalog.version);
      if (prior) fail('ALREADY_EXISTS', 409, 'Estimate already exists for this revision and catalog');
      const estimate: Estimate = estimateScope(scope, catalog);
      await tx.insertEstimate(estimate);
      await audit(tx, principal, id, requestId, 'estimate.created', scope.revision);
      return { status: 201, body: { estimate } };
    });
  }
  submit(principal: Principal, id: string, key: string, data: { scopeRevision: number; catalogVersion: number }, requestId: string): Promise<HttpResult> {
    requireRole(principal, 'owner', 'operator');
    return this.write(principal, 'POST', '/v1/projects/' + id + '/reviews', key, data, async tx => {
      requireProject(await tx.getProject(id));
      const scope = requireCurrent(await tx.getLatestScope(id), data.scopeRevision);
      requireCatalog(await tx.listCatalogs(), data.catalogVersion);
      const estimate = requireBoundEstimate(await tx.getEstimate(id, data.scopeRevision, data.catalogVersion));
      if (await tx.getReview(id, data.scopeRevision, data.catalogVersion)) fail('ALREADY_EXISTS', 409, 'Review already submitted');
      const review: Review = submitReview({ scope, estimate, actor: principal });
      await tx.insertReview(review);
      await audit(tx, principal, id, requestId, 'review.submitted', scope.revision);
      return { status: 201, body: { review } };
    });
  }
  approve(principal: Principal, id: string, key: string, data: { scopeRevision: number; catalogVersion: number }, requestId: string): Promise<HttpResult> {
    requireRole(principal, 'owner', 'reviewer');
    return this.write(principal, 'POST', '/v1/projects/' + id + '/approve', key, data, async tx => {
      requireProject(await tx.getProject(id));
      const scope = requireCurrent(await tx.getLatestScope(id), data.scopeRevision);
      requireCatalog(await tx.listCatalogs(), data.catalogVersion);
      const estimate = requireBoundEstimate(await tx.getEstimate(id, data.scopeRevision, data.catalogVersion));
      const review = latestOrConflict(await tx.getReview(id, data.scopeRevision, data.catalogVersion), 'review');
      const approved: Review = approveReview({ scope, estimate, review, actor: principal });
      await tx.approveReview(approved);
      await audit(tx, principal, id, requestId, 'review.approved', scope.revision);
      return { status: 200, body: { review: approved } };
    });
  }
  export(principal: Principal, id: string, revision: number) {
    if (this.store.exportApproved) return this.store.exportApproved(principal, id, revision);
    return this.read(principal, async tx => {
      requireProject(await tx.getProject(id));
      const scope = requireCurrent(await tx.getLatestScope(id), revision);
      const catalog = latestOrConflict((await tx.listCatalogs())[0] ?? null, 'catalog');
      const estimate = requireBoundEstimate(await tx.getEstimate(id, revision, catalog.version));
      const review = await tx.getReview(id, revision, catalog.version);
      const approved=exportProposal({ scope, estimate, review });
      return {...approved,proposal:normalizeProposal(scope.proposal)};
    });
  }
  audit(principal: Principal, id: string, cursor: string | undefined, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT', 422, 'limit must be an integer between 1 and 100');
    return this.read(principal, async tx => {
      requireProject(await tx.getProject(id));
      const events = await tx.listAudit(id);
      let start = 0;
      if (cursor !== undefined) {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) fail('INVALID_CURSOR', 422, 'Invalid cursor');
        const previousId = Buffer.from(cursor, 'base64url').toString('utf8');
        const index = events.findIndex(event => event.id === previousId);
        if (index === -1) fail('INVALID_CURSOR', 422, 'Unknown cursor');
        start = index + 1;
      }
      const items = events.slice(start, start + limit);
      const nextCursor = start + limit < events.length && items.length ? Buffer.from(items[items.length - 1]!.id).toString('base64url') : null;
      return { items, nextCursor };
    });
  }
  async suggestions(principal: Principal, id: string): Promise<never> {
    await this.read(principal, async tx => { requireProject(await tx.getProject(id)); });
    return fail('PROVIDER_UNAVAILABLE', 503, 'Suggestion provider is not configured');
  }
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code;
    const statuses: Record<string, number> = {
      INVALID_INPUT: 422, DUPLICATE_SERVICE: 422, MONEY_OVERFLOW: 422,
      STALE_ESTIMATE: 409, STALE_REVIEW: 409, STALE_REVISION: 409,
      STALE_CATALOG_VERSION:409, INVALID_CURSOR:422, DEPENDENCY_UNAVAILABLE:503,
      CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, ALREADY_EXISTS: 409,
      NOT_FOUND: 404, EVIDENCE_NOT_IN_BRIEF: 422,
      BUDGET_NOT_CONFIGURED: 503, NO_ELIGIBLE_PROVIDER: 503,
      QUOTA_EXCEEDED: 429, INFERENCE_IN_PROGRESS: 409,
      PROVIDER_FAILED: 503, PROVIDER_UNAVAILABLE: 503,
      PROVIDER_AUTH: 503, INVALID_PROVIDER_CONFIG: 503,
      INVALID_MODEL_OUTPUT: 502, UNVERIFIABLE_EVIDENCE: 502,
      UNVERIFIABLE_QUANTITY: 502, OUTPUT_TOO_LARGE: 502,
      TIMEOUT: 504, INVALID_USAGE: 422, INVALID_TRANSITION: 409,
      APPROVAL_REQUIRED: 409,
      BLOCKED_ESTIMATE: 409, SELF_APPROVAL: 403, FORBIDDEN: 403, TENANT_MISMATCH: 404
    };
    if (statuses[code]) return new ApiError(code, statuses[code],
      statuses[code] === 404 ? 'Resource not found' :
      statuses[code] === 403 ? 'Operation forbidden' :
      statuses[code] === 422 ? 'Invalid request data' :
      statuses[code] === 429 ? 'Inference budget exceeded' :
      statuses[code] === 503 ? 'Governed inference unavailable' :
      statuses[code] === 502 ? 'Inference response failed evidence validation' :
      statuses[code] === 504 ? 'Inference provider timed out; spending is being reconciled' :
      'Operation conflicts with current state');
  }
  return new ApiError('INTERNAL_ERROR', 500, 'Internal server error');
}
