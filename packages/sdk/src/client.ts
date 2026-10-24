import type {
  AuditOptions, AuditPage, Catalog, CreateCatalogRequest, CreateProjectRequest, CreateScopeRequest,
  CredentialProvider, Estimate, ExportedProposal, FetchTransport, ListProjectsOptions, ProjectDetails,
  ProjectPage, ProposalMetadata,
  RequestOptions, RevisionBinding, Review, Scope, ScopehatchClientOptions,
  SuggestionRequest, SuggestionResult, WriteOptions,
} from './types.js';
import {
  ScopehatchAbortError, ScopehatchAuthenticationError, ScopehatchConfigurationError,
  ScopehatchHttpError, ScopehatchNetworkError, ScopehatchProtocolError, ScopehatchTimeoutError,
} from './errors.js';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_TIMEOUT = 15_000;

function wholeNumber(value: number, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ScopehatchConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
function segment(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ScopehatchConfigurationError('projectId must be non-empty');
  return encodeURIComponent(value);
}
function revision(value: number): number { return wholeNumber(value, 'revision', 1); }
function keyOf(options: WriteOptions): string {
  const value = options?.idempotencyKey;
  if (typeof value !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(value)) {
    throw new ScopehatchConfigurationError('idempotencyKey must be 1-128 printable ASCII characters without spaces');
  }
  return value;
}
function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function envelope<T>(value: unknown, key: string): T {
  if (!asRecord(value) || !Object.hasOwn(value, key)) throw new ScopehatchProtocolError();
  return value[key] as T;
}
function retryAfterMs(header: string | null, maximum: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const millis = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : Date.parse(header) - Date.now();
  if (!Number.isFinite(millis) || millis < 0) return undefined;
  return Math.min(Math.ceil(millis), maximum);
}
function validateBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ScopehatchConfigurationError('baseUrl must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ScopehatchConfigurationError('baseUrl must be an HTTP(S) URL without userinfo, query or fragment');
  }
  // Authorization headers contain bearer tokens: never send them over an
  // unencrypted remote connection. Only literal local-loopback endpoints may
  // use HTTP for a developer's single-machine test stack.
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new ScopehatchConfigurationError('Remote Scopehatch APIs require HTTPS');
  }
  return url.href.replace(/\/+$/, '');
}


const STATUS = new Set(['draft', 'blocked', 'ready', 'pending', 'approved']);
const CURSOR = /^[A-Za-z0-9._~-]{1,512}$/;
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function currencyCode(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false;
  try {
    // Intl.NumberFormat accepts invented three-letter codes; supportedValuesOf does not.
    if (!Intl.supportedValuesOf('currency').includes(value)) return false;
    new Intl.NumberFormat('en', { style: 'currency', currency: value });
    return true;
  } catch { return false; }
}
function optionalCursor(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CURSOR.test(value)) {
    throw new ScopehatchConfigurationError(label + ' must be 1-512 URL-safe characters');
  }
  return value;
}
function validateCatalogInput(input: CreateCatalogRequest): CreateCatalogRequest {
  if (!asRecord(input)) throw new ScopehatchConfigurationError('Catalog input is required');
  wholeNumber(input.baseVersion, 'baseVersion', 0);
  if (!currencyCode(input.currency)) throw new ScopehatchConfigurationError('Invalid ISO currency code');
  if (!Array.isArray(input.services) || input.services.length < 1 || input.services.length > 200) {
    throw new ScopehatchConfigurationError('services must contain 1-200 entries');
  }
  const seen = new Set<string>();
  const services = input.services.map((s, i) => {
    if (!asRecord(s) || !nonempty(s.id) || !nonempty(s.label)) {
      throw new ScopehatchConfigurationError('Each service requires an id and label');
    }
    if (seen.has(s.id)) throw new ScopehatchConfigurationError('Duplicate service id');
    seen.add(s.id);
    wholeNumber(s.unitPriceMinor as number, 'services[' + i + '].unitPriceMinor', 0);
    return { id: s.id, label: s.label, unitPriceMinor: s.unitPriceMinor as number };
  });
  return { baseVersion: input.baseVersion, currency: input.currency, services };
}
function serializeProposal(value: ProposalMetadata): ProposalMetadata {
  if (!asRecord(value) || typeof value.overview !== 'string' || value.overview.length > 4000) {
    throw new ScopehatchConfigurationError('proposal.overview must be 0-4000 characters');
  }
  const strings = (field: 'assumptions' | 'exclusions' | 'commercialTerms'): string[] => {
    const v = value[field];
    if (!Array.isArray(v) || v.length > 50 || v.some(x => typeof x !== 'string' ||
      x.trim().length < 1 || x.trim().length > 2000)) {
      throw new ScopehatchConfigurationError('Invalid proposal.' + field);
    }
    return v.slice(); // preserve human-authored text; trim only for validation
  };
  return {
    overview: value.overview,
    assumptions: strings('assumptions'),
    exclusions: strings('exclusions'),
    commercialTerms: strings('commercialTerms'),
  };
}
function clientDescription(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) {
    throw new ScopehatchConfigurationError('clientDescription must be 0-2000 characters');
  }
  return value;
}
function validateMetadataSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536) {
    throw new ScopehatchConfigurationError('Proposal metadata exceeds 64 KiB');
  }
}
function projectPage(value: unknown): ProjectPage {
  if (!asRecord(value) || !Array.isArray(value.items) ||
    !(value.nextCursor === null || (typeof value.nextCursor === 'string' && CURSOR.test(value.nextCursor)))) {
    throw new ScopehatchProtocolError();
  }
  const items = value.items.map(item => {
    if (!asRecord(item) || !nonempty(item.id) || typeof item.title !== 'string' ||
      typeof item.status !== 'string' || !STATUS.has(item.status) ||
      typeof item.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(item.createdAt) ||
      !Number.isFinite(Date.parse(item.createdAt))) throw new ScopehatchProtocolError();
    // Do not expose an unexpected brief or tenant field from a malformed list implementation.
    return { id: item.id, title: item.title, status: item.status as ProjectPage['items'][number]['status'],
      createdAt: item.createdAt };
  });
  return { items, nextCursor: value.nextCursor as string | null };
}
function catalogResponse(value: unknown): Catalog {
  const catalog = envelope<unknown>(value, 'catalog');
  if (!asRecord(catalog) || !nonempty(catalog.tenantId) ||
    !currencyCode(catalog.currency) || !Number.isSafeInteger(catalog.version) ||
    (catalog.version as number) < 1 || !Array.isArray(catalog.services) ||
    catalog.services.length < 1 || catalog.services.length > 200 ||
    catalog.services.some(service => !asRecord(service) || !nonempty(service.id) ||
      !nonempty(service.label) || !Number.isSafeInteger(service.unitPriceMinor) ||
      (service.unitPriceMinor as number) < 0)) {
    throw new ScopehatchProtocolError();
  }
  return catalog as unknown as Catalog;
}

export function staticBearerToken(token: string): CredentialProvider {
  return { getAccessToken: () => token };
}

/** All operations invoke the same governed HTTP API as the human workbench. */
export class ScopehatchClient {
  private readonly baseUrl: string;
  private readonly credentials: CredentialProvider;
  private readonly transport: FetchTransport;
  private readonly workspaceId: string | (() => string | null) | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxResponseChars: number;

  constructor(options: ScopehatchClientOptions) {
    if (!options || typeof options !== 'object') throw new ScopehatchConfigurationError('Client options are required');
    this.baseUrl = validateBaseUrl(options.baseUrl);
    if (!options.credentials || typeof options.credentials.getAccessToken !== 'function') {
      throw new ScopehatchConfigurationError('A credential provider is required');
    }
    this.credentials = options.credentials;
    this.workspaceId = options.workspaceId;
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (typeof this.transport !== 'function') throw new ScopehatchConfigurationError('A fetch transport is required');
    this.timeoutMs = wholeNumber(options.timeoutMs ?? DEFAULT_TIMEOUT, 'timeoutMs', 1);
    this.maxRetries = wholeNumber(options.maxRetries ?? 2, 'maxRetries', 0, 5);
    this.retryDelayMs = wholeNumber(options.retryDelayMs ?? 150, 'retryDelayMs', 0, 60_000);
    this.maxRetryDelayMs = wholeNumber(options.maxRetryDelayMs ?? 2000, 'maxRetryDelayMs', 0, 60_000);
    this.maxResponseChars = wholeNumber(options.maxResponseChars ?? 1_048_576, 'maxResponseChars', 1);
  }

  private async request<T>(
    method: 'GET' | 'POST', path: string, options: RequestOptions = {}, body?: unknown,
    writeOptions?: WriteOptions,
  ): Promise<T> {
    const timeoutMs = wholeNumber(options.timeoutMs ?? this.timeoutMs, 'timeoutMs', 1);
    const idempotencyKey = method === 'POST' ? keyOf(writeOptions as WriteOptions) : undefined;
    const retries = method === 'GET' || (method === 'POST' && writeOptions?.retry === true)
      ? this.maxRetries : 0;
    const controller = new AbortController();
    let timedOut = false;
    const externalSignal = options.signal;
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) throw new ScopehatchAbortError();
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const abortError = () => timedOut ? new ScopehatchTimeoutError() : new ScopehatchAbortError();
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) throw abortError();
        let response: Response;
        try {
          const token = await Promise.race([this.credentials.getAccessToken(controller.signal), cancelled]);
          if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
            throw new ScopehatchAuthenticationError();
          }
          const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          };
          const selection = typeof this.workspaceId === 'function'
            ? this.workspaceId() : this.workspaceId;
          if(selection !== undefined && selection !== null && selection !== ''){
            if(typeof selection !== 'string' || selection.length > 200 ||
               !/^[\x20-\x7E]+$/.test(selection))
              throw new ScopehatchConfigurationError('Invalid workspace selector');
            headers['X-Workspace-Id'] = selection;
          }
          if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
            headers['Idempotency-Key'] = idempotencyKey!;
          }
          response = await Promise.race([
            this.transport(`${this.baseUrl}${path}`, {
              method, headers, signal: controller.signal,
              // Never forward credentials, workspace selections, or POST keys
              // through HTTP redirects. The API contract has no redirects.
              redirect: 'error',
              ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
            }),
            cancelled,
          ]);
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          if (error instanceof ScopehatchAuthenticationError || error instanceof ScopehatchConfigurationError) throw error;
          if (attempt < retries) { await this.backoff(attempt, undefined, cancelled); continue; }
          throw new ScopehatchNetworkError();
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
          await this.backoff(attempt, retryAfterMs(response.headers.get('retry-after'), this.maxRetryDelayMs), cancelled);
          continue;
        }
        let json: unknown;
        try {
          const raw = await Promise.race([response.text(), cancelled]);
          if (raw.length > this.maxResponseChars) throw new ScopehatchProtocolError();
          json = JSON.parse(raw) as unknown;
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          if (error instanceof ScopehatchProtocolError) throw error;
          throw new ScopehatchProtocolError();
        }
        if (!response.ok) {
          const error = asRecord(json) && asRecord(json.error) ? json.error : undefined;
          throw new ScopehatchHttpError(
            response.status,
            typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
            typeof error?.requestId === 'string' ? error.requestId : undefined,
            retryAfterMs(response.headers.get('retry-after'), this.maxRetryDelayMs),
          );
        }
        return json as T;
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    }
  }

  private async backoff(attempt: number, retryAfter: number | undefined, cancelled: Promise<never>) {
    const exponential = Math.min(this.retryDelayMs * (2 ** attempt), this.maxRetryDelayMs);
    const delay = retryAfter ?? exponential;
    if (delay > 0) await Promise.race([new Promise<void>(resolve => setTimeout(resolve, delay)), cancelled]);
  }

  async listCatalogs(options?: RequestOptions): Promise<Catalog[]> {
    return envelope<Catalog[]>(await this.request<unknown>('GET', '/v1/catalogs', options), 'items');
  }
  /** Only an authenticated owner may publish a full immutable catalog version. */
  async createCatalog(input: CreateCatalogRequest, options: WriteOptions): Promise<Catalog> {
    const validated = validateCatalogInput(input);
    return catalogResponse(await this.request<unknown>('POST', '/v1/catalogs', options, validated, options));
  }
  /** The server binds cursor, status and results to the verified workspace membership. */
  async listProjects(options: ListProjectsOptions = {}): Promise<ProjectPage> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(wholeNumber(options.limit, 'limit', 1, 100)));
    if (options.cursor !== undefined) query.set('cursor', optionalCursor(options.cursor, 'cursor'));
    const suffix = query.size ? '?' + query.toString() : '';
    return projectPage(await this.request<unknown>('GET', '/v1/projects' + suffix, options));
  }
  async createProject(input: CreateProjectRequest, options: WriteOptions): Promise<ProjectDetails['project']> {
    const value = await this.request<unknown>('POST', '/v1/projects', options, {
      title: input.title, brief: input.brief,
    }, options);
    return envelope(value, 'project');
  }
  async getProject(projectId: string, options?: RequestOptions): Promise<ProjectDetails> {
    const result = await this.request<unknown>('GET', `/v1/projects/${segment(projectId)}`, options);
    envelope(result, 'project');
    return result as ProjectDetails;
  }
  async createScope(projectId: string, input: CreateScopeRequest, options: WriteOptions): Promise<Scope> {
    const deliverables = input.deliverables.map(d => ({
      serviceId: d.serviceId, quantity: d.quantity, evidence: d.evidence, source: d.source,
      ...(d.clientDescription === undefined ? {} : { clientDescription: clientDescription(d.clientDescription) }),
    }));
    const proposal = input.proposal === undefined ? undefined : serializeProposal(input.proposal);
    if (proposal !== undefined || deliverables.some(d => Object.hasOwn(d, 'clientDescription'))) {
      validateMetadataSize({
        ...(proposal === undefined ? {} : { proposal }),
        clientDescriptions: deliverables.map(d => d.clientDescription ?? ''),
      });
    }
    const value = await this.request<unknown>('POST', `/v1/projects/${segment(projectId)}/scopes`, options, {
      deliverables, unknowns: input.unknowns,
      ...(proposal === undefined ? {} : { proposal }),
    }, options);
    return envelope(value, 'scope');
  }
  async createEstimate(projectId: string, input: RevisionBinding, options: WriteOptions): Promise<Estimate> {
    const value = await this.request<unknown>('POST', `/v1/projects/${segment(projectId)}/estimates`, options,
      { scopeRevision: revision(input.scopeRevision), catalogVersion: revision(input.catalogVersion) }, options);
    return envelope(value, 'estimate');
  }
  async submitReview(projectId: string, input: RevisionBinding, options: WriteOptions): Promise<Review> {
    const value = await this.request<unknown>('POST', `/v1/projects/${segment(projectId)}/reviews`, options,
      { scopeRevision: revision(input.scopeRevision), catalogVersion: revision(input.catalogVersion) }, options);
    return envelope(value, 'review');
  }
  /** Requires a different authorized reviewer server-side; the SDK never invents a reviewer role. */
  async approveReview(projectId: string, input: RevisionBinding, options: WriteOptions): Promise<Review> {
    const value = await this.request<unknown>('POST', `/v1/projects/${segment(projectId)}/approve`, options,
      { scopeRevision: revision(input.scopeRevision), catalogVersion: revision(input.catalogVersion) }, options);
    return envelope(value, 'review');
  }
  async exportApprovedProposal(projectId: string, exactRevision: number, options?: RequestOptions): Promise<ExportedProposal> {
    return this.request<ExportedProposal>('GET',
      `/v1/projects/${segment(projectId)}/exports/${revision(exactRevision)}`, options);
  }
  async listAudit(projectId: string, options: AuditOptions = {}): Promise<AuditPage> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(wholeNumber(options.limit, 'limit', 1)));
    const suffix = query.size ? `?${query.toString()}` : '';
    const value = await this.request<unknown>('GET', `/v1/projects/${segment(projectId)}/audit${suffix}`, options);
    if (!asRecord(value) || !Array.isArray(value.items) ||
      !(typeof value.nextCursor === 'string' || value.nextCursor === null)) throw new ScopehatchProtocolError();
    return value as unknown as AuditPage;
  }
  async suggestScope(projectId: string, input: SuggestionRequest, options: WriteOptions): Promise<SuggestionResult> {
    const value = await this.request<unknown>('POST', `/v1/projects/${segment(projectId)}/suggestions`, options,
      input.scopeRevision === undefined ? {} : { scopeRevision: revision(input.scopeRevision) }, options);
    if (!asRecord(value) || !Object.hasOwn(value, 'suggestion') || !Object.hasOwn(value, 'provenance') ||
      !Object.hasOwn(value, 'model') || !Object.hasOwn(value, 'usage')) throw new ScopehatchProtocolError();
    return value as unknown as SuggestionResult;
  }
}
