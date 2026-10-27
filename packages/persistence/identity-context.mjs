import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { createHmac } from 'node:crypto';

export function readContextKey() {
  const path = process.env.SCOPEHATCH_CONTEXT_KEY_FILE;
  if (!path) throw new Error('SCOPEHATCH_CONTEXT_KEY_FILE is required');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) ||
        ![0, process.getuid()].includes(stat.uid)) throw new Error();
    const value = readFileSync(fd, 'utf8').replace(/\r?\n$/, '');
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error();
    return Buffer.from(value, 'hex');
  } catch {
    throw new Error('Context key must be a protected regular file containing 32 random bytes as lowercase hex');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Called only with a principal from trusted authentication, inside BEGIN. */
export function createContextBinder(kind = 'transaction') {
  if (!['transaction','membership'].includes(kind)) throw new Error('Unknown attestation purpose');
  const key = readContextKey();
  return async (client, principal) => {
    const claims = kind === 'transaction'
      ? { kind, tenant: principal?.tenantId, actor: principal?.id }
      : { kind, subject: principal?.subject, issuer: principal?.issuer };
    if (Object.values(claims).some(x => typeof x !== 'string' || !x)) throw new Error('Verified identity required');
    const { rows: [binding] } = await client.query(`SELECT
      pg_current_xact_id()::text AS tx, pg_backend_pid()::text AS pid,
      current_database() AS db, session_user::text AS login,
      extract(epoch FROM pg_postmaster_start_time())::text AS start`);
    const payload = JSON.stringify({ v: 1, ...claims, ...binding });
    const mac = createHmac('sha256', key).update('scopehatch/context/v1:' + payload).digest('hex');
    await client.query("SELECT set_config('scopehatch.identity', $1, true), set_config('scopehatch.identity_mac', $2, true)", [payload, mac]);
    const { rows: [checked] } = await client.query(
      'SELECT scopehatch.verified_context() IS NOT NULL AS valid');
    if (checked?.valid !== true) throw Object.assign(new Error('Transaction identity was not verified'), { code: '42501' });
  };
}
