import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { MembershipPort, Principal, Role } from './ports.ts';
import { ApiError, validRoles } from './core.ts';

export type VerifiedIdentity = Readonly<{ subject: string; issuer: string }>;
export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;
export type JwtConfig = Readonly<{
  issuer: string; audience: string; jwksUrl?: string; localJwks?: JSONWebKeySet;
}>;
/** Validate a signed OIDC access JWT. Local JWKS is for test-signed tokens only. */
export function oidcVerifier(config: JwtConfig): TokenVerifier {
  if (!config.issuer || !config.audience || Boolean(config.jwksUrl) === Boolean(config.localJwks))
    throw new Error('JWT issuer, audience, and exactly one JWKS source are required');
  if (config.jwksUrl && new URL(config.jwksUrl).protocol !== 'https:') throw new Error('JWKS must use HTTPS');
  const keys = config.localJwks ? createLocalJWKSet(config.localJwks) : createRemoteJWKSet(new URL(config.jwksUrl!));
  return async (token: string) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer, audience: config.audience, algorithms: ['RS256', 'ES256'],
      clockTolerance: 0, requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat']
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Missing subject');
    return { subject: payload.sub, issuer: config.issuer };
  };
}
/** Workspace header may SELECT a tenant only after membership verification; it grants no authority. */
export async function authenticate(token: string | undefined, selectedTenant: string | undefined,
  verify: TokenVerifier, memberships: MembershipPort): Promise<Principal> {
  if (!token) throw new ApiError('UNAUTHENTICATED', 401, 'Bearer token required');
  let identity: VerifiedIdentity;
  try { identity = await verify(token); }
  catch { throw new ApiError('UNAUTHENTICATED', 401, 'Invalid access token'); }
  const rows = (await memberships.findByVerifiedSubject(identity.subject, identity.issuer)).filter(m => m.active && m.subject === identity.subject);
  const valid = rows.filter(m => m.actorId && m.tenantId && m.roles.length &&
    m.roles.every(r => (validRoles as readonly string[]).includes(r)));
  const candidates = selectedTenant ? valid.filter(m => m.tenantId === selectedTenant) : valid;
  if (!candidates.length) throw new ApiError('FORBIDDEN', 403, 'No active membership');
  if (candidates.length !== 1) throw new ApiError('WORKSPACE_SELECTION_REQUIRED', 422, 'Select an authorized workspace');
  const row = candidates[0]!;
  return { id: row.actorId, tenantId: row.tenantId, roles: [...row.roles] as Role[] };
}
