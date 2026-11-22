// Chrome native messaging framing: 4-byte little-endian length prefix + UTF-8 JSON.
export const MAX_INBOUND = 64 * 1024 * 1024; // Chrome -> host limit
export const MAX_OUTBOUND = 1024 * 1024; // host -> Chrome limit (1 MB)

export function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > MAX_OUTBOUND) throw new Error(`message too large: ${body.length} bytes`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Streaming decoder. push(chunk) returns the complete messages decoded so far; partial frames are
 * buffered until the rest arrives.
 */
export function createDecoder() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const out = [];
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len > MAX_INBOUND) throw new Error(`frame too large: ${len}`);
        if (buf.length < 4 + len) break;
        out.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
        buf = buf.subarray(4 + len);
      }
      return out;
    },
    get pending() {
      return buf.length;
    },
  };
}
