import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { phone, required, webhookOrigin } from '../src/config.js';

required('TWILIO_ACCOUNT_SID');
required('TWILIO_AUTH_TOKEN');
const own = phone(required('TWILIO_PHONE_NUMBER'));

function twilio(args: string[]) {
  const result = spawnSync('npx', ['--yes', '--package=twilio-cli', 'twilio', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TWILIO_LOG_LEVEL: 'error' },
  });
  if (result.error || result.status !== 0) throw new Error('Twilio CLI failed. Check credentials, network access, and account permissions.');
  return result.stdout;
}

interface NumberConfig { sid: string; phoneNumber: string; smsUrl: string; smsMethod: string; smsApplicationSid: string | null; capabilities?: { sms?: boolean; SMS?: boolean } }
const numbers = JSON.parse(twilio(['api:core:incoming-phone-numbers:list', '--phone-number', own, '-o', 'json'])) as NumberConfig[];
if (numbers.length !== 1 || numbers[0]?.phoneNumber !== own) throw new Error('The configured account does not contain this phone number.');
const number = numbers[0];
if (!/^PN[0-9a-fA-F]{32}$/.test(number.sid)) throw new Error('Twilio returned an invalid phone number SID.');
console.log(JSON.stringify({ sid: number.sid, phoneNumber: number.phoneNumber, smsUrl: number.smsUrl, smsMethod: number.smsMethod, smsApplicationSid: number.smsApplicationSid }, null, 2));

if (process.argv.includes('--connect')) {
  if (number.smsApplicationSid) throw new Error('A TwiML application manages this number. Inspect its configuration before replacing inbound routing.');
  const target = `${webhookOrigin()}/api/twilio/inbound`;
  // Only connect after the deployed endpoint is reachable and validates signatures.
  const probe = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  if (probe.status !== 403) throw new Error(`Webhook readiness check returned ${probe.status}; expected 403 for an unsigned request. Deploy configured credentials and check Vercel access protection first.`);
  if (number.smsUrl === target && number.smsMethod === 'POST') {
    console.log(`Already connected ${own} to ${target}.`);
    process.exit(0);
  }
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  const backup = `.local/twilio-number-${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify({ sid: number.sid, phoneNumber: number.phoneNumber, smsUrl: number.smsUrl, smsMethod: number.smsMethod, smsApplicationSid: number.smsApplicationSid }, null, 2), { mode: 0o600, flag: 'wx' });
  twilio(['api:core:incoming-phone-numbers:update', '--sid', number.sid, '--sms-url', target, '--sms-method', 'POST', '-o', 'json']);
  const updatedNumbers = JSON.parse(twilio(['api:core:incoming-phone-numbers:list', '--phone-number', own, '-o', 'json'])) as NumberConfig[];
  const updated = updatedNumbers[0];
  if (updatedNumbers.length !== 1 || updated?.phoneNumber !== own || updated.smsUrl !== target || updated.smsMethod !== 'POST') throw new Error('Twilio did not confirm the expected SMS routing. Inspect the number before retrying.');
  console.log(`Connected ${own} to ${target}. Previous SMS settings saved in ${backup}.`);
}
