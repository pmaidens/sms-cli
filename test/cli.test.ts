import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { createClient } from '@libsql/client';
import { Store } from '../src/db.js';
import { InputCancelledError, readMessageBody, readStdinBody } from '../src/input.js';

const own = '+12025550123';
const peer = '+15005550006';

async function cli(args: string[], input: string, savedBody?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'sms-cli-test-'));
  const database = `file:${join(directory, 'test.db')}`;
  try {
    const store = new Store(createClient({ url: database }));
    try {
      await store.migrate();
      if (savedBody !== undefined) await store.reserve('existing-request', own, peer, savedBody);
    } finally { store.close(); }

    // Reuse a saved request to exercise the real CLI without submitting SMS.
    // Block Twilio network calls even if a regression bypasses deduplication.
    const preload = join(directory, 'no-sms.mjs');
    const fakeTwilio = 'export default () => ({ messages: { create() { throw new Error("SMS submission disabled in CLI tests"); } } });';
    writeFileSync(preload, `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'twilio') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeTwilio)}`)}, shortCircuit: true };
  return nextResolve(specifier, context);
} });
`);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(TWILIO_|TURSO_|WEBHOOK_|DOTENV_)/.test(key)) delete env[key];
    }
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, resolve(import.meta.dirname, '../src/cli.ts'), ...args], {
      cwd: directory, input, encoding: 'utf8', timeout: 10000,
      env: {
        ...env, TURSO_DATABASE_URL: database, TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
        TWILIO_AUTH_TOKEN: 'test-token', TWILIO_PHONE_NUMBER: own, WEBHOOK_BASE_URL: 'https://sms.example.com',
      },
    });
    assert.ifError(result.error);
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('send --stdin reads complete multiline UTF-8 input and removes one final newline', async () => {
  const body = '  Hello 👋\nSecond line  ';
  const result = await cli(['send', peer, '--stdin', '--request-id', 'existing-request', '--json'], `${body}\r\n`, body);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].body, body);
  assert.match(result.stderr, /No SMS submitted/);
});

test('send accepts explicit inline text and ignores stdin', async () => {
  const body = 'Explicit inline message';
  const result = await cli(['send', peer, '--body', body, '--request-id', 'existing-request', '--json'], 'Ignored input', body);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].body, body);
});

test('send rejects empty or oversized stdin without echoing message contents', async () => {
  for (const input of ['', ' \n\t\n', 'private-message'.repeat(200), `${'x'.repeat(1601)}\n`]) {
    const result = await cli(['send', peer], input);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SMS body must contain 1 to 1600 characters/);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private-message/);
  }
});

test('send requires an explicit option for inline text', async () => {
  const result = await cli(['send', peer, 'private-positional-message'], '');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /use --body/);
  assert.doesNotMatch(result.stderr, /private-positional-message/);
});

test('bulk stdin accepts 1600 characters and preserves newlines before the final terminator', async () => {
  assert.equal(await readStdinBody(Readable.from([Buffer.from(`${'x'.repeat(1600)}\r\n`)])), 'x'.repeat(1600));
  assert.equal(await readStdinBody(Readable.from([Buffer.from('first\n\n')])), 'first\n');
  assert.equal(await readStdinBody(Readable.from([Buffer.from('no terminator')])), 'no terminator');
  const utf8 = Buffer.from('Hello 👋\n');
  assert.equal(await readStdinBody(Readable.from([utf8.subarray(0, 8), utf8.subarray(8)])), 'Hello 👋');
});

function prompt(terminal = true) {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: terminal, isRaw: false, setRawMode(enabled: boolean) { rawModes.push(enabled); } });
  let display = '';
  const output = new Writable({ write(chunk, _encoding, done) { display += chunk.toString(); done(); } });
  const body = readMessageBody(input, output);
  return { input, body, rawModes, display: () => display };
}

test('Enter submits without closing stdin in both terminals and agent pipes', async () => {
  for (const terminal of [true, false]) {
    const session = prompt(terminal);
    session.input.write('Typed message\r\n');
    assert.equal(await session.body, 'Typed message');
    assert.equal(session.input.writableEnded, false);
    assert.match(session.display(), /Enter sends/);
    assert.deepEqual(session.rawModes, terminal ? [true, false] : []);
    assert.equal(session.input.listenerCount('data'), 0);
  }
});

test('an agent can leave stdin open and the process still exits after Enter', async () => {
  const moduleUrl = new URL('../src/input.ts', import.meta.url).href;
  const script = `import { readMessageBody } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await readMessageBody()));`;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script]);
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const closed = once(child, 'close');
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    child.stdin.write('Agent message\n');
    const [code, signal] = await closed;
    assert.equal(signal, null, 'The input reader kept the process alive until the test timeout.');
    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout), 'Agent message');
    assert.equal(child.stdin.writableEnded, false);
  } finally { clearTimeout(timer); child.kill(); }
});

test('Shift-Enter and Alt-Enter insert editable newlines instead of submitting', async () => {
  for (const sequence of ['\x1b[13;2u', '\x1b[27;2;13~', '\x1b\r']) {
    const session = prompt();
    session.input.write('First line');
    // Split key sequences across input chunks, as a terminal transport may do.
    for (const character of sequence) session.input.write(character);
    session.input.write('Second linx\x7fe');
    let submitted = false;
    void session.body.then(() => { submitted = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(submitted, false);
    session.input.write('\r');
    assert.equal(await session.body, 'First line\nSecond line');
  }
});

test('bracketed multiline paste waits for Enter and preserves text', async () => {
  const session = prompt();
  session.input.write('\x1b[200~First 👋\r\nSecond\n\x1b[201~');
  let submitted = false;
  void session.body.then(() => { submitted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(submitted, false);
  session.input.write('\r');
  assert.equal(await session.body, 'First 👋\nSecond\n');
});

test('Ctrl-C cancels input, restores terminal modes, and never returns a body', async () => {
  const session = prompt();
  const rejected = assert.rejects(session.body, InputCancelledError);
  session.input.write('Private draft\x03');
  await rejected;
  assert.deepEqual(session.rawModes, [true, false]);
  assert.match(session.display(), /\x1b\[<u\x1b\[\?2004l/);
  assert.equal(session.input.listenerCount('data'), 0);
  const result = await cli(['send', peer], 'Private draft\x03\n');
  assert.equal(result.status, 130);
  assert.match(result.stderr, /cancelled/);
  assert.doesNotMatch(result.stderr, /Private draft/);
  assert.equal(result.stdout, '');
});

test('terminal EOF and oversized drafts abort and restore terminal modes', async () => {
  for (const oversized of [false, true]) {
    const session = prompt();
    const rejected = assert.rejects(session.body, oversized ? /1 to 1600/ : InputCancelledError);
    session.input.write(oversized ? 'x'.repeat(1601) : 'Unsubmitted draft');
    if (!oversized) session.input.end();
    await rejected;
    assert.deepEqual(session.rawModes, [true, false]);
  }
});

test('send uses the prompt by default and rejects conflicting input options', async () => {
  const result = await cli(['send', peer, '--request-id', 'existing-request', '--json'], 'Agent message\n', 'Agent message');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].body, 'Agent message');
  const conflict = await cli(['send', peer, '--stdin', '--body', 'Inline'], 'stdin');
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Choose either/);
});
