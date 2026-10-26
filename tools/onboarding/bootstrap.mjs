/** Host-only tenant bootstrap. Never import this module into an HTTP service. */
export class InputError extends Error { constructor(message) { super(message); this.name = 'InputError'; this.exitCode = 2; } }
export class ConflictError extends Error { constructor() { super('Tenant or owner state conflicts with requested bootstrap'); this.name = 'ConflictError'; this.exitCode = 3; } }
export class DatabaseError extends Error { constructor() { super('Administrative database unavailable, unprivileged or not migrated'); this.name = 'DatabaseError'; this.exitCode = 4; } }

const unsafe = /[\x00-\x1f\x7f]/;
const seedSubjects = new Set(['a-operator', 'b-operator', 'a-reviewer', 'b-reviewer']);
const placeholders = /(?:example\.(?:invalid|test|com|org|net)|\.invalid(?:\/|$)|\.test(?:\/|$)|localhost|127\.0\.0\.1|oidc-subject-from-trusted-issuer|exact-verified-oidc-sub|your[-_ ]?(?:sub|subject|issuer)|placeholder)/i;
export function validateIssuer(value) {
  if (typeof value !== 'string' || value.length > 2048 || unsafe.test(value) || placeholders.test(value)) throw new InputError('Trusted non-placeholder OIDC issuer required');
  let parsed;
  try { parsed = new URL(value); } catch { throw new InputError('OIDC issuer must be an absolute HTTPS URL'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) throw new InputError('OIDC issuer must be a clean HTTPS URL');
  return value; // issuer comparison must be EXACT; do not silently change trailing slash.
}
export function validateRequest(input) {
  if (typeof input.tenantId !== 'string' || !/^[a-z][a-z0-9-]{2,62}$/.test(input.tenantId) || ['studio-a','studio-b','test','demo','fixture'].includes(input.tenantId)) throw new InputError('Tenant ID must be a non-fixture slug (3–63 characters)');
  if (typeof input.workspaceName !== 'string' || input.workspaceName.trim() !== input.workspaceName || input.workspaceName.length < 2 || input.workspaceName.length > 120 || unsafe.test(input.workspaceName) || !input.workspaceName.trim()) throw new InputError('Workspace name must be 2–120 printable characters');
  if (typeof input.ownerSub !== 'string' || input.ownerSub.length < 1 || input.ownerSub.length > 512 || input.ownerSub.trim() !== input.ownerSub || unsafe.test(input.ownerSub) || seedSubjects.has(input.ownerSub) || placeholders.test(input.ownerSub) || /^(?:test|demo|fixture|admin|owner|user|alice|bob|1234)$/i.test(input.ownerSub)) throw new InputError('Owner sub must be the exact non-fixture verified OIDC subject');
  validateIssuer(input.issuer);
  if (typeof input.expectedIssuer !== 'string' || input.expectedIssuer !== input.issuer) throw new InputError('Issuer confirmation must exactly match configured OIDC_ISSUER');
  if (!['production','staging','development'].includes(input.environment) || input.confirmEnvironment !== input.environment) throw new InputError('Confirm the recognized deployment environment');
  if (typeof input.database !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(input.database)) throw new InputError('Confirm the expected PostgreSQL database name');
  if (input.verified !== true) throw new InputError('Explicit external subject verification acknowledgement required');
  return Object.freeze({...input});
}

/** Caller must supply a dedicated administrative PG client, never the runtime pool. */
export async function provisionTenant(client, input, {dryRun=false}={}) {
  const data = validateRequest(input);
  let begun=false;
  try {
    await client.query(dryRun ? 'BEGIN READ ONLY' : 'BEGIN');
    begun=true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const identity = await client.query("SELECT current_user AS username, current_database() AS database, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, to_regclass('scopehatch.tenants') AS tenants, to_regclass('scopehatch.memberships') AS memberships FROM pg_roles r WHERE r.rolname = current_user");
    const p = identity.rows[0];
    if (!p || p.database !== data.database || (!p.superuser && !p.bypassrls) || !p.tenants || !p.memberships || ['scopehatch_app','scopehatch_runtime'].includes(p.username)) throw new InputError('Admin role, database confirmation or migrations are invalid');
    await client.query('SELECT tenant_id,issuer FROM scopehatch.tenant_identity_issuers LIMIT 0');
    // Serialize same tenant across concurrent admin sessions. Dry-run is observational only.
    if (!dryRun) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('scopehatch/bootstrap/' || $1, 0))", [data.tenantId]);
    const existing = await client.query('SELECT id, name FROM scopehatch.tenants WHERE id=$1', [data.tenantId]);
    let outcome;
    if (!existing.rows.length) {
      outcome = dryRun ? 'would-create' : 'created';
      if (!dryRun) {
        await client.query('INSERT INTO scopehatch.tenants(id,name) VALUES ($1,$2)', [data.tenantId, data.workspaceName]);
        await client.query('INSERT INTO scopehatch.tenant_identity_issuers(tenant_id,issuer) VALUES ($1,$2)', [data.tenantId,data.issuer]);
        await client.query("INSERT INTO scopehatch.memberships(tenant_id,principal_id,roles,active) VALUES ($1,$2,ARRAY['owner']::text[],true)", [data.tenantId,data.ownerSub]);
      }
    } else {
      const binding = await client.query('SELECT issuer FROM scopehatch.tenant_identity_issuers WHERE tenant_id=$1', [data.tenantId]);
      if (binding.rows.length !== 1 || binding.rows[0].issuer !== data.issuer) throw new ConflictError();
      const members = await client.query('SELECT principal_id, roles, active FROM scopehatch.memberships WHERE tenant_id=$1', [data.tenantId]);
      const exact = members.rows.find(m => m.principal_id === data.ownerSub && m.active === true && Array.isArray(m.roles) && m.roles.length === 1 && m.roles[0] === 'owner');
      const otherOwner = members.rows.some(m => m.principal_id !== data.ownerSub && Array.isArray(m.roles) && m.roles.includes('owner'));
      if (existing.rows.length !== 1 || existing.rows[0].name !== data.workspaceName || !exact || otherOwner) throw new ConflictError();
      outcome = dryRun ? 'would-be-unchanged' : 'unchanged';
    }
    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    begun=false;
    return outcome;
  } catch(error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch { /* original error determines safe exit */ } }
    if (error instanceof InputError || error instanceof ConflictError) throw error;
    // PostgreSQL error messages may contain credentials, queries or submitted subjects.
    throw new DatabaseError();
  }
}
