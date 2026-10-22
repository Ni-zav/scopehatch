import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Migration administrator DATABASE_URL required');
const role = process.env.POSTGRES_RUNTIME_USER || 'scopehatch_runtime';
if (!/^[a-z][a-z0-9_]{2,62}$/.test(role) || role === 'postgres' || role === 'scopehatch_app')
  throw new Error('Invalid restricted runtime role identifier');
const admin = process.env.POSTGRES_USER;
if (role === admin) throw new Error('Runtime database login cannot be migration administrator');
const secretPath = process.env.SCOPEHATCH_RUNTIME_DB_PASSWORD_FILE;
if (!secretPath) throw new Error('Missing runtime credential file path');
const password = readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '');
if (!password || password.length < 24) throw new Error('Runtime database password must be at least 24 characters');

const pool = new Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
try {
  const privileges = await client.query(
    'SELECT rolsuper,rolcreaterole FROM pg_roles WHERE rolname=current_user'
  );
  if (!privileges.rows[0]?.rolsuper && !privileges.rows[0]?.rolcreaterole)
    throw new Error('Migration credentials lack role provisioning permission');
  for (const name of [
    '001_initial.sql', '002_quote_integrity.sql',
    '003_immutable_children_usage.sql', '004_identity_lookup.sql',
    '005_inference_governance.sql', '006_sprint02_catalog_proposals_projects.sql'
  ]) {
    const sql = await readFile(fileURLToPath(new URL('../../db/migrations/' + name, import.meta.url)), 'utf8');
    await client.query(sql);
  }
  const escaped = '"' + role.replaceAll('"', '""') + '"';
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
  if (!exists.rowCount) await client.query('CREATE ROLE ' + escaped + ' LOGIN INHERIT NOSUPERUSER NOBYPASSRLS');
  const quote = "'" + password.replaceAll("'", "''") + "'";
  await client.query('ALTER ROLE ' + escaped +
    ' WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ' + quote);
  await client.query('GRANT scopehatch_app TO ' + escaped);
  const check = await client.query(
    'SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1', [role]);
  if (check.rows[0]?.rolsuper || check.rows[0]?.rolbypassrls || !check.rows[0]?.rolinherit)
    throw new Error('Runtime role is not RLS-constrained');
  process.stdout.write('Migrations and restricted role provisioning completed.\n');
} finally {
  client.release();
  await pool.end();
}
