// Tests for the Local / Light-LLM provider and the Local voice transport (localprovider.mjs + localspeaker.mjs).
// Pure: no installed deps, importable with `node --test`, and no network — the DGX contract is exercised through
// a stubbed fetch. They assert the two contracts the wiring depends on: the OpenAI-compatible provider routing
// (including the reasoning-budget trap these gateways have), and the LocalVoice speaker transport that replays
// audio from the DGX Qwen3-TTS server through the existing {kind:'speech', pcm} path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PROVIDER_ID, LOCAL_PROVIDER_LABEL, LOCAL_DEFAULT_KEY_NAME, LOCAL_DEFAULT_CONTEXT,
  LOCAL_PRESETS, LOCAL_TTS_DEFAULT_MODEL, LOCAL_TTS_DEFAULT_VOICE,
  normalizeLocal, isLocalEnabled, localMenuProvider, localModel,
  localRoot, localModelsUrl, localChatUrl, localSpeechUrl, localAgentRoute,
  LOCAL_MIN_OUTPUT_TOKENS, isReasoningStarved,
} from '../localprovider.mjs';
import {
  createLocalVoice, toBytes, SILENT_TRANSPORT, wavToPcm, splitSentences, createSpeechTransport,
} from '../localspeaker.mjs';

// ---------- localprovider.mjs ----------

test('localprovider: constants', () => {
  assert.equal(LOCAL_PROVIDER_ID, 'local');
  assert.match(LOCAL_PROVIDER_LABEL, /Light LLM/);
  assert.equal(LOCAL_DEFAULT_KEY_NAME, 'local-llm');
  assert.equal(LOCAL_DEFAULT_CONTEXT, 32768);
});

test('localprovider: presets point at the two real gateways', () => {
  const ids = LOCAL_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['dgx', 'igx']);
  for (const p of LOCAL_PRESETS) {
    assert.match(p.baseUrl, /^http:\/\/192\.168\.2\.\d+:4000\/v1$/);
    assert.ok(p.models.length > 0);
  }
  // the light model both boxes serve, and the one Roamies defaults to for a quick reply
  assert.ok(LOCAL_PRESETS.every((p) => p.models.includes('qwen3:4b')));
});

test('normalizeLocal: off or no url → null', () => {
  assert.equal(normalizeLocal(null), null);
  assert.equal(normalizeLocal({}), null);
  assert.equal(normalizeLocal({ baseUrl: '' }), null);
  assert.equal(normalizeLocal({ baseUrl: '   ' }), null);
  assert.equal(normalizeLocal({ baseUrl: 'not a url' }), null);
});

test('normalizeLocal: a complete config', () => {
  const n = normalizeLocal({ enabled: true, baseUrl: 'http://192.168.2.146:4000/v1/', modelId: 'qwen3:4b', context: 262144, keyName: 'my-key' });
  assert.equal(n.baseUrl, 'http://192.168.2.146:4000/v1'); // trailing slash trimmed
  assert.equal(n.model, 'qwen3:4b');
  assert.equal(n.context, 262144);
  assert.equal(n.keyName, 'my-key');
  assert.equal(n.enabled, true);
});

test('normalizeLocal: accepts a model object as well as a bare id', () => {
  const n = normalizeLocal({ baseUrl: 'http://192.168.2.147:4000/v1', model: { id: 'ornith-1.5:35b' } });
  assert.equal(n.model, 'ornith-1.5:35b');
});

test('normalizeLocal: is idempotent, so config read back from disk keeps its model', () => {
  const once = normalizeLocal({ baseUrl: 'http://192.168.2.146:4000/v1', modelId: 'qwen3:4b', context: 262144 });
  const twice = normalizeLocal(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.model, 'qwen3:4b');
});

test('normalizeLocal: default key name and context when omitted', () => {
  const n = normalizeLocal({ baseUrl: 'http://192.168.2.146:4000/v1' });
  assert.equal(n.keyName, LOCAL_DEFAULT_KEY_NAME);
  assert.equal(n.context, LOCAL_DEFAULT_CONTEXT);
  assert.equal(n.model, null);
});

test('isLocalEnabled: on requires enabled and a url', () => {
  assert.equal(isLocalEnabled({ baseUrl: 'http://192.168.2.146:4000/v1' }), true); // enabled defaults true
  assert.equal(isLocalEnabled({ enabled: false, baseUrl: 'http://192.168.2.146:4000/v1' }), false);
  assert.equal(isLocalEnabled({}), false);
});

test('url builders: sibling endpoints from either base shape', () => {
  assert.equal(localRoot('http://h:4000/v1'), 'http://h:4000');
  assert.equal(localModelsUrl('http://h:4000/v1'), 'http://h:4000/v1/models');
  assert.equal(localModelsUrl('http://h:4000'), 'http://h:4000/v1/models');
  assert.equal(localChatUrl('http://h:4000/v1'), 'http://h:4000/v1/chat/completions');
  assert.equal(localChatUrl('http://h:4000'), 'http://h:4000/v1/chat/completions');
  // the TTS server is its own host:8092 and takes the full audio path
  assert.equal(localSpeechUrl('http://h:8092'), 'http://h:8092/v1/audio/speech');
  assert.equal(localSpeechUrl('http://h:8092/v1'), 'http://h:8092/v1/audio/speech');
  assert.equal(localSpeechUrl('http://h:8092/v1/audio/speech'), 'http://h:8092/v1/audio/speech');
});

test('localMenuProvider: row always lists the configured model, a local method and both presets', () => {
  const row = localMenuProvider({ baseUrl: 'http://192.168.2.146:4000/v1', modelId: 'qwen3:4b' });
  assert.equal(row.id, 'local');
  assert.equal(row.label, LOCAL_PROVIDER_LABEL);
  assert.equal(row.method, 'local');
  assert.equal(row.key, true);
  assert.deepEqual(row.models, [{ id: 'qwen3:4b', name: 'qwen3:4b' }]);
  assert.equal(row.presets.length, 2);
});

test('localModel: provider + metadata, null for a non-local id', () => {
  const m = localModel('local', 'qwen3:4b', 262144);
  assert.equal(m.provider, 'local');
  assert.equal(m.id, 'qwen3:4b');
  assert.equal(m.contextWindow, 262144);
  assert.equal(localModel('openai', 'gpt-4', 0), null);
  assert.equal(localModel('local', '', 0), null);
  // falls back to the default context when none given
  assert.equal(localModel('local', 'x').contextWindow, LOCAL_DEFAULT_CONTEXT);
});

test('localAgentRoute: routes through openai with a custom baseUrl, and needs a model', () => {
  assert.equal(localAgentRoute({}), null);
  assert.equal(localAgentRoute({ baseUrl: 'http://192.168.2.146:4000/v1' }), null); // no model yet
  assert.equal(localAgentRoute({ enabled: false, baseUrl: 'http://h:4000/v1', modelId: 'qwen3:4b' }), null);
  const r = localAgentRoute({ baseUrl: 'http://192.168.2.146:4000/v1', modelId: 'qwen3:4b' }, 'sk-test');
  assert.equal(r.provider, 'openai'); // gg-ai treats openai + custom baseUrl as an unknown compatible server
  assert.equal(r.baseUrl, 'http://192.168.2.146:4000/v1');
  assert.equal(r.model, 'qwen3:4b');
  assert.equal(r.webSearch, false);
  return r.resolveCredentials().then((c) => assert.deepEqual(c, { apiKey: 'sk-test' }));
});

test('localAgentRoute: an empty key stays valid (a local gateway may need none)', async () => {
  const r = localAgentRoute({ baseUrl: 'http://h:4000/v1', modelId: 'qwen3:4b' }, '');
  assert.deepEqual(await r.resolveCredentials(), {});
});

test('isReasoningStarved: catches the empty reply a reasoning model returns on a small budget', () => {
  // measured on the DGX: qwen3.5:35b with max_tokens 40 returned content '' and reasoning_content of 852 chars
  assert.equal(isReasoningStarved({ finish_reason: 'length', message: { content: '', reasoning_content: 'hmm' } }), true);
  assert.equal(isReasoningStarved({ finish_reason: 'length', message: { content: '' } }, { completion_tokens: 40 }), true);
  // a real answer is never starved, and neither is a genuinely empty one with no budget used
  assert.equal(isReasoningStarved({ finish_reason: 'stop', message: { content: 'ROAMIES_OK' } }), false);
  assert.equal(isReasoningStarved({ finish_reason: 'stop', message: { content: '' } }, { completion_tokens: 0 }), false);
  assert.ok(LOCAL_MIN_OUTPUT_TOKENS >= 1024);
});

// ---------- localspeaker.mjs ----------

test('localspeaker: constants', () => {
  assert.equal(typeof SILENT_TRANSPORT, 'function');
  assert.equal(LOCAL_TTS_DEFAULT_MODEL, 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice');
  assert.equal(LOCAL_TTS_DEFAULT_VOICE, 'Ryan');
});

test('toBytes: accepts Buffer, Uint8Array and {buffer} shapes', () => {
  assert.deepEqual(Array.from(toBytes(Buffer.from([1, 2, 3]))), [1, 2, 3]);
  assert.deepEqual(Array.from(toBytes(new Uint8Array([4, 5]))), [4, 5]);
  assert.equal(toBytes(null).length, 0);
  assert.equal(toBytes('nope').length, 0); // non-binary is dropped
});

// A minimal 24 kHz mono PCM16 WAV, the shape the DGX returns.
const makeWav = (samples = 8, rate = 24000) => {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(i * 100, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);   // PCM
  header.writeUInt16LE(1, 22);   // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

test('wavToPcm: strips the RIFF header and reports the real rate', () => {
  const wav = makeWav(8, 24000);
  const { pcm, rate, channels, bits } = wavToPcm(wav);
  assert.equal(pcm.length, 16);            // 8 samples × 2 bytes, no header
  assert.equal(rate, 24000);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
  assert.equal(pcm[0], 0);
  assert.equal(pcm[1], 0);
});

test('wavToPcm: tolerates a non-WAV body and a truncated data chunk', () => {
  assert.equal(wavToPcm(Buffer.from([1, 2, 3])).pcm.length, 0);   // too short
  assert.equal(wavToPcm(Buffer.from('plain pcm frames here')).pcm.length, 0); // not RIFF
  const wav = makeWav(8);
  const cut = wav.subarray(0, wav.length - 6); // data chunk claims more than is there
  assert.equal(wavToPcm(cut).pcm.length, 10);  // clamped, never read past the buffer
});

test('splitSentences: keeps terminators and merges tiny fragments', () => {
  assert.deepEqual(splitSentences('Hello there. I am Roamie, running locally! Does this work? Yes.'),
    ['Hello there.', 'I am Roamie, running locally!', 'Does this work? Yes.']);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences('One'), ['One']);
});

test('createLocalVoice: a transport result is emitted as PCM byte-for-byte', async () => {
  const got = [];
  const wav = makeWav(4, 24000);
  const v = createLocalVoice({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    model: LOCAL_TTS_DEFAULT_MODEL,
    transport: () => ({ chunk: wav }),
    onAudio: (b, r) => got.push({ b: toBytes(b), r }),
    onEnd: () => {},
  });
  assert.equal(v.local, true);
  const t = v.start();
  t.say('hello');
  t.end();
  await Promise.resolve();
  assert.deepEqual(Array.from(got[0].b), [0, 0, 100, 0, 200, 0, 44, 1]); // 300 = 0x012C, little-endian
  assert.equal(got[0].r, 24000); // rate came out of the WAV header
});

test('createLocalVoice: a streaming transport emits each chunk', async () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    transport: () => ({ onChunk: Promise.resolve(makeWav(2)) }),
    onAudio: (b) => got.push(toBytes(b)),
    onEnd: () => {},
  });
  v.start().say('stream');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(got.length, 1);
  assert.equal(got[0].length, 4);
});

test('createLocalVoice: a transport that throws reports onError, not an exception', async () => {
  let err = null;
  const v = createLocalVoice({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    transport: () => { throw new Error('server refused'); },
    onError: (e) => { err = e; },
  });
  v.start().say('x');
  await Promise.resolve();
  assert.equal(err?.message, 'server refused');
});

test('createLocalVoice: local is false when the transport is absent/silent and baseURL is empty', () => {
  assert.equal(createLocalVoice({ transport: SILENT_TRANSPORT, baseURL: '' }).local, false);
  assert.equal(createLocalVoice({ transport: SILENT_TRANSPORT }).local, false);
  assert.equal(createLocalVoice({}).local, false);
});

test('createLocalVoice: setTransport swaps the transport, so a saved edit takes effect', async () => {
  const got = [];
  const v = createLocalVoice({ baseURL: 'http://h:8092/v1/audio/speech', onAudio: (b) => got.push(b.length) });
  assert.equal(v.local, false, 'silent until a transport is set');
  v.setTransport(() => ({ chunk: makeWav(3) })); // was silent: without setTransport this would emit nothing
  assert.equal(v.local, true);
  v.start().say('hi');
  await Promise.resolve();
  assert.equal(got.length, 1);
  assert.equal(got[0], 6);
});

test('createLocalVoice: stop() does not double-play a completed transport', async () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    transport: () => ({ chunk: makeWav(1) }),
    onAudio: () => got.push(1),
    onEnd: () => {},
  });
  const t = v.start();
  t.say('hi');
  await Promise.resolve();
  v.stop();
  await Promise.resolve();
  assert.equal(got.length, 1); // the transport produced its audio once; nothing replayed
});

test('createLocalVoice: onEnd fires only after the audio has been fetched', async () => {
  let ended = false;
  let resolveAudio;
  const v = createLocalVoice({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    transport: () => ({ onChunk: new Promise((r) => { resolveAudio = () => r(makeWav(2)); }) }),
    onAudio: () => {},
    onEnd: () => { ended = true; },
  });
  const t = v.start();
  t.say('slow sentence.');
  t.end();
  await Promise.resolve();
  assert.equal(ended, false, 'reply end must not fire before its audio lands');
  resolveAudio();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ended, true);
});

test('createSpeechTransport: posts the OpenAI speech body and returns WAV bytes', async () => {
  let seen = null;
  const wav = makeWav(4);
  const t = createSpeechTransport({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    apiKey: 'k',
    model: LOCAL_TTS_DEFAULT_MODEL,
    voice: 'Ryan',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, arrayBuffer: async () => wav }; },
  });
  const out = await t('hello').onChunk;
  assert.deepEqual(Array.from(out), Array.from(wav));
  assert.equal(seen.url, 'http://192.168.2.146:8092/v1/audio/speech');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.input, 'hello');
  assert.equal(body.model, LOCAL_TTS_DEFAULT_MODEL);
  assert.equal(body.voice, 'Ryan');
  assert.equal(body.response_format, 'wav');
});

test('createSpeechTransport: a non-2xx becomes a readable error', async () => {
  const t = createSpeechTransport({
    baseURL: 'http://192.168.2.146:8092/v1/audio/speech',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bearer token required' }),
  });
  await assert.rejects(() => t('hi').onChunk, /local TTS 401: bearer token required/);
});

test('createSpeechTransport: no url or no text makes no request', () => {
  const t = createSpeechTransport({ baseURL: '', fetchImpl: async () => { throw new Error('should not call'); } });
  assert.equal(t('hello'), null);
  const t2 = createSpeechTransport({ baseURL: 'http://h:8092/v1/audio/speech', fetchImpl: async () => { throw new Error('should not call'); } });
  assert.equal(t2('   '), null);
});
