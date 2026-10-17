import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import twilio from 'twilio';
import { Store } from '../src/db.js';
import { makeWebhook } from '../src/webhook.js';
import { send, reconcile, type Gateway, type RemoteMessage } from '../src/messaging.js';

const account = `AC${'a'.repeat(32)}`;
const sid = `SM${'b'.repeat(32)}`;
const otherSid = `SM${'c'.repeat(32)}`;
const own = '+12025550123';
const peer = '+15005550006';
let directory: string;
let store: Store;
let url: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sms-test-'));
  url = `file:${join(directory, 'test.db')}`;
  store = new Store(createClient({ url }));
  await store.migrate();
  process.env.TWILIO_ACCOUNT_SID = account;
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_PHONE_NUMBER = own;
  process.env.WEBHOOK_BASE_URL = 'https://sms.example.com';
});

afterEach(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });

function remote(overrides: Partial<RemoteMessage> = {}): RemoteMessage {
  return { sid, status: 'queued', errorCode: null, from: own, to: peer, body: 'Hello', direction: 'outbound-api', ...overrides };
}

function signed(path: string, params: Record<string, string>, options: { badSignature?: boolean } = {}) {
  const signature = twilio.getExpectedTwilioSignature('test-token', `https://sms.example.com${path}`, params);
  return new Request(`https://internal-vercel.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': options.badSignature ? 'bad' : signature },
    body: new URLSearchParams(params),
  });
}

function handler(kind: 'inbound' | 'status') {
  return makeWebhook(kind, () => new Store(createClient({ url })));
}

function inbound() { return { AccountSid: account, MessageSid: sid, From: peer, To: own, Body: 'Hello', NumMedia: '0' }; }

test('signed inbound SMS is persisted once across webhook retries and read state survives', async () => {
  const handle = handler('inbound');
  const first = await handle(signed('/api/twilio/inbound', inbound()));
  assert.equal(first.status, 200);
  assert.match(await first.text(), /<Response\/>/);
  await store.markRead(sid);
  assert.equal((await handle(signed('/api/twilio/inbound', inbound()))).status, 200);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.list({ unread: true })).length, 0);
  assert.equal((await store.get(sid))?.body, 'Hello');
});

test('invalid signature, account, number, malformed body, and method never reach storage', async () => {
  let opened = false;
  const handle = makeWebhook('inbound', () => { opened = true; return store; });
  assert.equal((await handle(signed('/api/twilio/inbound', inbound(), { badSignature: true }))).status, 403);
  assert.equal((await handle(signed('/api/twilio/inbound', { ...inbound(), AccountSid: `AC${'c'.repeat(32)}` }))).status, 403);
  assert.equal((await handle(signed('/api/twilio/inbound', { ...inbound(), To: peer }))).status, 403);
  assert.equal((await handle(new Request('https://sms.example.com/api/twilio/inbound'))).status, 405);
  const { Body: _, ...noBody } = inbound();
  assert.equal((await handle(signed('/api/twilio/inbound', noBody))).status, 400);
  assert.equal(opened, false);
});

test('new Twilio parameters participate in signature validation and MMS links are retained', async () => {
  const mediaSid = `MM${'d'.repeat(32)}`;
  const params = { ...inbound(), MessageSid: mediaSid, Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/example', MediaContentType0: 'image/jpeg', FutureTwilioField: 'value' };
  assert.equal((await handler('inbound')(signed('/api/twilio/inbound', params))).status, 200);
  assert.deepEqual(JSON.parse((await store.get(mediaSid))!.media_json), [{ url: params.MediaUrl0, contentType: 'image/jpeg' }]);
});

test('a storage outage does not acknowledge receipt', async () => {
  const broken = makeWebhook('inbound', () => { throw new Error('Database unavailable'); });
  assert.equal((await broken(signed('/api/twilio/inbound', inbound()))).status, 503);
});

test('outgoing message exists before Twilio call; repeated request ID never sends twice', async () => {
  let calls = 0;
  const gateway: Gateway = {
    async create(input) {
      calls++;
      assert.equal((await store.get('request-1'))?.status, 'submitting');
      assert.equal(input.statusCallback, 'https://sms.example.com/api/twilio/status?id=request-1');
      return remote();
    },
    async fetch() { return remote(); },
  };
  const first = await send(store, gateway, { to: peer, body: 'Hello', id: 'request-1' });
  assert.equal(first.message.twilio_sid, sid);
  assert.equal(first.message.status, 'queued');
  assert.equal((await send(store, gateway, { to: peer, body: 'Hello', id: 'request-1' })).reused, true);
  await assert.rejects(send(store, gateway, { to: peer, body: 'Different text', id: 'request-1' }), /different message/);
  assert.equal(calls, 1);
});

test('a send timeout stays unknown and is not resubmitted under the same request ID', async () => {
  let calls = 0;
  const gateway: Gateway = { async create() { calls++; throw new Error('timeout'); }, async fetch() { return remote(); } };
  await assert.rejects(send(store, gateway, { to: peer, body: 'Hello', id: 'uncertain' }), /uncertain result.*uncertain/);
  assert.equal((await store.get('uncertain'))?.status, 'unknown');
  await send(store, gateway, { to: peer, body: 'Hello', id: 'uncertain' });
  assert.equal(calls, 1);
  assert.equal((await reconcile(store, gateway, 'uncertain', sid)).status, 'queued');
});

test('Twilio rejection is recorded and database failure prevents contacting Twilio', async () => {
  const gateway: Gateway = { async create() { throw Object.assign(new Error('Bad request'), { status: 400, code: 21211 }); }, async fetch() { return remote(); } };
  await assert.rejects(send(store, gateway, { to: peer, body: 'Hello', id: 'rejected' }), /rejected/);
  assert.equal((await store.get('rejected'))?.error_code, '21211');
  let called = false;
  store.close();
  await assert.rejects(send(store, { ...gateway, async create() { called = true; return remote(); } }, { to: peer, body: 'Hello', id: 'no-db' }));
  assert.equal(called, false);
});

test('early delivery callback beats queued API response and older callbacks cannot regress delivery', async () => {
  const callback = handler('status');
  const gateway: Gateway = {
    async create() {
      const params = { AccountSid: account, MessageSid: sid, MessageStatus: 'delivered', From: own, To: peer };
      assert.equal((await callback(signed('/api/twilio/status?id=early', params))).status, 200);
      return remote();
    }, async fetch() { return remote(); },
  };
  assert.equal((await send(store, gateway, { to: peer, body: 'Hello', id: 'early' })).message.status, 'delivered');
  const stale = { AccountSid: account, MessageSid: sid, MessageStatus: 'sent' };
  assert.equal((await callback(signed('/api/twilio/status?id=early', stale))).status, 200);
  assert.equal((await callback(signed('/api/twilio/status?id=early', stale))).status, 200);
  assert.equal((await store.get('early'))?.status, 'delivered');
  assert.equal((await store.events('early')).length, 3);
  assert.equal((await callback(signed('/api/twilio/status?id=early', { ...stale, MessageSid: otherSid }))).status, 403);
  assert.equal((await callback(signed('/api/twilio/status?id=early', { ...stale, From: peer }))).status, 403);
});

test('failed delivery records an error and reconciliation refuses a mismatched message', async () => {
  await store.reserve('failed', own, peer, 'Hello');
  const params = { AccountSid: account, MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30003' };
  assert.equal((await handler('status')(signed('/api/twilio/status?id=failed', params))).status, 200);
  assert.equal((await store.get('failed'))?.error_code, '30003');
  await assert.rejects(reconcile(store, { async create() { return remote(); }, async fetch() { return remote({ to: own }); } }, 'failed'), /does not match/);
});

test('pagination and conversation filters retain messages with equal timestamps', async () => {
  for (const id of ['a', 'b', 'c']) await store.reserve(id, own, peer, id);
  await store.client.execute("UPDATE messages SET created_at = '2026-01-01T00:00:00.000Z'");
  assert.deepEqual((await store.list({ peer, limit: 2 })).map(row => row.id), ['c', 'b']);
  assert.deepEqual((await store.list({ peer, before: 'b' })).map(row => row.id), ['a']);
  assert.equal((await store.list({ peer: '+15005550007' })).length, 0);
});
