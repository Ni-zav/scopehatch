import { describe, expect, it, vi } from 'vitest'
import { ApiError, createHttpApi } from './api'

describe('HTTP v1 transport', () => {
  it('attaches only bearer identity and idempotency to POST writes', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ project: { id: 'p-1', title: 'Example', brief: 'Source', status: 'draft' } }), {
        status: 201, headers: { 'Content-Type': 'application/json' }
      })
    }) as unknown as typeof fetch
    const api = createHttpApi({ baseUrl: 'https://example.invalid/', getAccessToken: async () => 'signed-test-token', fetchImpl })
    await api.createProject({ title: 'Example', brief: 'Source' })
    expect(calls[0]?.url).toBe('https://example.invalid/v1/projects')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer signed-test-token')
    expect(headers['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/i)
    expect(headers).not.toHaveProperty('X-Tenant-Id')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ title: 'Example', brief: 'Source' })
  })
  it('never sends a protected request without an auth token', async () => {
    const fetchImpl = vi.fn()
    const api = createHttpApi({ baseUrl: '', getAccessToken: async () => null, fetchImpl })
    await expect(api.catalogs()).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('preserves requestId and backend error status without leaking response text', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'STALE_REVISION', message: 'Scope changed', requestId: 'req-123' }
    }), { status: 409 })) as unknown as typeof fetch
    const api = createHttpApi({ baseUrl: '', getAccessToken: async () => 'test', fetchImpl })
    const cause = await api.approve('p-1', { scopeRevision: 1, catalogVersion: 1 }).catch(e => e)
    expect(cause).toBeInstanceOf(ApiError)
    expect(cause).toMatchObject({ status: 409, code: 'STALE_REVISION', requestId: 'req-123' })
  })
  it('uses encoded path segments and cursor parameters', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })) as unknown as typeof fetch
    const api = createHttpApi({ baseUrl: '/api', getAccessToken: async () => 'test', fetchImpl })
    await api.audit('project/one', 'a+b/=', 12)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('/api/v1/projects/project%2Fone/audit?limit=12&cursor=a%2Bb%2F%3D')
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined()
  })
})
