// Tests for the Local voice transport (localspeaker.mjs). Pure: no installed deps, importable with
// `node --test`. They assert the speaker interface Sidekick uses — a streamed reply is played from the injected
// transport and piped back through onAudio; a failed transport reports onError; stop() ends it; and the
// "reachable" flag drives the text-only fallback. The concrete server contract is injected, never fixed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalVoice, toBytes, SILENT_TRANSPORT } from '../localspeaker.mjs';

test('localspeaker: constants', () => {
  assert.equal(typeof SILENT_TRANSPORT, 'function');
});

test('toBytes: accepts Buffer, Uint8Array and {buffer} shapes', () => {
  const b = toBytes(Buffer.from([1, 2, 3]));
  assert.deepEqual(Array.from(b), [1, 2, 3]);
  assert.deepEqual(Array.from(toBytes(new Uint8Array([4, 5]))), [4, 5]);
  assert.equal(toBytes(null).length, 0);
  assert.equal(toBytes('nope').length, 0); // non-binary is dropped
});

test('createLocalVoice: a transport result is emitted byte-for-byte', () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://localhost:4000/tts',
    model: 'parakeet',
    transport: () => ({ chunk: Buffer.from([9, 8, 7]) }),
    onAudio: (b) => got.push(toBytes(b)),
    onEnd: () => {},
  });
  assert.equal(v.local, true);
  v.start('hello').end();
  assert.deepEqual(Array.from(got[0]), [9, 8, 7]);
});

test('createLocalVoice: a streaming transport emits each chunk', async () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://localhost:4000/tts',
    transport: () => ({ onChunk: Promise.resolve(Buffer.from([1, 1, 1])) }),
    onAudio: (b) => got.push(toBytes(b)),
    onEnd: () => {},
  });
  v.start('stream').end();
  await Promise.resolve(); // a streamed chunk arrives on a microtask, never synchronously
  assert.deepEqual(Array.from(got[0]), [1, 1, 1]);
});

test('createLocalVoice: a transport that throws reports onError, not an exception', () => {
  let err = null;
  const v = createLocalVoice({
    baseURL: 'http://localhost:4000/tts',
    transport: () => { throw new Error('server refused'); },
    onError: (e) => { err = e; },
  });
  v.start('x').end();
  assert.equal(err?.message, 'server refused');
});

test('createLocalVoice: local is false when the transport is absent/silent and baseURL is empty', () => {
  const silent = createLocalVoice({ transport: SILENT_TRANSPORT, baseURL: '' });
  assert.equal(silent.local, false);
  const off = createLocalVoice({ transport: SILENT_TRANSPORT });
  assert.equal(off.local, false);
});

test('createLocalVoice: stop() before end() does not double-play', () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://localhost:4000/tts',
    transport: () => ({ chunk: Buffer.from([1]) }),
    onAudio: (b) => got.push(1),
    onEnd: () => {},
  });
  v.start('hi').abort();
  v.stop();
  assert.equal(got.length, 1); // the transport produced its audio once; nothing replayed
});
