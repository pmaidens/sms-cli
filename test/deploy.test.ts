import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runtime = {
  TURSO_DATABASE_URL: 'libsql://inbox.example.com',
  TURSO_AUTH_TOKEN: 'fake-database-token',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'fake-twilio-token',
  TWILIO_PHONE_NUMBER: '+442079460123',
  WEBHOOK_BASE_URL: 'https://another-inbox.example.com',
};
interface Call { args: string[]; input: string }

// Run the real entry point against a fake Vercel CLI. Never contact Vercel or Twilio.
function deploy(settings: Record<string, string> = {}, options: { linked?: boolean; failLink?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'sms-deploy-test-'));
  try {
    const log = join(directory, 'calls.jsonl');
    const config = { ...runtime, ...settings };
    writeFileSync(join(directory, '.env'), Object.entries(config).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
    writeFileSync(join(directory, 'vercel'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[0] === 'env' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.SMS_TEST_CALL_LOG, JSON.stringify({ args, input }) + '\\n');
if (args[0] === 'link' && process.env.SMS_TEST_FAIL_LINK === '1') process.exit(1);
`, { mode: 0o700 });
    if (options.linked) {
      mkdirSync(join(directory, '.vercel'));
      writeFileSync(join(directory, '.vercel/project.json'), JSON.stringify({ projectId: 'existing-project', orgId: 'existing-account' }));
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(TWILIO_|TURSO_|WEBHOOK_|VERCEL_|DOTENV_)/.test(key)) delete env[key];
    }
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve(import.meta.dirname, '../scripts/deploy.ts')], {
      cwd: directory,
      env: {
        ...env, PATH: `${directory}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`,
        SMS_TEST_CALL_LOG: log, SMS_TEST_FAIL_LINK: options.failLink ? '1' : '0',
      },
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    let calls: Call[] = [];
    try { calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Call); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { status: result.status, stderr: result.stderr, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('deploy loads an installation from .env, links its target first, and sends only runtime settings on stdin', { skip: process.platform === 'win32' }, () => {
  const result = deploy({ VERCEL_PROJECT_NAME: 'another-inbox', VERCEL_SCOPE: 'another-team' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0]?.args, ['link', '--project', 'another-inbox', '--scope', 'another-team', '--yes']);
  const uploads = result.calls.filter(call => call.args[0] === 'env');
  assert.equal(uploads.length, Object.keys(runtime).length);
  for (const [key, value] of Object.entries(runtime)) {
    const upload = uploads.find(call => call.args[2] === key);
    assert.ok(upload, `Missing upload for ${key}`);
    assert.equal(upload.input, value);
    assert.deepEqual(upload.args, ['env', 'add', key, 'production', '--sensitive', '--force', '--yes', '--scope', 'another-team']);
  }
  assert.deepEqual(result.calls.at(-1)?.args, ['--prod', '--yes', '--scope', 'another-team']);
});

test('deploy reuses an existing project link when deployment settings are omitted', { skip: process.platform === 'win32' }, () => {
  const result = deploy({}, { linked: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.some(call => call.args[0] === 'link'), false);
  assert.deepEqual(result.calls.at(-1)?.args, ['--prod', '--yes']);
});

test('deploy links a project in the default account when scope is omitted', { skip: process.platform === 'win32' }, () => {
  const result = deploy({ VERCEL_PROJECT_NAME: 'another-inbox' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0]?.args, ['link', '--project', 'another-inbox', '--yes']);
});

test('invalid configuration stops before linking or uploading credentials', { skip: process.platform === 'win32' }, () => {
  for (const [settings, error] of [
    [{}, /Set VERCEL_PROJECT_NAME/],
    [{ VERCEL_SCOPE: 'another-team' }, /Set VERCEL_PROJECT_NAME/],
    [{ TWILIO_PHONE_NUMBER: '' }, /Missing TWILIO_PHONE_NUMBER/],
    [{ TWILIO_PHONE_NUMBER: '2025550123' }, /E.164/],
    [{ TURSO_DATABASE_URL: 'file:local.db' }, /remote Turso database/],
    [{ WEBHOOK_BASE_URL: 'http://insecure.example.com' }, /HTTPS origin/],
  ] as [Record<string, string>, RegExp][]) {
    const result = deploy(settings);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.deepEqual(result.calls, []);
  }
});

test('a failed project link prevents credential uploads and deployment', { skip: process.platform === 'win32' }, () => {
  const result = deploy({ VERCEL_PROJECT_NAME: 'another-inbox' }, { failLink: true, linked: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not link the configured Vercel project/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0]?.args[0], 'link');
});
