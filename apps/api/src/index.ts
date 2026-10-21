import { buildServer } from './server.ts';
import { oidcVerifier } from './auth.ts';
import type { MembershipPort, PersistencePort } from './ports.ts';

/** No memory fallback is permitted: missing production adapters must fail startup. */
export async function start(deps: { store: PersistencePort; memberships: MembershipPort }) {
  const issuer = process.env.OIDC_ISSUER;
  const audience = process.env.OIDC_AUDIENCE;
  const jwksUrl = process.env.OIDC_JWKS_URI;
  if (!issuer || !audience || !jwksUrl) throw new Error('OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required');
  const app = buildServer({ ...deps, verify: oidcVerifier({ issuer, audience, jwksUrl }) });
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? '3000') });
  return app;
}
if (process.argv[1]?.endsWith('/index.js')) {
  process.stderr.write('No production persistence/membership adapters are wired. Import start({store,memberships}) from an integration entrypoint.\n');
  process.exitCode = 1;
}
