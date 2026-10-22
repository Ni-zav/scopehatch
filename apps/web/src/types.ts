/** Sprint 01 + additive frozen Sprint 02 JSON wire types. */
export type Role = 'owner' | 'operator' | 'reviewer'
export type Source = 'brief' | 'manual'
export interface Service { id: string; label: string; unitPriceMinor: number }
export interface Catalog { tenantId: string; currency: string; version: number; services: Service[] }
export type ProjectStatus = 'draft' | 'blocked' | 'ready' | 'pending' | 'approved'
export interface ProjectSummary { id: string; title: string; status: ProjectStatus; createdAt: string }
export interface ProjectPage { items: ProjectSummary[]; nextCursor: string | null }
export interface CatalogCreate { baseVersion: number; currency: string; services: Service[] }
export interface ProposalMetadata {
  overview: string; assumptions: string[]; exclusions: string[]; commercialTerms: string[]
}
export interface Deliverable { serviceId: string; quantity: number | null; evidence: string; source: Source; clientDescription?: string }
export interface Scope {
  tenantId: string; projectId: string; revision: number; authorId: string
  brief: string; deliverables: Deliverable[]; unknowns: string[]; proposal?: ProposalMetadata
}
export interface Blocker { code: string; detail: string }
export interface EstimateLine extends Deliverable { quantity: number | null; unitPriceMinor: number | null; subtotalMinor: number | null }
export interface Estimate {
  tenantId: string; projectId: string; scopeRevision: number; catalogVersion: number
  currency: string; lines: EstimateLine[]; blockers: Blocker[]
  state: 'blocked' | 'ready'; totalMinor: number | null
}
export interface Review {
  tenantId: string; projectId: string; scopeRevision: number; catalogVersion: number
  state: 'pending' | 'approved'; submittedBy: string; approvedBy: string | null
}
export interface Project { id: string; title: string; brief: string; status: ProjectStatus; tenantId?: string }
export interface Snapshot { project: Project; latestScope?: Scope; latestEstimate?: Estimate; review?: Review }
export interface ProposalExport { projectId: string; revision: number; currency: string; totalMinor: number; markdown: string; proposal?: ProposalMetadata }
/** Event payload is not yet frozen beyond its semantic fields. Unknown fields remain untrusted. */
export interface AuditEvent {
  id?: string; action?: string; actorId?: string; outcome?: string
  timestamp?: string; createdAt?: string; scopeRevision?: number
  objectRevision?: number; requestId?: string; [key: string]: unknown
}
export interface AuditPage { items: AuditEvent[]; nextCursor: string | null }
export interface SuggestedDeliverable {
  serviceId: string
  quantity: number | null
  evidence: {start:number;end:number;quote:string} | null
}
export interface SuggestionResponse {
  suggestion:{ suggestedDeliverables:SuggestedDeliverable[]; unknowns:string[] }
  provenance:{ source:string; offsetEncoding:string; promptVersion:string;schemaVersion:string;requestId:string;evidenceVerified:boolean }
  model:string
  usage:{status:'reported'|'unknown';inputTokens?:number;outputTokens?:number}
}
export interface ScopehatchApi {
  suggestions?(id:string,revision?:number):Promise<SuggestionResponse>
  catalogs(): Promise<Catalog[]>
  createCatalog(body: CatalogCreate): Promise<Catalog>
  listProjects(options?: { cursor?: string; limit?: number }): Promise<ProjectPage>
  createProject(body: { title: string; brief: string }): Promise<Project>
  project(id: string): Promise<Snapshot>
  createScope(id: string, body: { deliverables: Deliverable[]; unknowns: string[]; proposal?: ProposalMetadata }): Promise<Scope>
  estimate(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Estimate>
  submitReview(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Review>
  approve(id: string, body: { scopeRevision: number; catalogVersion: number }): Promise<Review>
  export(id: string, revision: number): Promise<ProposalExport>
  audit(id: string, cursor?: string, limit?: number): Promise<AuditPage>
}
