import { createInterface } from 'node:readline/promises';
import { PassThrough, type Readable, type Writable } from 'node:stream';

type Input = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown; unref?: () => unknown };
const invalidBody = 'SMS body must contain 1 to 1600 characters.';

export class InputCancelledError extends Error {
  constructor() { super('Message input cancelled. No SMS submitted.'); }
}

function validate(body: string): string {
  if (!body.trim() || body.length > 1600) throw new Error(invalidBody);
  return body;
}

export async function readMessageBody(input: Input = process.stdin, output: Writable = process.stderr): Promise<string> {
  const terminal = !!input.isTTY;
  const wasRaw = !!input.isRaw;
  const keys = new PassThrough();
  const editor = createInterface({ input: keys, output: terminal ? output : undefined, terminal: true, historySize: 0, prompt: 'Message: ' });
  let pending = '';
  let pasting = false;
  let pasteCR = false;
  let settled = false;

  return new Promise<string>((resolve, reject) => {
    function finish(error?: Error, body?: string) {
      if (settled) return;
      settled = true;
      input.off('data', onData).off('end', onEnd).off('close', onClose).off('error', onError);
      process.off('SIGINT', onCancel);
      input.pause();
      editor.close();
      keys.destroy();
      if (terminal) {
        input.setRawMode?.(wasRaw);
        // Restore keyboard reporting and bracketed paste after every exit path.
        output.write('\x1b[<u\x1b[?2004l');
      }
      // An agent may keep the pipe open. It must not keep the CLI alive.
      input.unref?.();
      if (error) reject(error);
      else {
        try { resolve(validate(body ?? '')); } catch (error) { reject(error); }
      }
    }
    function onCancel() { finish(new InputCancelledError()); }
    function onError(error: Error) { finish(error); }
    function onEnd() {
      // A closed pipe can finish a single line. A terminal disconnect never sends.
      if (terminal || pasting || pending) onCancel();
      else finish(undefined, editor.line);
    }
    function onClose() { if (!settled) onCancel(); }
    function insert(text: string) {
      const cursor = editor.cursor;
      // Node documents updating line and cursor together when editing input.
      Object.assign(editor, { line: editor.line.slice(0, cursor) + text + editor.line.slice(cursor), cursor: cursor + text.length });
      if (editor.line.length > 1600) { finish(new Error(invalidBody)); return; }
      if (terminal) editor.prompt(true);
    }
    function key(sequence: string) {
      if (sequence === '\x03') { onCancel(); return; }
      if (sequence === '\x1b[200~') { pasting = true; return; }
      if (sequence === '\x1b[201~') { pasting = false; pasteCR = false; return; }
      if (pasting) {
        if (sequence === '\n' && pasteCR) { pasteCR = false; return; }
        pasteCR = sequence === '\r';
        if (sequence === '\r') insert('\n');
        else if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(sequence)) insert(sequence);
        return;
      }
      if (sequence === '\x04') { onCancel(); return; }
      // CSI-u and xterm modifyOtherKeys encode Shift-Enter distinctly.
      if (sequence === '\x1b[27;2;13~' || sequence === '\x1b\r' || sequence === '\x1b\n') { insert('\n'); return; }
      const encoded = /^\x1b\[(\d+)(?:;(\d+)(?::([123]))?)?u$/.exec(sequence);
      if (encoded) {
        if (encoded[3] === '3') return;
        const code = Number(encoded[1]);
        const modifiers = Number(encoded[2] ?? '1') - 1;
        if ((modifiers & 4) && (code === 99 || code === 100)) { onCancel(); return; }
        if (code === 13) {
          if (modifiers & 3) insert('\n');
          else editor.write(null, { name: 'return' });
        } else if (code === 127) editor.write(null, { name: 'backspace' });
        else if (code >= 32 && code <= 0x10ffff) {
          if (modifiers & 6) editor.write(null, {
            name: String.fromCodePoint(code), ctrl: !!(modifiers & 4), meta: !!(modifiers & 2), shift: !!(modifiers & 1),
          });
          else insert(String.fromCodePoint(code));
        }
      } else if (sequence === '\r' || sequence === '\n') editor.write(null, { name: 'return' });
      else keys.write(sequence);
      if (editor.line.length > 1600) finish(new Error(invalidBody));
    }
    function onData(chunk: string) {
      pending += chunk;
      while (pending && !settled) {
        let sequence: string;
        if (pending.startsWith('\x1b')) {
          if (pending.length === 1) return;
          if (pending[1] === '[') {
            const escape = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
            if (!escape) {
              if (pending.length > 64) finish(new Error('Invalid keyboard input.'));
              return;
            }
            sequence = escape[0];
          } else {
            if (pending[1] === 'O' && pending.length < 3) return;
            sequence = pending.slice(0, pending[1] === 'O' ? 3 : 2);
          }
        } else sequence = String.fromCodePoint(pending.codePointAt(0)!);
        pending = pending.slice(sequence.length);
        key(sequence);
      }
    }
    editor.on('line', body => finish(undefined, body));
    editor.on('SIGINT', onCancel);
    editor.on('close', () => { if (!settled) onCancel(); });
    input.setEncoding('utf8');
    process.on('SIGINT', onCancel);
    input.on('data', onData).once('end', onEnd).once('close', onClose).once('error', onError);
    if (terminal) {
      input.setRawMode?.(true);
      output.write('Enter sends. Shift-Enter adds a newline; Alt-Enter also works. Ctrl-C cancels.\n\x1b[>1u\x1b[?2004h');
      editor.prompt();
    } else output.write('Message (Enter sends, Ctrl-C cancels): ');
    input.resume();
  });
}

export async function readStdinBody(input: Input = process.stdin): Promise<string> {
  if (input.isTTY) throw new Error('--stdin expects a pipe or redirected file. Omit it to use the message prompt.');
  input.setEncoding('utf8');
  let body = '';
  for await (const chunk of input) {
    body += chunk;
    // Allow a final CRLF in addition to the SMS character limit.
    if (body.length > 1602) throw new Error(invalidBody);
  }
  body = body.replace(/\r?\n$/, '');
  return validate(body);
}
