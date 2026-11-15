// Spawn host.js, send framed messages, collect framed replies.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeMessage, createDecoder } from '../framing.js';

export const HOST = fileURLToPath(new URL('../host.js', import.meta.url));

export function runHost(messages, { env = {}, cleanEnv = false, timeoutMs = 120000, cmd = process.execPath, args = [HOST] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: cleanEnv ? env : { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const dec = createDecoder();
    const out = [];
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`host timed out; stderr: ${err}`)); }, timeoutMs);
    child.stdout.on('data', (c) => { out.push(...dec.push(c)); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ replies: out, code, stderr: err }); });
    for (const m of messages) child.stdin.write(encodeMessage(m));
    child.stdin.end();
  });
}
