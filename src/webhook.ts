import twilio from 'twilio';
import { phone, required, webhookOrigin } from './config.js';
import { openStore, ranks, type Store } from './db.js';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function makeWebhook(kind: 'inbound' | 'status', getStore: () => Store = openStore) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store' };
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { ...headers, Allow: 'POST' } });
    let store: Store | undefined;
    try {
      const path = `/api/twilio/${kind}`;
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname !== path || (kind === 'inbound' && requestUrl.search)) throw new HttpError(400, 'Unexpected webhook URL');
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Expected form data');
      const text = await request.text();
      if (Buffer.byteLength(text) > 65536) throw new HttpError(413, 'Request too large');
      const form = new URLSearchParams(text);
      const params: Record<string, string> = {};
      for (const [key, value] of form) {
        if (Object.hasOwn(params, key)) throw new HttpError(400, 'Duplicate form key');
        Object.defineProperty(params, key, { value, enumerable: true });
      }
      // Use the configured public origin, never a forwarded Host header.
      const signedUrl = `${webhookOrigin()}${path}${requestUrl.search}`;
      if (!twilio.validateRequest(required('TWILIO_AUTH_TOKEN'), request.headers.get('x-twilio-signature') ?? '', signedUrl, params)) throw new HttpError(403, 'Invalid signature');
      if (params.AccountSid !== required('TWILIO_ACCOUNT_SID')) throw new HttpError(403, 'Unexpected Twilio account');
      if (!params.MessageSid || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(params.MessageSid)) throw new HttpError(400, 'Missing or invalid MessageSid');
      const ownNumber = phone(required('TWILIO_PHONE_NUMBER'));

      if (kind === 'inbound') {
        if (params.To !== ownNumber) throw new HttpError(403, 'Unexpected destination');
        if (!params.From || params.Body === undefined) throw new HttpError(400, 'Missing message fields');
        const count = Number(params.NumMedia ?? '0');
        if (!Number.isInteger(count) || count < 0 || count > 10) throw new HttpError(400, 'Invalid media count');
        const media = Array.from({ length: count }, (_, i) => {
          const url = params[`MediaUrl${i}`];
          const contentType = params[`MediaContentType${i}`];
          if (!url || !contentType) throw new HttpError(400, 'Missing media fields');
          return { url, contentType };
        });
        store = getStore();
        await store.receive({ sid: params.MessageSid, from: params.From, to: params.To, body: params.Body, media });
        return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', { headers: { ...headers, 'Content-Type': 'text/xml; charset=utf-8' } });
      }

      const id = requestUrl.searchParams.get('id');
      const status = params.MessageStatus;
      if (!id || !status || !Object.hasOwn(ranks, status)) throw new HttpError(400, 'Missing request ID or invalid SMS status');
      store = getStore();
      const local = await store.get(id);
      if (!local || local.direction !== 'outbound') throw new HttpError(404, 'Unknown outgoing request');
      if (local.from_number !== ownNumber || (params.From && params.From !== local.from_number) || (params.To && params.To !== local.to_number) || (local.twilio_sid && local.twilio_sid !== params.MessageSid)) throw new HttpError(403, 'Message mismatch');
      await store.status(id, params.MessageSid, status, params.ErrorCode || null);
      return new Response(null, { status: 200, headers });
    } catch (error) {
      if (error instanceof HttpError) return new Response(error.message, { status: error.status, headers });
      // Do not log SMS bodies, phone numbers, or credentials.
      console.error(`Twilio ${kind} webhook failed`, error instanceof Error ? error.name : 'Error');
      return new Response('Webhook processing failed', { status: 503, headers });
    } finally { store?.close(); }
  };
}
