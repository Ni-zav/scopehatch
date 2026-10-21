import type { AuditPage, Catalog, Deliverable, Estimate, Project, ProposalExport, Review, Scope, ScopehatchApi, Snapshot } from './types'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message)
    this.name = 'ApiError'
  }
}
export type TokenProvider = () => Promise<string | null>
export interface HttpOptions {
  baseUrl: string
  getAccessToken: TokenProvider
  getWorkspaceId?: () => string | null
  fetchImpl?: typeof fetch
}

/** The server alone establishes tenant membership and principal roles from a verified token. */
export function createHttpApi({ baseUrl, getAccessToken, getWorkspaceId, fetchImpl = fetch }: HttpOptions): ScopehatchApi {
  const root = baseUrl.replace(/\/$/, '')
  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = await getAccessToken()
    if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'Connect an OIDC session to continue. No demo identities are valid in API mode.')
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    const workspace = getWorkspaceId?.()?.trim()
    if (workspace) headers['X-Workspace-Id'] = workspace
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json'
      headers['Idempotency-Key'] = crypto.randomUUID()
    }
    let response: Response
    try {
      response = await fetchImpl(root + path, {
        method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined,
        credentials: 'omit', redirect: 'error'
      })
    } catch {
      throw new ApiError(0, 'NETWORK_UNAVAILABLE', 'The API could not be reached. Check your connection and try again.')
    }
    const result: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const envelope = result as { error?: { code?: string; message?: string; requestId?: string } } | null
      throw new ApiError(response.status, envelope?.error?.code ?? 'HTTP_ERROR',
        envelope?.error?.message ?? 'The request failed (' + response.status + ').',
        envelope?.error?.requestId)
    }
    return result as T
  }
  const idPath = (id: string) => '/v1/projects/' + encodeURIComponent(id)
  return {
    async catalogs() { return (await request<{ items: Catalog[] }>('GET', '/v1/catalogs')).items },
    async createProject(body) { return (await request<{ project: Project }>('POST', '/v1/projects', body)).project },
    project(id) { return request<Snapshot>('GET', idPath(id)) },
    async createScope(id, body: { deliverables: Deliverable[]; unknowns: string[] }) {
      return (await request<{ scope: Scope }>('POST', idPath(id) + '/scopes', body)).scope
    },
    async estimate(id, body) { return (await request<{ estimate: Estimate }>('POST', idPath(id) + '/estimates', body)).estimate },
    async submitReview(id, body) { return (await request<{ review: Review }>('POST', idPath(id) + '/reviews', body)).review },
    async approve(id, body) { return (await request<{ review: Review }>('POST', idPath(id) + '/approve', body)).review },
    export(id, revision) { return request<ProposalExport>('GET', idPath(id) + '/exports/' + encodeURIComponent(revision)) },
    audit(id, cursor, limit = 30) {
      const params = new URLSearchParams({ limit: String(limit) })
      if (cursor) params.set('cursor', cursor)
      return request<AuditPage>('GET', idPath(id) + '/audit?' + params)
    }
  }
}
