import { buildServer } from './server.ts';
import { Pool } from 'pg';
import { assertRestrictedPgPool, createPgPorts } from './postgres.ts';
import { oidcVerifier } from './auth.ts';
import { createInferenceGateway } from './inference.ts';
import type { MembershipPort, PersistencePort } from './ports.ts';
import type { Principal } from './ports.ts';

/** No memory fallback is permitted: missing production adapters must fail startup. */
export async function start(deps: {store:PersistencePort;memberships:MembershipPort;
  suggestions?: {suggest(principal:Principal,projectId:string,key:string,requestId:string,scopeRevision?:number):Promise<{status:number;body:unknown}>};
}) {
  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URI;
  if (!issuer || !audience || !jwksUrl) throw new Error('OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required');
  const app = buildServer({ ...deps, verify: oidcVerifier({ issuer, audience, jwksUrl }) });
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? '3000') });
  return app;
}
if (process.argv[1] && /\/index\.(?:js|ts)$/.test(process.argv[1])) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    process.stderr.write('DATABASE_URL required; no in-memory fallback is allowed.\n');
    process.exitCode = 78;
  } else {
    const pool = new Pool({ connectionString, max: 12 });
    try {
      await assertRestrictedPgPool(pool);
      const ports=createPgPorts(pool);
      const server = await start({...ports,suggestions:createInferenceGateway(pool,ports.store)});
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => { void server.close().finally(() => pool.end()); });
      }
    } catch (error) {
      process.stderr.write('Authenticated API startup failed; verify restricted database role and OIDC configuration.\n');
      await pool.end();
      process.exitCode = 78;
    }
  }
}
