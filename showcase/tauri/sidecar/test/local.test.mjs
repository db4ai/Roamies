// Tests for the Local / Light-LLM provider and the Local voice transport (localprovider.mjs + localspeaker.mjs).
// Pure: no installed deps, importable with `node --test`. They assert the two contracts Slice A/B introduce:
// the OpenAI-compatible provider model routing/config, and the LocalVoice speaker transport that replays audio
// from a local TTS service through the existing {kind:'speech', pcm} path. The concrete server contract is
// injected, never fixed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PROVIDER_ID, LOCAL_PROVIDER_LABEL, LOCAL_DEFAULT_KEY_NAME, LOCAL_DEFAULT_CONTEXT,
  normalizeLocal, isLocalEnabled, localMenuProvider, localModel,
} from '../localprovider.mjs';
import { createLocalVoice, toBytes, SILENT_TRANSPORT } from '../localspeaker.mjs';

// ---------- localprovider.mjs ----------

test('localprovider: constants', () => {
  assert.equal(LOCAL_PROVIDER_ID, 'local');
  assert.match(LOCAL_PROVIDER_LABEL, /Light LLM/);
  assert.equal(LOCAL_DEFAULT_KEY_NAME, 'local-llm');
  assert.equal(LOCAL_DEFAULT_CONTEXT, 16384);
});

test('normalizeLocal: off or no url → null', () => {
  assert.equal(normalizeLocal(null), null);
  assert.equal(normalizeLocal({}), null);
  assert.equal(normalizeLocal({ baseUrl: '' }), null);
  assert.equal(normalizeLocal({ baseUrl: '   ' }), null);
});

test('normalizeLocal: a complete config', () => {
  const n = normalizeLocal({ enabled: true, baseUrl: 'http://192.168.1.22:8000/v1/', modelId: 'gemma-3-4b', context: 4096, keyName: 'my-key' });
  assert.equal(n.baseUrl, 'http://192.168.1.22:8000/v1'); // trailing slash trimmed
  assert.equal(n.model, 'gemma-3-4b');
  assert.equal(n.context, 4096);
  assert.equal(n.keyName, 'my-key');
  assert.equal(n.enabled, true);
});

test('normalizeLocal: default key name and context when omitted', () => {
  const n = normalizeLocal({ baseUrl: 'http://localhost:11434/v1' });
  assert.equal(n.keyName, LOCAL_DEFAULT_KEY_NAME);
  assert.equal(n.context, LOCAL_DEFAULT_CONTEXT);
  assert.equal(n.model, null);
});

test('isLocalEnabled: on requires enabled and a url', () => {
  assert.equal(isLocalEnabled({ baseUrl: 'http://localhost:8000/v1' }), true); // enabled defaults true
  assert.equal(isLocalEnabled({ enabled: false, baseUrl: 'http://localhost:8000/v1' }), false);
  assert.equal(isLocalEnabled({}), false);
});

test('localMenuProvider: row always lists the configured model and a local method', () => {
  const row = localMenuProvider({ baseUrl: 'http://localhost:8000/v1', modelId: 'gemma-3-4b' });
  assert.equal(row.id, 'local');
  assert.equal(row.label, LOCAL_PROVIDER_LABEL);
  assert.equal(row.method, 'local');
  assert.equal(row.key, false);
  assert.deepEqual(row.models, [{ id: 'gemma-3-4b', name: 'gemma-3-4b' }]);
});

test('localModel: provider + metadata, null for a non-local id', () => {
  const m = localModel('local', 'gemma-3-4b', 4096);
  assert.equal(m.provider, 'local');
  assert.equal(m.id, 'gemma-3-4b');
  assert.equal(m.contextWindow, 4096);
  assert.equal(localModel('openai', 'gpt-4', 0), null);
  assert.equal(localModel('local', '', 0), null);
  assert.equal(localModel('local', 'x').contextWindow, LOCAL_DEFAULT_CONTEXT); // default fallback
});

// ---------- localspeaker.mjs ----------

test('localspeaker: constants', () => {
  assert.equal(typeof SILENT_TRANSPORT, 'function');
});

test('toBytes: accepts Buffer, Uint8Array and {buffer} shapes', () => {
  assert.deepEqual(Array.from(toBytes(Buffer.from([1, 2, 3]))), [1, 2, 3]);
  assert.deepEqual(Array.from(toBytes(new Uint8Array([4, 5]))), [4, 5]);
  assert.equal(toBytes(null).length, 0);
  assert.equal(toBytes('nope').length, 0); // non-binary is dropped
});

test('createLocalVoice: a transport result is emitted byte-for-byte', () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://localhost:4000/tts', model: 'parakeet',
    transport: () => ({ chunk: Buffer.from([9, 8, 7]) }),
    onAudio: (b) => got.push(toBytes(b)), onEnd: () => {},
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
    onAudio: (b) => got.push(toBytes(b)), onEnd: () => {},
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
  assert.equal(createLocalVoice({ transport: SILENT_TRANSPORT, baseURL: '' }).local, false);
  assert.equal(createLocalVoice({ transport: SILENT_TRANSPORT }).local, false);
});

test('createLocalVoice: stop() does not double-play a completed transport', () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://localhost:4000/tts',
    transport: () => ({ chunk: Buffer.from([1]) }),
    onAudio: () => got.push(1), onEnd: () => {},
  });
  v.start('hi').abort();
  v.stop();
  assert.equal(got.length, 1);
});
