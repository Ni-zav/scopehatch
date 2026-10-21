import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { authenticate, type TokenVerifier } from './auth.ts';
import { ApiError, ApplicationService, normalizeError } from './core.ts';
import type { MembershipPort, PersistencePort, Principal } from './ports.ts';

const text = { type: 'string', minLength: 1, maxLength: 50000 } as const;
const integer = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const revisionBody = { type: 'object', additionalProperties: false, required: ['scopeRevision', 'catalogVersion'], properties: { scopeRevision: integer, catalogVersion: integer } } as const;
const paramsSchema = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: text } } as const;
const scopeBody = {
  type: 'object', additionalProperties: false, required: ['deliverables', 'unknowns'],
  properties: {
    deliverables: { type: 'array', maxItems: 500, items: { type: 'object', additionalProperties: false,
      required: ['serviceId', 'quantity', 'evidence', 'source'], properties: {
        serviceId: text, quantity: { anyOf: [integer, { type: 'null' }] },
        evidence: { type: 'string', maxLength: 50000 }, source: { type: 'string', enum: ['brief', 'manual'] }
      }
    } },
    unknowns: { type: 'array', maxItems: 500, items: text }
  }
} as const;
const idempotency = (req: FastifyRequest) => {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string') throw new ApiError('IDEMPOTENCY_KEY_REQUIRED', 422, 'Idempotency-Key is required');
  return value;
};
const idOf = (req: FastifyRequest): string => (req.params as { id: string }).id;
const actor = (req: FastifyRequest): Principal => {
  const principal = (req as FastifyRequest & { principal?: Principal }).principal;
  if (!principal) throw new ApiError('UNAUTHENTICATED', 401, 'Authentication required');
  return principal;
};
const data = <T>(req: FastifyRequest): T => req.body as T;
const send = async (reply: FastifyReply, work: Promise<{ status: number; body: unknown }>) => {
  const result = await work;
  return reply.code(result.status).send(result.body);
};

export function buildServer(deps: { store: PersistencePort; memberships: MembershipPort; verify: TokenVerifier;
  suggestions?: {suggest(principal:Principal,projectId:string,key:string,requestId:string,scopeRevision?:number):Promise<{status:number;body:unknown}>};
}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1048576, trustProxy: false, ajv: { customOptions: { removeAdditional: false } } });
  const service = new ApplicationService(deps.store);
  app.setErrorHandler((error, request, reply) => {
    const validation = (error as { validation?: unknown }).validation ? new ApiError('INVALID_INPUT', 422, 'Request validation failed') : null;
    const e = validation ?? normalizeError(error);
    void reply.code(e.status).send({ error: { code: e.code, message: e.message, requestId: request.id } });
  });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.addHook('onRequest', async req => {
    if (req.url.split('?')[0] === '/healthz') return;
    const header = req.headers.authorization;
    const matches = typeof header === 'string' ? /^Bearer ([^\s]+)$/.exec(header) : null;
    const rawTenant = req.headers['x-workspace-id'];
    if (rawTenant !== undefined && (typeof rawTenant !== 'string' || rawTenant.length > 200))
      throw new ApiError('INVALID_INPUT', 422, 'Invalid workspace selector');
    (req as FastifyRequest & { principal?: Principal }).principal = await authenticate(matches?.[1], rawTenant, deps.verify, deps.memberships);
  });
  app.get('/v1/catalogs', async req => service.catalogs(actor(req)));
  app.post('/v1/projects', { schema: { body: { type: 'object', additionalProperties: false, required: ['title', 'brief'], properties: { title: { ...text, maxLength: 300 }, brief: text } } } },
    async (req, reply) => send(reply, service.createProject(actor(req), idempotency(req), data(req), req.id)));
  app.get('/v1/projects/:id', { schema: { params: paramsSchema } }, async req => service.project(actor(req), idOf(req)));
  app.post('/v1/projects/:id/scopes', { schema: { params: paramsSchema, body: scopeBody } },
    async (req, reply) => send(reply, service.createScope(actor(req), idOf(req), idempotency(req), data(req), req.id)));
  app.post('/v1/projects/:id/estimates', { schema: { params: paramsSchema, body: revisionBody } },
    async (req, reply) => send(reply, service.createEstimate(actor(req), idOf(req), idempotency(req), data(req), req.id)));
  app.post('/v1/projects/:id/reviews', { schema: { params: paramsSchema, body: revisionBody } },
    async (req, reply) => send(reply, service.submit(actor(req), idOf(req), idempotency(req), data(req), req.id)));
  app.post('/v1/projects/:id/approve', { schema: { params: paramsSchema, body: revisionBody } },
    async (req, reply) => send(reply, service.approve(actor(req), idOf(req), idempotency(req), data(req), req.id)));
  app.get('/v1/projects/:id/exports/:revision', { schema: { params: { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: { id: text, revision: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 15 } } } } },
    async req => service.export(actor(req), idOf(req), Number((req.params as { revision: string }).revision)));
  app.get('/v1/projects/:id/audit', { schema: { params: paramsSchema, querystring: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string' }, limit: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 3 } } } } },
    async req => {
      const query = req.query as { cursor?: string; limit?: string };
      return service.audit(actor(req), idOf(req), query.cursor, query.limit ? Number(query.limit) : 20);
    });
  app.post('/v1/projects/:id/suggestions', { schema: { params: paramsSchema, body: { type: 'object', additionalProperties: false, properties: { scopeRevision: integer } } } },
    async (req, reply) => {
      const principal=actor(req), key=idempotency(req);
      if(!deps.suggestions)return service.suggestions(principal,idOf(req));
      const revision=(req.body as {scopeRevision?:number}|undefined)?.scopeRevision;
      return send(reply,deps.suggestions.suggest(principal,idOf(req),key,req.id,revision));
    });
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Resource not found', requestId: req.id } });
  });
  return app;
}
