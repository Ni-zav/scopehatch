/** Public JSON shapes in contracts/sprint-01-interface.md (design contract). */
export type Source = 'brief' | 'manual';
export type Evidence = string; // Current domain kernel stores brief citations as strings.

export interface Service { id: string; label: string; unitPriceMinor: number }
export interface Catalog { tenantId: string; currency: string; version: number; services: Service[] }
export interface Project { id: string; title: string; brief: string; status: 'draft' }
export interface Deliverable { serviceId: string; quantity: number | null; evidence: Evidence; source: Source }
export interface Scope {
  tenantId: string; projectId: string; revision: number; authorId: string;
  brief: string; deliverables: Deliverable[]; unknowns: string[];
}
export interface EstimateLine {
  serviceId: string; quantity: number | null; unitPriceMinor: number | null;
  subtotalMinor: number | null; evidence: Evidence; source: Source;
}
export interface Blocker { code: string; detail: string }
export interface Estimate {
  tenantId: string; projectId: string; scopeRevision: number; catalogVersion: number;
  currency: string; lines: EstimateLine[]; blockers: Blocker[];
  state: 'blocked' | 'ready'; totalMinor: number | null;
}
export interface Review {
  tenantId: string; projectId: string; scopeRevision: number; catalogVersion: number;
  state: 'pending' | 'approved'; submittedBy: string; approvedBy: string | null;
}
export interface ExportedProposal {
  projectId: string; revision: number; currency: string; totalMinor: number; markdown: string;
}
/** Audit event structure is not frozen beyond existence of a paginated event list. */
export type AuditEvent = Record<string, unknown>;
export interface AuditPage { items: AuditEvent[]; nextCursor: string | null }

export interface CreateProjectRequest { title: string; brief: string }
export interface CreateScopeRequest { deliverables: Deliverable[]; unknowns: string[] }
export interface RevisionBinding { scopeRevision: number; catalogVersion: number }
export interface SuggestionRequest { scopeRevision?: number }
/** Suggestions are untrusted drafts, never authoritative prices or approval decisions. */
export interface SuggestionResult { suggestion: unknown; provenance: unknown; model: unknown; usage: unknown }

export interface ProjectDetails {
  project: Project; latestScope?: Scope; latestEstimate?: Estimate; review?: Review;
}
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface WriteOptions extends RequestOptions { idempotencyKey: string; retry?: boolean }
export interface AuditOptions extends RequestOptions { cursor?: string; limit?: number }
export interface CredentialProvider {
  getAccessToken(signal?: AbortSignal): string | Promise<string>;
}
export type FetchTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface ScopehatchClientOptions {
  baseUrl: string;
  credentials: CredentialProvider;
  fetch?: FetchTransport;
  timeoutMs?: number;
  /** Number of retries after the first attempt, maximum 5; defaults to 2 on GET and 0 on POST. */
  maxRetries?: number;
  /** Initial exponential retry delay, defaults to 150ms; set to 0 in deterministic tests. */
  retryDelayMs?: number;
  /** Bounds server Retry-After, defaults to 2000ms. */
  maxRetryDelayMs?: number;
  /** Maximum JSON response text length in UTF-16 code units, defaults to 1 MiB. */
  maxResponseChars?: number;
}
