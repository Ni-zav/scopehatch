/** Explicit single-process, test-only double. NOT durable or suitable for real deployments. */
import type { AuditEvent, Catalog, Estimate, IdempotencyRecord, Membership, MembershipPort, PersistencePort, Principal, Project, Review, Scope, UnitOfWork } from './ports.ts';

type MemoryState = {
  projects: Project[]; catalogs: Catalog[]; scopes: Scope[]; estimates: Estimate[];
  reviews: Review[]; audits: AuditEvent[]; idempotency: Record<string, IdempotencyRecord>;
};
export class FakeMemberships implements MembershipPort {
  constructor(private readonly rows: Membership[]) {}
  async findByVerifiedSubject(subject: string): Promise<readonly Membership[]> {
    return this.rows.filter(row => row.subject === subject);
  }
}
export class MemoryTestDouble implements PersistencePort {
  private state: MemoryState;
  private tail: Promise<void> = Promise.resolve();
  constructor(catalogs: Catalog[] = []) {
    this.state = { projects: [], catalogs: structuredClone(catalogs), scopes: [], estimates: [],
      reviews: [], audits: [], idempotency: {} };
  }
  /** In-process serial transaction with rollback on failure; no multi-instance guarantees. */
  async transaction<T>(principal: Principal, work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    const snapshot: MemoryState = structuredClone(this.state);
    const tenantId = principal.tenantId;
    const projectKey = (projectId: string) => snapshot.projects.some(p => p.id === projectId && p.tenantId === tenantId);
    const owned = (tenant: string) => tenant === tenantId;
    const check = (tenant: string) => { if (!owned(tenant)) throw new Error('Transaction tenant mismatch'); };
    const tx: UnitOfWork = {
      getProject: async id => snapshot.projects.find(p => p.id === id && owned(p.tenantId)) ?? null,
      insertProject: async p => { check(p.tenantId); if (projectKey(p.id)) throw new Error('Duplicate project'); snapshot.projects.push(p); },
      listCatalogs: async () => snapshot.catalogs.filter(c => owned(c.tenantId)).sort((a, b) => b.version - a.version),
      getCatalog: async version => snapshot.catalogs.find(c => c.version === version && owned(c.tenantId)) ?? null,
      getLatestScope: async projectId => snapshot.scopes.filter(s => s.projectId === projectId && owned(s.tenantId) && projectKey(projectId)).sort((a, b) => b.revision - a.revision)[0] ?? null,
      insertScope: async s => {
        check(s.tenantId);
        if (!projectKey(s.projectId) || snapshot.scopes.some(r => r.projectId === s.projectId && r.revision === s.revision)) throw new Error('Scope conflict');
        snapshot.scopes.push(s);
      },
      getEstimate: async (projectId, scopeRevision, catalogVersion) => snapshot.estimates.find(e => projectKey(projectId) && owned(e.tenantId) && e.projectId === projectId && e.scopeRevision === scopeRevision && e.catalogVersion === catalogVersion) ?? null,
      insertEstimate: async e => {
        check(e.tenantId);
        if (!projectKey(e.projectId) || snapshot.estimates.some(r => r.projectId === e.projectId && r.scopeRevision === e.scopeRevision && r.catalogVersion === e.catalogVersion)) throw new Error('Estimate conflict');
        snapshot.estimates.push(e);
      },
      getReview: async (projectId, scopeRevision, catalogVersion) => snapshot.reviews.find(r => projectKey(projectId) && owned(r.tenantId) && r.projectId === projectId && r.scopeRevision === scopeRevision && r.catalogVersion === catalogVersion) ?? null,
      insertReview: async r => {
        check(r.tenantId);
        if (!projectKey(r.projectId) || snapshot.reviews.some(q => q.projectId === r.projectId && q.scopeRevision === r.scopeRevision && q.catalogVersion === r.catalogVersion)) throw new Error('Review conflict');
        snapshot.reviews.push(r);
      },
      approveReview: async r => {
        check(r.tenantId);
        const index = snapshot.reviews.findIndex(v => v.projectId === r.projectId && owned(v.tenantId) && v.scopeRevision === r.scopeRevision && v.catalogVersion === r.catalogVersion);
        if (index === -1 || snapshot.reviews[index]!.state !== 'pending') throw new Error('Review compare-and-set failed');
        snapshot.reviews[index] = r;
      },
      listAudit: async projectId => snapshot.audits.filter(e => e.projectId === projectId && owned(e.tenantId) && projectKey(projectId)),
      appendAudit: async e => { check(e.tenantId); if (!projectKey(e.projectId)) throw new Error('Unknown project'); snapshot.audits.push(e); },
      getIdempotency: async identity => snapshot.idempotency[identity] ?? null,
      insertIdempotency: async (identity, record) => {
        if (snapshot.idempotency[identity]) throw new Error('Duplicate idempotency key');
        snapshot.idempotency[identity] = record;
      }
    };
    try {
      const result = await work(tx);
      this.state = snapshot;
      return result;
    } finally { unlock(); }
  }
}
