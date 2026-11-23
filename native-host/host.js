// Native messaging host: {type:"chat"|"ping"|"log"} in, {ok, ...} out. One response per request.
// Launched via the generated tidy-tabs-host wrapper, which sets TIDY_CLAUDE_BIN to an absolute path.
import { encodeMessage, createDecoder } from './framing.js';
import { normalizeRequest, runClaude } from './claude.js';
import { writeRunLog } from './logfile.js';

export const VERSION = '0.3.0';
const claudeBin = process.env.TIDY_CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;

function send(obj) {
  let frame;
  try {
    frame = encodeMessage(obj);
  } catch (e) {
    frame = encodeMessage({ ok: false, id: obj.id, error: e.message });
  }
  process.stdout.write(frame);
}

async function handle(msg) {
  const id = msg?.id;
  if (msg?.type === 'ping') return { ok: true, id, version: VERSION, claudeBin };
  if (msg?.type === 'log') {
    try {
      return { ...writeRunLog(msg.record), id };
    } catch (e) {
      return { ok: false, id, error: `log write failed: ${e.message}` };
    }
  }
  try {
    const req = normalizeRequest(msg);
    return { ...(await runClaude(req, { claudeBin })), id };
  } catch (e) {
    return { ok: false, id, error: String(e?.message || e) };
  }
}

const decoder = createDecoder();
let inflight = 0;
let ended = false;
const maybeExit = () => {
  if (ended && inflight === 0) process.exit(0);
};

process.stdin.on('data', (chunk) => {
  let msgs;
  try {
    msgs = decoder.push(chunk);
  } catch (e) {
    send({ ok: false, error: `bad frame: ${e.message}` });
    process.exit(1);
  }
  for (const m of msgs) {
    inflight++;
    handle(m)
      .then(send)
      .finally(() => {
        inflight--;
        maybeExit();
      });
  }
});
process.stdin.on('end', () => {
  ended = true;
  maybeExit();
});
