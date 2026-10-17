import { createClient, type Client } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { required } from './config.js';

export const schema = [
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    twilio_sid TEXT UNIQUE,
    direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    media_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    status_rank INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    read_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at, id)`,
  `CREATE INDEX IF NOT EXISTS messages_unread ON messages(direction, read_at, created_at)`,
  `CREATE TABLE IF NOT EXISTS status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id),
    twilio_sid TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL,
    UNIQUE(message_id, twilio_sid, status, error_code)
  )`,
];

export const ranks: Record<string, number> = {
  accepted: 10, scheduled: 15, queued: 20, sending: 30, sent: 40,
  delivered: 100, undelivered: 100, failed: 100, canceled: 100,
};

export interface Message {
  id: string; twilio_sid: string | null; direction: 'inbound' | 'outbound';
  from_number: string; to_number: string; body: string; media_json: string;
  status: string; status_rank: number; error_code: string | null;
  created_at: string; updated_at: string; read_at: string | null;
}

function messages(rows: unknown[]): Message[] { return rows as Message[]; }

export function openStore(): Store {
  const url = required('TURSO_DATABASE_URL');
  if (!url.startsWith('file:') && !process.env.TURSO_AUTH_TOKEN) throw new Error('Missing TURSO_AUTH_TOKEN.');
  return new Store(createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }));
}

export class Store {
  constructor(readonly client: Client) {}
  close() { this.client.close(); }
  async migrate() { await this.client.batch(schema, 'write'); }

  async get(id: string): Promise<Message | undefined> {
    return messages((await this.client.execute({ sql: 'SELECT * FROM messages WHERE id = ? OR twilio_sid = ?', args: [id, id] })).rows)[0];
  }

  async list(options: { unread?: boolean; peer?: string; direction?: string; limit?: number; before?: string } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (options.unread) where.push("direction = 'inbound' AND read_at IS NULL");
    if (options.peer) { where.push('(from_number = ? OR to_number = ?)'); args.push(options.peer, options.peer); }
    if (options.direction) { where.push('direction = ?'); args.push(options.direction); }
    if (options.before) {
      const cursor = await this.get(options.before);
      if (!cursor) throw new Error('Pagination cursor not found.');
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    args.push(options.limit ?? 30);
    return messages((await this.client.execute({
      sql: `SELECT * FROM messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, args,
    })).rows);
  }

  async markRead(id: string) {
    const result = await this.client.execute({ sql: "UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE (id = ? OR twilio_sid = ?) AND direction = 'inbound'", args: [new Date().toISOString(), id, id] });
    if (!result.rowsAffected) throw new Error('Inbound message not found.');
  }

  async receive(input: { sid: string; from: string; to: string; body: string; media: { url: string; contentType: string }[] }) {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `INSERT INTO messages (id, twilio_sid, direction, from_number, to_number, body, media_json, status, status_rank, created_at, updated_at)
        VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'received', 100, ?, ?) ON CONFLICT(twilio_sid) DO NOTHING`,
      args: [randomUUID(), input.sid, input.from, input.to, input.body, JSON.stringify(input.media), now, now],
    });
  }

  async reserve(id: string, from: string, to: string, body: string) {
    const now = new Date().toISOString();
    const result = await this.client.execute({
      sql: `INSERT INTO messages (id, direction, from_number, to_number, body, status, created_at, updated_at)
        VALUES (?, 'outbound', ?, ?, ?, 'submitting', ?, ?) ON CONFLICT(id) DO NOTHING`,
      args: [id, from, to, body, now, now],
    });
    const message = (await this.get(id))!;
    if (message.direction !== 'outbound' || message.from_number !== from || message.to_number !== to || message.body !== body) {
      throw new Error('This request ID belongs to a different message.');
    }
    return { created: result.rowsAffected === 1, message };
  }

  async submissionError(id: string, rejected: boolean, code: string | null) {
    await this.client.execute({
      sql: `UPDATE messages SET status = ?, error_code = ?, updated_at = ? WHERE id = ? AND twilio_sid IS NULL AND status = 'submitting'`,
      args: [rejected ? 'rejected' : 'unknown', code, new Date().toISOString(), id],
    });
  }

  async status(id: string, sid: string, status: string, errorCode: string | null = null) {
    const rank = ranks[status];
    if (!Object.hasOwn(ranks, status) || rank === undefined) throw new Error('Unsupported SMS status.');
    const now = new Date().toISOString();
    // Bind the SID, append the event, and advance state in one transaction.
    // A callback can arrive before messages.create returns to the CLI.
    const result = await this.client.batch([
      { sql: `UPDATE messages SET twilio_sid = COALESCE(twilio_sid, ?) WHERE id = ? AND direction = 'outbound' AND (twilio_sid IS NULL OR twilio_sid = ?)`, args: [sid, id, sid] },
      { sql: `INSERT INTO status_events (message_id, twilio_sid, status, error_code, received_at)
          SELECT id, ?, ?, ?, ? FROM messages WHERE id = ? AND twilio_sid = ? AND direction = 'outbound'
          ON CONFLICT(message_id, twilio_sid, status, error_code) DO NOTHING`, args: [sid, status, errorCode ?? '', now, id, sid] },
      { sql: `UPDATE messages SET status = ?, status_rank = ?, error_code = ?, updated_at = ?
          WHERE id = ? AND twilio_sid = ? AND direction = 'outbound' AND (status_rank < ? OR status = ?)`,
        args: [status, rank, errorCode, now, id, sid, rank, status] },
    ], 'write');
    if (!result[0]?.rowsAffected) throw new Error('Outbound message not found or Twilio SID mismatch.');
  }

  async events(id: string) {
    return (await this.client.execute({ sql: 'SELECT * FROM status_events WHERE message_id = ? ORDER BY id', args: [id] })).rows;
  }
}
