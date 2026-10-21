import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Configuration/secret bridge, NOT authentication or tenant-level provider policy.
const role = process.argv[2] ?? 'api';
const commands = {
  api: ['npm', 'run', 'start', '--workspace', '@scopehatch/api'],
  'api-dev': ['npm', 'run', 'dev', '--workspace', '@scopehatch/api'],
  worker: ['npm', 'run', 'start:worker', '--workspace', '@scopehatch/api'],
  'worker-dev': ['npm', 'run', 'dev:worker', '--workspace', '@scopehatch/api'],
  migrate: ['npm', 'run', 'db:migrate', '--workspace', '@scopehatch/persistence'],
};
if (!(role in commands)) {
  console.error('Unknown service role');
  process.exit(64);
}
const requireEnv = (key) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
};
const readSecret = (path) => {
  const value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  if (!value.trim()) throw new Error('An injected secret file is empty');
  return value;
};
let env;
try {
  const dbUser = requireEnv('POSTGRES_USER');
  const dbName = requireEnv('POSTGRES_DB');
  const dbHost = requireEnv('POSTGRES_HOST');
  const dbPort = requireEnv('POSTGRES_PORT');
  const secretFile = role === 'migrate'
    ? '/run/secrets/postgres_password'
    : '/run/secrets/postgres_runtime_password';
  const dbPass = readSecret(process.env.POSTGRES_PASSWORD_FILE ?? secretFile);
  if (role !== 'migrate' && dbUser === (process.env.POSTGRES_ADMIN_USER ?? 'scopehatch_admin'))
    throw new Error('Runtime database login may not equal bootstrap administrator');
  const provider = process.env.SCOPEHATCH_INFERENCE_PROVIDER ?? 'fixture';
  if (!['fixture', 'ollama', 'openai-compatible'].includes(provider)) {
    throw new Error('Unsupported SCOPEHATCH_INFERENCE_PROVIDER setting');
  }
  if (provider !== 'fixture') {
    requireEnv('SCOPEHATCH_INFERENCE_MODEL');
    requireEnv('SCOPEHATCH_INFERENCE_BASE_URL');
  }
  if (role === 'api' || role === 'api-dev') {
    for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI']) requireEnv(key);
    if (process.env.OIDC_ISSUER?.includes('example.invalid')) {
      throw new Error('Replace the placeholder OIDC_ISSUER with a trusted issuer');
    }
  }
  env = {
    ...process.env,
    DATABASE_URL: `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}@${dbHost}:${dbPort}/${encodeURIComponent(dbName)}`,
    ...(role === 'migrate' ? {
      SCOPEHATCH_RUNTIME_DB_PASSWORD_FILE: '/run/secrets/postgres_runtime_password'
    } : {}),
  };
  if (provider === 'openai-compatible' && role !== 'migrate') {
    env.OPENAI_API_KEY = readSecret(process.env.PROVIDER_API_KEY_FILE ?? '/run/secrets/provider_api_key');
  }
} catch (error) {
  // No secrets, raw payloads or connection string are echoed.
  console.error(`Startup configuration failed: ${error.message}`);
  process.exit(78);
}
const [cmd, ...args] = commands[role];
const child = spawn(cmd, args, { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`Unable to start ${role}: ${error.code ?? 'spawn error'}`);
  process.exitCode = 127;
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 128 + (signal === 'SIGTERM' ? 15 : 2) : 1));
});
