// Tests for the Local (Light-LLM) providers and the Local voice transport (localprovider.mjs + localspeaker.mjs).
// Pure: no installed deps, importable with `node --test`, and no network — gateways are stubbed. They assert the
// contracts the wiring depends on: any number of OpenAI-compatible gateways, each with its own URL, key and
// model; model discovery from /v1/models; and the LocalVoice transport that replays DGX audio as PCM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PROVIDER_PREFIX, LOCAL_PROVIDER_LABEL, LOCAL_DEFAULT_CONTEXT,
  LOCAL_PRESETS, LOCAL_TTS_DEFAULT_MODEL, LOCAL_TTS_DEFAULT_VOICE, LOCAL_TTS_DEFAULT_URL,
  isLocalProviderId, slugify, validBaseUrl, localKeyName,
  normalizeProvider, normalizeProviders, activeProvider, isLocalEnabled,
  localRoot, localModelsUrl, localChatUrl, localSpeechUrl, discoverModels,
  localMenuProviders, localModel, localAgentRoute,
  LOCAL_MIN_OUTPUT_TOKENS, isReasoningStarved,
} from '../localprovider.mjs';
import {
  createLocalVoice, toBytes, SILENT_TRANSPORT, wavToPcm, splitSentences, createSpeechTransport,
} from '../localspeaker.mjs';

// Two gateways, the shape the panel saves.
const twoGateways = () => ({
  provider: 'local-dgx',
  localProviders: [
    { id: 'dgx', label: 'DGX Spark', baseUrl: 'https://spark.taila1d32f.ts.net:4000/v1', modelId: 'qwen3.8:27b', context: 262144 },
    { id: 'igx', label: 'IGX Thor', baseUrl: 'https://igx-thor.taila1d32f.ts.net:4000/v1', modelId: 'qwen3:4b', context: 262144 },
  ],
});

// ---------- ids and urls ----------

test('provider ids: the local- prefix marks a gateway', () => {
  assert.equal(isLocalProviderId('local-dgx'), true);
  assert.equal(isLocalProviderId('anthropic'), false);
  assert.equal(isLocalProviderId(null), false);
  assert.equal(`${LOCAL_PROVIDER_PREFIX}dgx`, 'local-dgx');
});

test('slugify: a label becomes a keychain-safe id', () => {
  assert.equal(slugify('DGX Spark'), 'dgx-spark');
  assert.equal(slugify('IGX Thor!'), 'igx-thor');
  assert.equal(slugify('  '), 'gateway');
  assert.match(localKeyName(slugify('DGX Spark')), /^local-[a-z0-9-]{1,34}$/);
  assert.ok(localKeyName('x'.repeat(60)).length <= 40); // secrets.mjs caps names at 40
});

test('validBaseUrl: http(s) with a host, nothing else', () => {
  assert.equal(validBaseUrl('https://spark.taila1d32f.ts.net:4000/v1'), true);
  assert.equal(validBaseUrl('http://192.168.2.146:4000/v1'), true);
  assert.equal(validBaseUrl(''), false);
  assert.equal(validBaseUrl('not a url'), false);
  assert.equal(validBaseUrl('192.168.2.146:4000'), false); // parsed as scheme, no host
  assert.equal(validBaseUrl('ftp://h/v1'), false);
});

test('url builders: sibling endpoints from either base shape', () => {
  assert.equal(localRoot('https://h:4000/v1'), 'https://h:4000');
  assert.equal(localModelsUrl('https://h:4000/v1'), 'https://h:4000/v1/models');
  assert.equal(localModelsUrl('https://h:4000'), 'https://h:4000/v1/models');
  assert.equal(localChatUrl('https://h:4000/v1'), 'https://h:4000/v1/chat/completions');
  assert.equal(localChatUrl('https://h:4000'), 'https://h:4000/v1/chat/completions');
  assert.equal(localSpeechUrl('http://h:8092'), 'http://h:8092/v1/audio/speech');
  assert.equal(localSpeechUrl('http://h:8092/v1'), 'http://h:8092/v1/audio/speech');
  assert.equal(localSpeechUrl('http://h:8092/v1/audio/speech'), 'http://h:8092/v1/audio/speech');
});

test('presets: both machines, over Tailscale so they work off the LAN', () => {
  assert.deepEqual(LOCAL_PRESETS.map((p) => p.id), ['dgx', 'igx']);
  for (const p of LOCAL_PRESETS) {
    assert.match(p.baseUrl, /^https:\/\/[a-z-]+\.taila1d32f\.ts\.net:4000\/v1$/);
    assert.equal(validBaseUrl(p.baseUrl), true);
    assert.ok(p.models.length > 0);
  }
  assert.ok(LOCAL_PRESETS.every((p) => p.models.includes('qwen3:4b')));
});

// ---------- config shapes ----------

test('normalizeProvider: fills id, label, key name and context', () => {
  const p = normalizeProvider({ baseUrl: 'https://h:4000/v1/', label: 'My Box', modelId: 'qwen3:4b' });
  assert.equal(p.baseUrl, 'https://h:4000/v1');   // trailing slash trimmed
  assert.equal(p.id, 'my-box');
  assert.equal(p.providerId, 'local-my-box');
  assert.equal(p.keyName, 'local-my-box');
  assert.equal(p.model, 'qwen3:4b');
  assert.equal(p.context, LOCAL_DEFAULT_CONTEXT);
  assert.equal(p.enabled, true);
});

test('normalizeProvider: no usable url -> null', () => {
  assert.equal(normalizeProvider(null), null);
  assert.equal(normalizeProvider({}), null);
  assert.equal(normalizeProvider({ baseUrl: '' }), null);
  assert.equal(normalizeProvider({ baseUrl: 'not a url' }), null);
});

test('normalizeProviders: several gateways coexist, each keeping its own model and url', () => {
  const list = normalizeProviders(twoGateways());
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((p) => p.providerId), ['local-dgx', 'local-igx']);
  assert.deepEqual(list.map((p) => p.model), ['qwen3.8:27b', 'qwen3:4b']);
  assert.deepEqual(list.map((p) => p.baseUrl), [
    'https://spark.taila1d32f.ts.net:4000/v1',
    'https://igx-thor.taila1d32f.ts.net:4000/v1',
  ]);
  // no two gateways share a keychain entry
  assert.equal(new Set(list.map((p) => p.keyName)).size, 2);
});

test('normalizeProviders: an old single-gateway config still loads', () => {
  const legacy = { provider: 'local', local: { enabled: true, baseUrl: 'http://192.168.2.146:4000/v1', modelId: 'qwen3:4b' } };
  const list = normalizeProviders(legacy);
  assert.equal(list.length, 1);
  assert.equal(list[0].baseUrl, 'http://192.168.2.146:4000/v1');
  assert.equal(list[0].model, 'qwen3:4b');
});

test('normalizeProviders: duplicate ids are dropped, not duplicated', () => {
  const list = normalizeProviders({ localProviders: [
    { id: 'dgx', baseUrl: 'https://a:4000/v1', modelId: 'm1' },
    { id: 'dgx', baseUrl: 'https://b:4000/v1', modelId: 'm2' },
  ] });
  assert.equal(list.length, 1);
  assert.equal(list[0].baseUrl, 'https://a:4000/v1');
});

test('normalizeProviders: is idempotent, so saved config round-trips', () => {
  const once = normalizeProviders(twoGateways());
  const twice = normalizeProviders({ localProviders: once });
  assert.deepEqual(twice, once);
});

test('activeProvider: follows config.provider, and picks the right gateway', () => {
  const cfg = twoGateways();
  assert.equal(activeProvider(cfg).id, 'dgx');
  assert.equal(activeProvider({ ...cfg, provider: 'local-igx' }).id, 'igx');
  assert.equal(activeProvider({ ...cfg, provider: 'anthropic' }), null); // a cloud provider is active
  assert.equal(activeProvider({ provider: 'local-gone', localProviders: [] }), null);
});

test('isLocalEnabled: needs the active gateway, enabled, with a model', () => {
  assert.equal(isLocalEnabled(twoGateways()), true);
  assert.equal(isLocalEnabled({ ...twoGateways(), provider: 'openai' }), false);
  const noModel = twoGateways(); noModel.localProviders[0].modelId = '';
  assert.equal(isLocalEnabled(noModel), false);
  const off = twoGateways(); off.localProviders[0].enabled = false;
  assert.equal(isLocalEnabled(off), false);
});

// ---------- discovery ----------

test('discoverModels: returns the gateway catalogue in OpenAI shape', async () => {
  const seen = [];
  const out = await discoverModels({
    baseUrl: 'https://h:4000/v1', apiKey: 'sk-x',
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization });
      return { ok: true, json: async () => ({ object: 'list', data: [{ id: 'qwen3:4b' }, { id: 'qwen3.8:27b', name: 'Qwen 3.8 27B' }] }) };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.models.map((m) => m.id), ['qwen3:4b', 'qwen3.8:27b']);
  assert.equal(out.models[1].name, 'Qwen 3.8 27B');
  assert.equal(seen[0].url, 'https://h:4000/v1/models');
  assert.equal(seen[0].auth, 'Bearer sk-x');
});

test('discoverModels: sends no Authorization when the gateway needs no key', async () => {
  let auth = 'unset';
  await discoverModels({ baseUrl: 'https://h:4000/v1', fetchImpl: async (_u, init) => { auth = init.headers.Authorization; return { ok: true, json: async () => ({ data: [{ id: 'm' }] }) }; } });
  assert.equal(auth, undefined);
});

test('discoverModels: a rejected key says so, and never throws', async () => {
  const out = await discoverModels({
    baseUrl: 'https://h:4000/v1', apiKey: 'bad',
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid bearer token' }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /401/);
  assert.match(out.error, /key was rejected/);
});

test('discoverModels: an unreachable gateway is an error, not an exception', async () => {
  const out = await discoverModels({ baseUrl: 'https://h:4000/v1', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(out.ok, false);
  assert.match(out.error, /Could not reach/);
});

test('discoverModels: an empty catalogue is reported, and a bad url short-circuits', async () => {
  const empty = await discoverModels({ baseUrl: 'https://h:4000/v1', fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no models/);
  let called = false;
  const bad = await discoverModels({ baseUrl: 'nope', fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ data: [] }) }; } });
  assert.equal(bad.ok, false);
  assert.equal(called, false);
});

// ---------- panel / menu ----------

test('localMenuProviders: one row per gateway, each with its own model', () => {
  const rows = localMenuProviders(twoGateways());
  assert.deepEqual(rows.map((r) => r.id), ['local-dgx', 'local-igx']);
  assert.deepEqual(rows.map((r) => r.label), ['DGX Spark', 'IGX Thor']);
  assert.deepEqual(rows[0].models, [{ id: 'qwen3.8:27b', name: 'qwen3.8:27b' }]);
  assert.deepEqual(rows[1].models, [{ id: 'qwen3:4b', name: 'qwen3:4b' }]);
  assert.ok(rows.every((r) => r.method === 'local'));
  // the two gateways are distinct menu entries, never merged
  assert.notEqual(rows[0].id, rows[1].id);
});

test('localMenuProviders: a gateway with no model yet offers none, and off ones are hidden', () => {
  const cfg = twoGateways();
  cfg.localProviders[0].modelId = '';
  cfg.localProviders[1].enabled = false;
  const rows = localMenuProviders(cfg);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].models, []);
});

test('localModel: metadata for a gateway model, null for anything else', () => {
  const m = localModel('local-dgx', 'qwen3.8:27b', 262144);
  assert.equal(m.provider, 'local-dgx');
  assert.equal(m.id, 'qwen3.8:27b');
  assert.equal(m.contextWindow, 262144);
  assert.equal(localModel('openai', 'gpt-4', 0), null);
  assert.equal(localModel('local-dgx', '', 0), null);
  // falls back to the default when nothing is known
  assert.equal(localModel('local-dgx', 'x').contextWindow, LOCAL_DEFAULT_CONTEXT);
});

test('localModel: reads the context window from the saved provider', () => {
  const m = localModel('local-igx', 'qwen3:4b', twoGateways());
  assert.equal(m.contextWindow, 262144);
});

test('localAgentRoute: routes through openai with that gateway baseUrl', () => {
  const cfg = twoGateways();
  const p = normalizeProviders(cfg).find((x) => x.id === 'igx');
  const r = localAgentRoute(p, 'sk-igx');
  assert.equal(r.provider, 'openai');
  assert.equal(r.baseUrl, 'https://igx-thor.taila1d32f.ts.net:4000/v1');
  assert.equal(r.model, 'qwen3:4b');
  assert.equal(r.webSearch, false);
  return r.resolveCredentials().then((c) => assert.deepEqual(c, { apiKey: 'sk-igx' }));
});

test('localAgentRoute: an empty key stays valid, and a half-configured provider routes nowhere', async () => {
  const p = normalizeProviders(twoGateways())[0];
  assert.deepEqual(await localAgentRoute(p, '').resolveCredentials(), {});
  assert.equal(localAgentRoute(null), null);
  assert.equal(localAgentRoute({ baseUrl: 'https://h/v1', model: null }), null);
});

test('isReasoningStarved: catches the empty reply a reasoning model returns on a small budget', () => {
  assert.equal(isReasoningStarved({ finish_reason: 'length', message: { content: '', reasoning_content: 'hmm' } }), true);
  assert.equal(isReasoningStarved({ finish_reason: 'length', message: { content: '' } }, { completion_tokens: 40 }), true);
  assert.equal(isReasoningStarved({ finish_reason: 'stop', message: { content: 'ROAMIES_OK' } }), false);
  assert.equal(isReasoningStarved({ finish_reason: 'stop', message: { content: '' } }, { completion_tokens: 0 }), false);
  assert.ok(LOCAL_MIN_OUTPUT_TOKENS >= 1024);
});

// ---------- localspeaker.mjs ----------

test('localspeaker: constants', () => {
  assert.equal(typeof SILENT_TRANSPORT, 'function');
  assert.equal(LOCAL_TTS_DEFAULT_MODEL, 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice');
  assert.equal(LOCAL_TTS_DEFAULT_VOICE, 'Ryan');
  assert.equal(LOCAL_TTS_DEFAULT_URL, 'http://100.119.225.87:8092');
});

test('toBytes: accepts Buffer, Uint8Array and {buffer} shapes', () => {
  assert.deepEqual(Array.from(toBytes(Buffer.from([1, 2, 3]))), [1, 2, 3]);
  assert.deepEqual(Array.from(toBytes(new Uint8Array([4, 5]))), [4, 5]);
  assert.equal(toBytes(null).length, 0);
  assert.equal(toBytes('nope').length, 0);
});

// A minimal 24 kHz mono PCM16 WAV, the shape the DGX returns.
const makeWav = (samples = 8, rate = 24000) => {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(i * 100, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

test('wavToPcm: strips the RIFF header and reports the real rate', () => {
  const { pcm, rate, channels, bits } = wavToPcm(makeWav(8, 24000));
  assert.equal(pcm.length, 16);
  assert.equal(rate, 24000);
  assert.equal(channels, 1);
  assert.equal(bits, 16);
});

test('wavToPcm: tolerates a non-WAV body and a truncated data chunk', () => {
  assert.equal(wavToPcm(Buffer.from([1, 2, 3])).pcm.length, 0);
  assert.equal(wavToPcm(Buffer.from('plain pcm frames here')).pcm.length, 0);
  const wav = makeWav(8);
  assert.equal(wavToPcm(wav.subarray(0, wav.length - 6)).pcm.length, 10);
});

test('splitSentences: keeps terminators and merges tiny fragments', () => {
  assert.deepEqual(splitSentences('Hello there. I am Roamie, running locally! Does this work? Yes.'),
    ['Hello there.', 'I am Roamie, running locally!', 'Does this work? Yes.']);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('One'), ['One']);
});

test('createLocalVoice: a transport result is emitted as PCM byte-for-byte', async () => {
  const got = [];
  const v = createLocalVoice({
    baseURL: 'http://h:8092/v1/audio/speech', model: LOCAL_TTS_DEFAULT_MODEL,
    transport: () => ({ chunk: makeWav(4, 24000) }),
    onAudio: (b, r) => got.push({ b: toBytes(b), r }), onEnd: () => {},
  });
  assert.equal(v.local, true);
  const t = v.start();
  t.say('hello');
  t.end();
  await Promise.resolve();
  assert.deepEqual(Array.from(got[0].b), [0, 0, 100, 0, 200, 0, 44, 1]);
  assert.equal(got[0].r, 24000);
});

test('createLocalVoice: setTransport swaps the transport, so a saved edit takes effect', async () => {
  const got = [];
  const v = createLocalVoice({ baseURL: 'http://h:8092/v1/audio/speech', onAudio: (b) => got.push(b.length) });
  assert.equal(v.local, false, 'silent until a transport is set');
  v.setTransport(() => ({ chunk: makeWav(3) }));
  assert.equal(v.local, true);
  v.start().say('hi');
  await Promise.resolve();
  assert.equal(got.length, 1);
  assert.equal(got[0], 6);
});

test('createLocalVoice: a transport that throws reports onError, not an exception', async () => {
  let err = null;
  const v = createLocalVoice({
    baseURL: 'http://h:8092/v1/audio/speech',
    transport: () => { throw new Error('server refused'); },
    onError: (e) => { err = e; },
  });
  v.start().say('x');
  await Promise.resolve();
  assert.equal(err?.message, 'server refused');
});

test('createLocalVoice: local is false with no transport or no url', () => {
  assert.equal(createLocalVoice({ transport: SILENT_TRANSPORT, baseURL: '' }).local, false);
  assert.equal(createLocalVoice({}).local, false);
});

test('createLocalVoice: onEnd fires only after the audio has been fetched', async () => {
  let ended = false, resolveAudio;
  const v = createLocalVoice({
    baseURL: 'http://h:8092/v1/audio/speech',
    transport: () => ({ onChunk: new Promise((r) => { resolveAudio = () => r(makeWav(2)); }) }),
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
    baseURL: 'http://h:8092/v1/audio/speech', apiKey: 'k',
    model: LOCAL_TTS_DEFAULT_MODEL, voice: 'Ryan',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, arrayBuffer: async () => wav }; },
  });
  const out = await t('hello').onChunk;
  assert.deepEqual(Array.from(out), Array.from(wav));
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.input, 'hello');
  assert.equal(body.voice, 'Ryan');
  assert.equal(body.response_format, 'wav');
});

test('createSpeechTransport: a non-2xx becomes a readable error', async () => {
  const t = createSpeechTransport({
    baseURL: 'http://h:8092/v1/audio/speech',
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
