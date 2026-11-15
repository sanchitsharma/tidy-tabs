import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, createDecoder, MAX_OUTBOUND } from '../framing.js';

test('encode: 4-byte little-endian length + UTF-8 JSON', () => {
  const f = encodeMessage({ a: 'é' });
  const body = Buffer.from('{"a":"é"}', 'utf8');
  assert.equal(f.readUInt32LE(0), body.length);
  assert.equal(body.length, 10); // é is 2 bytes: length counts bytes, not chars
  assert.deepEqual(f.subarray(4), body);
});

test('decode round-trip, multiple frames in one chunk', () => {
  const d = createDecoder();
  const buf = Buffer.concat([encodeMessage({ n: 1 }), encodeMessage({ n: 2, s: '😀' })]);
  assert.deepEqual(d.push(buf), [{ n: 1 }, { n: 2, s: '😀' }]);
  assert.equal(d.pending, 0);
});

test('decode handles frames split at every byte boundary', () => {
  const frame = encodeMessage({ hello: 'world', list: [1, 2, 3] });
  for (let cut = 1; cut < frame.length; cut++) {
    const d = createDecoder();
    assert.deepEqual(d.push(frame.subarray(0, cut)), []);
    assert.deepEqual(d.push(frame.subarray(cut)), [{ hello: 'world', list: [1, 2, 3] }]);
  }
});

test('decode: partial header waits; oversized frame throws', () => {
  const d = createDecoder();
  assert.deepEqual(d.push(Buffer.from([5, 0])), []);
  assert.equal(d.pending, 2);
  const bad = Buffer.alloc(4);
  bad.writeUInt32LE(0xffffffff, 0);
  assert.throws(() => createDecoder().push(bad), /frame too large/);
});

test('encode refuses messages over the 1 MB host->browser limit', () => {
  assert.throws(() => encodeMessage({ s: 'x'.repeat(MAX_OUTBOUND) }), /too large/);
});
