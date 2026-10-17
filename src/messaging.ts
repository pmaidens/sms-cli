import twilio from 'twilio';
import { randomUUID } from 'node:crypto';
import { phone, required, webhookOrigin } from './config.js';
import type { Store } from './db.js';

export interface RemoteMessage { sid: string; status: string; errorCode: number | null; from: string; to: string; body: string; direction: string }
export interface Gateway {
  create(input: { from: string; to: string; body: string; statusCallback: string }): Promise<RemoteMessage>;
  fetch(sid: string): Promise<RemoteMessage>;
}

export function gateway(): Gateway {
  const client = twilio(required('TWILIO_ACCOUNT_SID'), required('TWILIO_AUTH_TOKEN'), { autoRetry: false, timeout: 10000 });
  return { create: input => client.messages.create(input), fetch: sid => client.messages(sid).fetch() };
}

export async function send(store: Store, remote: Gateway, input: { to: string; body: string; id?: string }) {
  const from = phone(required('TWILIO_PHONE_NUMBER'));
  const to = phone(input.to);
  if (!input.body.trim() || input.body.length > 1600) throw new Error('SMS body must contain 1 to 1600 characters.');
  const id = input.id ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Request ID must use 1 to 100 letters, digits, underscores, or hyphens.');
  const callback = `${webhookOrigin()}/api/twilio/status?id=${encodeURIComponent(id)}`;
  const reserved = await store.reserve(id, from, to, input.body);
  if (!reserved.created) return { message: reserved.message, reused: true };

  let message: RemoteMessage;
  try {
    message = await remote.create({ from, to, body: input.body, statusCallback: callback });
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : null;
    const rejected = status >= 400 && status < 500 && status !== 408;
    await store.submissionError(id, rejected, code);
    throw new Error(`Send ${rejected ? 'was rejected' : 'has an uncertain result'} for request ${id}${code ? `, Twilio code ${code}` : ''}. Inspect it before trying a new request ID.`);
  }
  try {
    await store.status(id, message.sid, message.status, message.errorCode === null ? null : String(message.errorCode));
  } catch {
    throw new Error(`Twilio accepted request ${id} as ${message.sid}, but saving its status failed. Run: npm run sms -- reconcile ${id} --sid ${message.sid}`);
  }
  return { message: (await store.get(id))!, reused: false };
}

export async function reconcile(store: Store, remote: Gateway, id: string, sid?: string) {
  const local = await store.get(id);
  if (!local || local.direction !== 'outbound') throw new Error('Outbound message not found.');
  const remoteSid = sid ?? local.twilio_sid;
  if (!remoteSid || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(remoteSid)) throw new Error('No Twilio SID saved. Inspect the Twilio message log and supply --sid SM... . This command never resends.');
  const message = await remote.fetch(remoteSid);
  if (!message.direction.startsWith('outbound') || message.from !== local.from_number || message.to !== local.to_number || message.body !== local.body) {
    throw new Error('The Twilio message does not match this outgoing request.');
  }
  await store.status(local.id, message.sid, message.status, message.errorCode === null ? null : String(message.errorCode));
  return (await store.get(local.id))!;
}
