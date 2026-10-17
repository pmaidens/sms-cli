import 'dotenv/config';
import { Command, InvalidArgumentError } from 'commander';
import { openStore, type Message, type Store } from './db.js';
import { phone } from './config.js';
import { gateway, reconcile, send } from './messaging.js';
import { InputCancelledError, readMessageBody, readStdinBody } from './input.js';

const program = new Command().name('sms').description('Read and send SMS with Twilio and Turso.').version('0.1.0');
const limit = (value: string) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 500) throw new InvalidArgumentError('Use a whole number from 1 to 500.');
  return number;
};

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = openStore();
  try { return await fn(store); } finally { store.close(); }
}

// Escape terminal control characters in untrusted SMS text. JSON output preserves the original data.
function safe(value: string) { return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function print(rows: Message[], json: boolean) {
  if (json) { console.log(JSON.stringify(rows.map(row => ({ ...row, media: JSON.parse(row.media_json) })), null, 2)); return; }
  if (!rows.length) { console.log('No messages.'); return; }
  for (const row of rows) {
    console.log(safe(`${row.created_at}  ${row.direction}  ${row.status}${row.direction === 'inbound' && !row.read_at ? '  unread' : ''}`));
    console.log(safe(`${row.from_number} -> ${row.to_number}  ${row.id}${row.twilio_sid ? `  ${row.twilio_sid}` : ''}`));
    console.log(safe(row.body));
    if (row.error_code) console.log(safe(`Twilio error: ${row.error_code}`));
    if (row.media_json !== '[]') console.log(safe(`Media: ${row.media_json}`));
    console.log();
  }
}

program.command('inbox').description('List received messages without marking them read')
  .option('--unread', 'Only unread messages').option('--limit <count>', 'Maximum results', limit, 30)
  .option('--before <id>', 'Fetch messages older than this local ID or Twilio SID').option('--json', 'Machine-readable output')
  .action(async opts => withStore(async store => print(await store.list({ ...opts, direction: 'inbound' }), opts.json)));

program.command('list').description('List incoming and outgoing messages')
  .option('--with <number>', 'Filter by E.164 phone number', phone).option('--limit <count>', 'Maximum results', limit, 30)
  .option('--before <id>', 'Fetch an older page').option('--json', 'Machine-readable output')
  .action(async opts => withStore(async store => print(await store.list({ ...opts, peer: opts.with }), opts.json)));

program.command('thread <number>').description('Show recent conversation in chronological order')
  .option('--limit <count>', 'Maximum results', limit, 50).option('--before <id>', 'Fetch an older page').option('--json', 'Machine-readable output')
  .action(async (number, opts) => withStore(async store => print((await store.list({ peer: phone(number), limit: opts.limit, before: opts.before })).reverse(), opts.json)));

program.command('show <id>').description('Read a message by local ID or Twilio SID')
  .option('--json', 'Machine-readable output').action(async (id, opts) => withStore(async store => {
    const message = await store.get(id);
    if (!message) throw new Error('Message not found.');
    print([message], opts.json);
  }));

program.command('read <id>').description('Mark one incoming message as read')
  .action(async id => withStore(async store => { await store.markRead(id); console.log('Marked read.'); }));

program.command('send <number>').description('Send an SMS, prompting for the message by default')
  // Reject extra arguments ourselves so Commander does not echo private text.
  .allowExcessArguments()
  .option('-b, --body <text>', 'Include the message in the command instead of reading stdin')
  .option('--stdin', 'Read the complete message from a pipe or file until EOF')
  .option('--request-id <id>', 'Reuse an ID to prevent duplicate submissions').option('--json', 'Machine-readable output')
  .action(async (number, opts, command: Command) => {
    if (command.args.length > 1) throw new Error('Unexpected positional message. Read the message from stdin, or use --body to include it in the command.');
    if (opts.stdin && opts.body !== undefined) throw new Error('Choose either --stdin or --body.');
    const to = phone(number);
    const body = opts.body ?? await (opts.stdin ? readStdinBody() : readMessageBody());
    return withStore(async store => {
      const result = await send(store, gateway(), { to, body, id: opts.requestId });
      if (result.reused) console.error('Existing request returned. No SMS submitted.');
      print([result.message], opts.json);
    });
  });

program.command('reconcile <id>').description('Refresh delivery status from Twilio without sending')
  .option('--sid <sid>', 'Attach a verified Twilio SID after an uncertain send').option('--json', 'Machine-readable output')
  .action(async (id, opts) => withStore(async store => print([await reconcile(store, gateway(), id, opts.sid)], opts.json)));

program.command('events <id>').description('Show stored delivery events')
  .action(async id => withStore(async store => {
    const message = await store.get(id);
    if (!message) throw new Error('Message not found.');
    console.log(JSON.stringify(await store.events(message.id), null, 2));
  }));

try { await program.parseAsync(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Command failed.'); process.exitCode = error instanceof InputCancelledError ? 130 : 1; }
