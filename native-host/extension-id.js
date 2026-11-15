// Chrome extension ID from the manifest "key" (base64 SPKI DER): sha256, first 16 bytes, hex 0-f -> a-p.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestPath = process.argv[2] || new URL('../extension/manifest.json', import.meta.url);
  const { key } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!key) { console.error('manifest has no "key"'); process.exit(1); }
  console.log(extensionIdFromKey(key));
}
