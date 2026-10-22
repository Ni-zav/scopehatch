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

describe('Sprint 02 API transport', () => {
  it('lists with tenant membership selector and opaque cursor, without client tenant filters', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({items:[],nextCursor:null}),{status:200})) as unknown as typeof fetch
    const api = createHttpApi({baseUrl:'/api',getAccessToken:async()=> 'signed-token',
      getWorkspaceId:()=> 'verified-workspace',fetchImpl})
    await api.listProjects({limit:10,cursor:'opaque/cursor=='})
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('/api/v1/projects?limit=10&cursor=opaque%2Fcursor%3D%3D')
    expect((init?.headers as Record<string,string>)['X-Workspace-Id']).toBe('verified-workspace')
    expect(String(url)).not.toContain('tenantId=')
  })
  it('publishes a complete immutable catalog with unique idempotency key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({catalog:{
      tenantId:'studio',currency:'IDR',version:2,services:[{id:'render',label:'Render',unitPriceMinor:5}]
    }}),{status:201})) as unknown as typeof fetch
    const api=createHttpApi({baseUrl:'',getAccessToken:async()=> 'signed-token',fetchImpl})
    const result=await api.createCatalog({baseVersion:1,currency:'IDR',services:[{id:'render',label:'Render',unitPriceMinor:5}]})
    expect(result.version).toBe(2)
    const [url,init]=vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('/v1/catalogs')
    expect(JSON.parse(String(init?.body))).toEqual({baseVersion:1,currency:'IDR',services:[{id:'render',label:'Render',unitPriceMinor:5}]})
    expect((init?.headers as Record<string,string>)['Idempotency-Key']).toMatch(/^[a-f0-9-]{36}$/i)
  })
  it('forwards text-only proposal changes without stripping descriptions', async () => {
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({scope:{revision:3}}),{status:201})) as unknown as typeof fetch
    const api=createHttpApi({baseUrl:'',getAccessToken:async()=> 'signed-token',fetchImpl})
    const proposal={overview:'Typed human summary',assumptions:['Model supplied'],exclusions:['Animation'],commercialTerms:['Net 30']}
    await api.createScope('p1',{deliverables:[{serviceId:'view',quantity:1,evidence:'manual',source:'manual',clientDescription:'Two daytime views'}],unknowns:[],proposal})
    expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0]?.[1]?.body))).toMatchObject({proposal,deliverables:[{clientDescription:'Two daytime views'}]})
  })
  it('returns server 401 and 403 errors to caller (no fixture auth fallback)', async () => {
    const fetchImpl=vi.fn(async()=>new Response(JSON.stringify({error:{code:'FORBIDDEN',message:'Owner required',requestId:'r1'}}),{status:403})) as unknown as typeof fetch
    const api=createHttpApi({baseUrl:'',getAccessToken:async()=> 'signed-token',fetchImpl})
    await expect(api.createCatalog({baseVersion:0,currency:'IDR',services:[]})).rejects.toMatchObject({status:403,code:'FORBIDDEN',requestId:'r1'})
  })
})
