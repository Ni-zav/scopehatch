export type Role = 'owner' | 'operator' | 'reviewer';
/** ONLY trusted, signature/issuer/audience/expiry-verified middleware may supply this. */
export interface VerifiedPrincipal {
  readonly id: string;
  readonly tenantId: string;
}
export interface CatalogService {
  id: string;
  label: string;
  /** Safe integer in ISO currency minor units. */
  unitPriceMinor: number;
}
export interface Catalog {
  tenantId: string;
  currency: string;
  version: number;
  services: CatalogService[];
}
export interface Deliverable {
  serviceId: string;
  quantity: number | null;
  evidence: string;
  source: 'brief' | 'manual';
}
export interface Scope {
  tenantId: string;
  projectId: string;
  revision: number;
  authorId: string;
  brief: string;
  deliverables: Deliverable[];
  unknowns: string[];
}
export interface EstimateLine extends Deliverable {
  unitPriceMinor: number | null;
  subtotalMinor: number | null;
}
export interface Estimate {
  tenantId: string;
  projectId: string;
  revision: number;
  scopeRevision: number;
  catalogVersion: number;
  currency: string;
  lines: EstimateLine[];
  blockers: Array<{ code: string; detail: string }>;
  state: 'blocked' | 'ready';
  totalMinor: number | null;
}
export interface Review {
  id: string;
  tenantId: string;
  projectId: string;
  estimateRevision: number;
  scopeRevision: number;
  catalogVersion: number;
  state: 'pending' | 'approved';
  submittedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
}
export interface AuditEvent {
  id: string;
  tenantId: string;
  projectId: string | null;
  actorId: string;
  action: string;
  objectRevision: number | null;
  requestId: string;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}
export interface PersistenceRepository {
  readonly context: Readonly<{ tenantId: string; actorId: string; roles: readonly Role[] }>;
  getProject(projectId: string): Promise<{
    id: string; title: string; brief: string;
    status: 'draft' | 'blocked' | 'ready' | 'pending' | 'approved';
  }>;
  createProject(input: { id?: string; title: string; brief: string; requestId?: string }): Promise<{
    id: string; title: string; brief: string; status: 'draft';
  }>;
  createIntake(input: { projectId: string; brief: string; requestId?: string }): Promise<{
    tenantId: string; projectId: string; revision: number; brief: string; authorId: string;
  }>;
  createCatalog(input: { currency: string; services: CatalogService[]; requestId?: string }): Promise<Catalog>;
  getCatalog(version?: number): Promise<Catalog>;
  listCatalogs(): Promise<Catalog[]>;
  createScope(input: {
    projectId: string; deliverables: Deliverable[]; unknowns?: string[]; requestId?: string;
  }): Promise<Scope>;
  getScope(projectId: string, revision?: number): Promise<Scope>;
  createEstimate(input: {
    projectId: string; scopeRevision: number; catalogVersion: number; requestId?: string;
  }): Promise<Estimate>;
  getEstimate(projectId: string, revision?: number): Promise<Estimate>;
  submitReview(input: { projectId: string; estimateRevision: number; requestId?: string }): Promise<Review>;
  getReview(projectId: string, reviewId: string): Promise<Review>;
  listReviews(projectId: string): Promise<Review[]>;
  exportApproved(projectId: string): Promise<{
    projectId: string; revision: number; currency: string; totalMinor: number; markdown: string;
  }>;
  approveReview(input: { projectId: string; reviewId: string; requestId?: string }): Promise<Review>;
  recordUsage(input: {
    projectId?: string | null; provider: string; model: string;
    status?: 'unknown' | 'reported'; inputTokens?: number | null;
    outputTokens?: number | null; requestId?: string;
  }): Promise<{
    id: string; tenantId: string; projectId: string | null;
    provider: string; model: string; status: 'unknown' | 'reported';
    inputTokens: number | null; outputTokens: number | null;
  }>;
  listUsage(input?: { projectId?: string; limit?: number }): Promise<Array<{
    id: string; tenantId: string; projectId: string | null; provider: string;
    model: string; status: 'unknown' | 'reported'; inputTokens: number | null;
    outputTokens: number | null; requestId: string; createdAt: Date;
  }>>;
  listAudit(input?: { projectId?: string; before?: string; limit?: number }): Promise<{
    items: AuditEvent[]; nextCursor: string | null;
  }>;
  /**
   * Must wrap externally side-effecting POST operations. Execution and persisted
   * JSON response commit atomically. Replay cannot bypass actor membership.
   */
  idempotent<T>(input: {
    key: string; operation: string; payload: unknown;
    execute: (tx: PersistenceRepository) => Promise<T>;
  }): Promise<{ replayed: boolean; result: T }>;
}
export interface PgQueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  release(): void;
}
export interface PgPoolLike {
  connect(): Promise<PgQueryClient>;
}
export class PersistenceError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}
export function createPersistence(pool: PgPoolLike): {
  /** All repository methods must execute inside this transaction. */
  withPrincipal<T>(principal: VerifiedPrincipal, work: (tx: PersistenceRepository) => Promise<T>): Promise<T>;
};
