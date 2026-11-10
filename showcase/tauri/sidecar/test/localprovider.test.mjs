// Tests for the Local / Light-LLM provider (localprovider.mjs). Pure: no installed deps, importable with
// `node --test`. They assert the routing contract Sidekick depends on — the provider id, the OpenAI-compatible
// menu row, model metadata for a gateway model, and the enabled/nullable branches makeAgent takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PROVIDER_ID, LOCAL_PROVIDER_LABEL, LOCAL_DEFAULT_KEY_NAME, LOCAL_DEFAULT_CONTEXT,
  normalizeLocal, isLocalEnabled, localMenuProvider, localModel,
} from '../localprovider.mjs';

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
  // falls back to the default context when none given
  assert.equal(localModel('local', 'x').contextWindow, LOCAL_DEFAULT_CONTEXT);
});
