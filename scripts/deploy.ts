import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { phone, required, webhookOrigin } from '../src/config.js';

// Keep secrets on stdin, out of process arguments and terminal output.
const names = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'WEBHOOK_BASE_URL'];
for (const name of names) required(name);
phone(required('TWILIO_PHONE_NUMBER'));
webhookOrigin();
if (required('TURSO_DATABASE_URL').startsWith('file:')) throw new Error('Production requires a remote Turso database.');

const project = process.env.VERCEL_PROJECT_NAME?.trim();
const scope = process.env.VERCEL_SCOPE?.trim();
if (scope && !project) throw new Error('Set VERCEL_PROJECT_NAME when setting VERCEL_SCOPE.');
const scopeArgs = scope ? ['--scope', scope] : [];
if (project) {
  const linked = spawnSync('vercel', ['link', '--project', project, ...scopeArgs, '--yes'], { stdio: 'inherit' });
  if (linked.error || linked.status !== 0) throw new Error('Could not link the configured Vercel project. Check vercel login, VERCEL_PROJECT_NAME, and VERCEL_SCOPE.');
} else if (!existsSync('.vercel/project.json')) {
  throw new Error('Set VERCEL_PROJECT_NAME in .env or run vercel link before deploying.');
}

for (const name of names) {
  const result = spawnSync('vercel', ['env', 'add', name, 'production', '--sensitive', '--force', '--yes', ...scopeArgs], {
    input: required(name), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`Could not save ${name} to Vercel. Check vercel login and project link.`);
  console.log(`Saved production ${name}.`);
}

const deployed = spawnSync('vercel', ['--prod', '--yes', ...scopeArgs], { stdio: 'inherit' });
process.exitCode = deployed.status ?? 1;
