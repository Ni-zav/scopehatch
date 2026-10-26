/** This is an adapter contract, NOT an implementation of durable persistence. */
export type Role = 'owner' | 'operator' | 'reviewer';
export type Principal = Readonly<{ id: string; tenantId: string; roles: readonly Role[] }>;
export type Membership = Readonly<{
  subject: string; actorId: string; tenantId: string;
  roles: readonly Role[]; active: boolean;
}>;
export interface MembershipPort {
  /** Query a trusted identity-to-tenant membership registry, not JWT role claims. */
  findByVerifiedSubject(subject: string, issuer: string): Promise<readonly Membership[]>;
}
export type ServiceRate = Readonly<{ id: string; label: string; unitPriceMinor: number }>;
export type Catalog = Readonly<{ tenantId: string; currency: string; version: number; services: readonly ServiceRate[] }>;
export type ProjectStatus = 'draft' | 'blocked' | 'ready' | 'pending' | 'approved';
export type ProposalMetadata = Readonly<{overview:string;assumptions:readonly string[];exclusions:readonly string[];commercialTerms:readonly string[]}>;
export type ProjectSummary = Readonly<{id:string;title:string;status:ProjectStatus;createdAt:string}>;
export type ProjectPage = Readonly<{items:readonly ProjectSummary[];nextCursor:string|null}>;
export type Deliverable = Readonly<{
  serviceId: string; quantity: number | null; evidence: string; source: 'brief' | 'manual'; clientDescription?: string;
}>;
export type Scope = Readonly<{
  tenantId: string; projectId: string; revision: number; authorId: string;
  brief: string; deliverables: readonly Deliverable[]; unknowns: readonly string[]; proposal?: ProposalMetadata;
}>;
export type Estimate = Readonly<{
  tenantId: string; projectId: string; scopeRevision: number; catalogVersion: number;
  currency: string; lines: readonly Record<string, unknown>[];
  blockers: readonly { code: string; detail: string }[];
  state: 'blocked' | 'ready'; totalMinor: number | null;
}>;
export type Review = Readonly<{
  tenantId: string; projectId: string; scopeRevision: number; catalogVersion: number;
  state: 'pending' | 'approved'; submittedBy: string; approvedBy: string | null;
}>;
export type Project = Readonly<{
  id: string; tenantId: string; title: string; brief: string; status: ProjectStatus; createdAt?: string;
}>;
export type AuditEvent = Readonly<{
  id: string; tenantId: string; projectId: string; actorId: string;
  requestId: string; action: string; scopeRevision: number | null;
  outcome: 'success'; createdAt: string;
}>;
export type HttpResult = Readonly<{ status: number; body: unknown }>;
export type IdempotencyRecord = Readonly<{ digest: string; response: HttpResult }>;
export interface UnitOfWork {
  /** ALL methods MUST be scoped to the transaction's verified principal/tenant in DB/RLS. */
  getProject(id: string): Promise<Project | null>;
  insertProject(project: Project): Promise<void>;
  /** Catalogs for principal tenant only, ordered descending by version. */
  listCatalogs(): Promise<readonly Catalog[]>;
  getCatalog(version: number): Promise<Catalog | null>;
  /** Atomic owner-only compare-and-set + audit inside the same idempotent transaction. */
  createCatalogVersion?(input: {baseVersion:number;currency:string;services:readonly ServiceRate[]}): Promise<Catalog>;
  /** RLS-scoped keyset pagination; cursor MUST be tenant-bound and validated. */
  listProjects?(input:{limit:number;cursor?:string}):Promise<ProjectPage>;
  getLatestScope(projectId: string): Promise<Scope | null>;
  insertScope(scope: Scope): Promise<void>;
  getEstimate(projectId: string, scopeRevision: number, catalogVersion: number): Promise<Estimate | null>;
  insertEstimate(estimate: Estimate): Promise<void>;
  getReview(projectId: string, scopeRevision: number, catalogVersion: number): Promise<Review | null>;
  /** Read-only UI history fallback; never authorize approval/export from this method. */
  getLatestReview?(projectId: string): Promise<Review | null>;
  insertReview(review: Review): Promise<void>;
  /** Enforce compare-and-set: pending -> approved exactly once in this transaction. */
  approveReview(review: Review): Promise<void>;
  /** Events ordered by immutable append sequence, oldest first, for stable cursor pagination. */
  listAudit(projectId: string): Promise<readonly AuditEvent[]>;
  appendAudit(event: AuditEvent): Promise<void>;
  /** Unique (tenant, actor, method, path, key), locked until transaction commits. */
  getIdempotency(identity: string): Promise<IdempotencyRecord | null>;
  insertIdempotency(identity: string, record: IdempotencyRecord): Promise<void>;
}
export interface PersistencePort {
  /** Durable idempotency must encompass operation and persisted response in one transaction. */
  idempotent?(principal: Principal, input: {
    key: string; operation: string; payload: unknown;
    execute: (tx: UnitOfWork) => Promise<HttpResult>;
  }): Promise<HttpResult>;
  /** Exact export must be checked and read under database revision locks. */
  exportApproved?(principal: Principal, projectId: string, revision: number): Promise<unknown>;
  /** Must atomically commit/rollback all records; serialize conflicting commands.
   * Set RLS transaction context from principal only (never SQL session state inherited from pooled connections).
   */
  transaction<T>(principal: Principal, action: (tx: UnitOfWork) => Promise<T>): Promise<T>;
}
