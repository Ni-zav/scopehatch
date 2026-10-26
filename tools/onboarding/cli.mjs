#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InputError, DatabaseError, provisionTenant, validateRequest } from './bootstrap.mjs';
import { manageIdentity } from './identity.mjs';

const HELP = `Scopehatch offline administrator (run ONLY on the trusted host)\n\nUsage:\n  node tools/onboarding/cli.mjs tenant create \\\n    --tenant-id studio-example --workspace-name "Example Studio" \\\n    --owner-sub "exact-verified-oidc-sub" --issuer "<configured-oidc-issuer>" \\\n    --environment production --confirm-database scopehatch \\\n    --admin-db-url-file /secure/admin-db-url --confirm-subject-verified [--dry-run]\n\nPrerequisites (mandatory): OIDC_ISSUER and SCOPEHATCH_DEPLOYMENT_ENV in host\nenvironment, matching --issuer and --environment exactly. --confirm-subject-verified\nmeans a trusted operator has checked the owner sub against the configured IdP\nand a signed issuer/audience-verified access token (see docs/first-run).\n\nReturn codes: 0 created/unchanged/dry-run; 2 invalid input or configuration;\n3 conflicting tenant/ownership; 4 database/connectivity/schema/privilege failure.\nNever pass connection strings, passwords or tokens as command-line arguments.\n`;
const flags = new Map([['--tenant-id','tenantId'],['--workspace-name','workspaceName'],['--owner-sub','ownerSub'],['--member-sub','memberSub'],['--role','role'],['--issuer','issuer'],['--environment','environment'],['--confirm-database','database'],['--admin-db-url-file','secretFile']]);
export function parseArgs(argv) {
  if ((argv.length === 1 && ['--help','-h'].includes(argv[0])) ||
      (argv.length === 3 && ['tenant create','tenant bind-issuer','member add','member disable'].includes(argv.slice(0,2).join(' ')) && ['--help','-h'].includes(argv[2]))) return {help:true};
  const command=argv.slice(0,2).join(' ');
  if (!['tenant create','tenant bind-issuer','member add','member disable'].includes(command)) throw new InputError('Expected tenant create, tenant bind-issuer, member add or member disable (use --help)');
  const data = command==='tenant create'?{}:{command};
  for (let i=2;i<argv.length;i++) {
    const flag=argv[i];
    if (flag === '--dry-run' || flag === '--confirm-subject-verified' || flag === '--confirm-existing-memberships-verified') {
      if (flag in data) throw new InputError('Duplicate option');
      data[flag] = true;
    } else if (flags.has(flag)) {
      const key=flags.get(flag);
      if (key in data || !argv[i+1] || argv[i+1].startsWith('--')) throw new InputError('Option missing or repeated');
      data[key]=argv[++i];
    } else throw new InputError('Unknown CLI option (use --help)');
  }
  if (command==='tenant create' && (data.memberSub!==undefined || data.role!==undefined || data['--confirm-existing-memberships-verified'])) throw new InputError('Member options are not valid for tenant create');
  if (command!=='tenant create' && data.workspaceName!==undefined) throw new InputError('Identity operations do not change the workspace name');
  if (command!=='tenant bind-issuer' && data['--confirm-existing-memberships-verified']) throw new InputError('Existing-membership confirmation is only valid for issuer binding');
  if (command==='tenant bind-issuer' && (data.memberSub!==undefined || data.role!==undefined)) throw new InputError('Issuer binding does not accept member options');
  if (!data.secretFile || typeof data.secretFile !== 'string') throw new InputError('Secure administrative database URL file required');
  return data;
}

export async function readAdminUrl(path) {
  // Root/owner-only regular file. Reject symlinks and group/world permissions.
  let info;
  try { info = await lstat(path); } catch { throw new InputError('Administrative DB credential file missing'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new InputError('Administrative DB credential file must be owner-only and not a symlink');
  let secret;
  try { secret=(await readFile(path,'utf8')).trim(); } catch { throw new InputError('Administrative DB credential file cannot be read'); }
  try {
    const parsed = new URL(secret);
    if (!['postgresql:','postgres:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.pathname || parsed.pathname === '/') throw new Error('invalid');
  } catch { throw new InputError('Administrative DB credential file is invalid'); }
  if (process.env.DATABASE_URL === secret) throw new InputError('Refusing an administrative connection identical to runtime DATABASE_URL');
  return secret;
}

export async function run(argv=process.argv.slice(2),env=process.env,loadDriver=()=>import('pg')) {
  const args=parseArgs(argv);
  if (args.help) { process.stdout.write(HELP+'\nAdditional host-only commands (same issuer, owner, environment, database and credential confirmations):\n  member add --member-sub <verified-sub> --role reviewer|operator\n  member disable --member-sub <exact-sub>\n  tenant bind-issuer --confirm-existing-memberships-verified\nThese commands require --owner-sub but no --workspace-name. Existing issuer bindings cannot be replaced. Disabled members cannot be silently reactivated. See tools/onboarding/README.md.\n'); return 0; }
  const input = validateRequest({
    ...args, expectedIssuer:env.OIDC_ISSUER, confirmEnvironment:env.SCOPEHATCH_DEPLOYMENT_ENV,
    ...(args.command?{workspaceName:'Identity administration'}:{}),
    membersVerified:args['--confirm-existing-memberships-verified']===true,
    verified:args['--confirm-subject-verified']===true,
  });
  // Never import database credentials into web/API process or print driver errors.
  const url=await readAdminUrl(args.secretFile);
  let client;
  try {
    const {Client}=await loadDriver();
    client=new Client({connectionString:url,connectionTimeoutMillis:5000,application_name:'scopehatch-offline-onboarding'});
    await client.connect();
    const outcome=await (args.command?manageIdentity:provisionTenant)(client,input,{dryRun:args['--dry-run']===true});
    process.stdout.write(`tenant=${input.tenantId} outcome=${outcome}\n`);
    return 0;
  } catch(error) {
    if (error instanceof InputError || error?.exitCode) throw error;
    throw new DatabaseError();
  } finally {
    if(client) { try { await client.end(); } catch { /* no credential or DB error output */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run().then(code => {process.exitCode=code;},error => {
    process.stderr.write(`Bootstrap refused: ${error instanceof InputError || error?.exitCode ? error.message : 'Administrative operation failed'}\n`);
    process.exitCode = error?.exitCode ?? 4;
  });
}
