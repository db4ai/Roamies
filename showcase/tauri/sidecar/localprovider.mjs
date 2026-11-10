// The Local / Light-LLM provider: Roamies's own OpenAI-compatible model gateway (LiteLLM on the user's DGX or
// IGX), so a request can have a brain without any cloud sign-in or key. Everything a provider needs — a stable
// id, a model list, a base URL and an optional key — lives in config here, because the gateway's model catalog
// isn't always reachable (a gateway may be down, or slow to answer /models). The model string and its context
// window are therefore configured in the panel and sent to the OpenAI-compatible agent as-is, rather than pulled
// from gg-core's cloud catalog.
//
// Verified against the live DGX and IGX LiteLLM gateways: gg-ai routes a custom server as
// `{ provider: 'openai', baseUrl, resolveCredentials: () => ({ apiKey }) }` and streams it correctly (it treats
// an `openai` with a custom baseUrl as an unknown OpenAI-compatible server, not the Responses API).
//
// Pure: imported by the sidecar and by the tests with nothing installed. sidekick.mjs adds the routing.

export const LOCAL_PROVIDER_ID = 'local';
// Shown in the Model menu/page, kept distinct from the cloud sign-in labels in providers.mjs.
export const LOCAL_PROVIDER_LABEL = 'Local · Light LLM';
// Default secret name for the optional API key, stored in the keychain like the Fish key; an empty key is fine.
export const LOCAL_DEFAULT_KEY_NAME = 'local-llm';
// Fallback context window when neither the panel nor the gateway says. Every chat model on both boxes is
// configured with a 256k window except gpt-oss:120b (128k), so this is a deliberately small, safe default.
export const LOCAL_DEFAULT_CONTEXT = 32768;

/**
 * The two gateways as they exist today, offered as one-tap presets in the panel. `models` is the ordered
 * shortlist worth showing first — a light model to start with, a coder, and one big option. The gateway's own
 * /v1/models stays the full source when it answers; this list only seeds the menu before it does.
 */
export const LOCAL_PRESETS = [
  {
    id: 'dgx',
    label: 'DGX Spark',
    baseUrl: 'http://192.168.2.146:4000/v1',
    models: ['qwen3:4b', 'qwen3.5:35b', 'qwen3.8:27b', 'qwen3-coder:30b', 'gpt-oss:120b', 'qwen3-vl:32b'],
  },
  {
    id: 'igx',
    label: 'IGX Thor',
    baseUrl: 'http://192.168.2.147:4000/v1',
    models: ['qwen3:4b', 'qwen3.8:27b', 'qwen3-coder:30b', 'ornith-1.5:35b', 'qwen3-vl:32b'],
  },
];

// The local TTS server (Qwen3-TTS) is OpenAI-compatible too: POST /v1/audio/speech, Bearer auth, WAV back.
export const LOCAL_TTS_DEFAULT_PATH = '/v1/audio/speech';
export const LOCAL_TTS_DEFAULT_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
export const LOCAL_TTS_DEFAULT_VOICE = 'Ryan';
export const LOCAL_TTS_DEFAULT_KEY_NAME = 'local-tts';

// Normalizes the saved Local config into { enabled, baseUrl, keyName, model, context } — or null when off or
// before a gateway URL is set. The url keeps only the scheme+host+port+optional path (a gateway like
// http://192.168.2.146:4000/v1); the model may be an explicit id or null until the gateway lists /models.
export function normalizeLocal(config = {}) {
  if (!config || typeof config?.baseUrl !== 'string' || !config.baseUrl.trim()) return null;
  const url = config.baseUrl.trim().replace(/\/+$/, '');
  // A gateway is http(s) with a real host. This rejects a typo like "192.168.2.146:4000" (parsed as scheme
  // "192.168.2.146:" with an empty host) instead of saving something that can only fail at request time.
  let parsed = null;
  try { parsed = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return null;
  const context = Number.isFinite(config.context) && config.context > 0 ? Math.floor(config.context) : LOCAL_DEFAULT_CONTEXT;
  // Accepts the raw panel shape (modelId, or a model object) and its own normalized output, so normalizeLocal
  // stays idempotent: config read back from disk can be normalized again without losing the model.
  const model = String(
    config.modelId ?? (typeof config.model === 'string' ? config.model : config.model?.id) ?? '',
  ).trim();
  return {
    enabled: config.enabled !== false,
    baseUrl: url, // trailing slashes trimmed, so /v1/chat/completions is built from a clean base
    keyName: (config.keyName || LOCAL_DEFAULT_KEY_NAME).trim() || LOCAL_DEFAULT_KEY_NAME,
    model: model || null,
    context,
  };
}

// True only when Local is on and a gateway URL is set — the branch makeAgent takes.
export function isLocalEnabled(config = {}) {
  const n = normalizeLocal(config);
  return n !== null && n.enabled;
}

// The base URL without the trailing /v1, for building sibling endpoints like /v1/models from a /v1 base.
export const localRoot = (baseUrl = '') => String(baseUrl).trim().replace(/\/+$/, '').replace(/\/v1$/, '');

// The models endpoint for a gateway base (…/v1 -> …/v1/models, … -> …/v1/models).
export const localModelsUrl = (baseUrl = '') => {
  const u = String(baseUrl).trim().replace(/\/+$/, '');
  return u.endsWith('/v1') ? `${u}/models` : `${u}/v1/models`;
};

// The chat-completions endpoint, for a gateway that only speaks the plain OpenAI REST shape.
export const localChatUrl = (baseUrl = '') => {
  const u = String(baseUrl).trim().replace(/\/+$/, '');
  return u.endsWith('/v1') ? `${u}/chat/completions` : `${u}/v1/chat/completions`;
};

// The TTS endpoint from a server base. Accepts a bare host, …/v1, or the full /v1/audio/speech already.
export const localSpeechUrl = (baseUrl = '') => {
  const u = String(baseUrl).trim().replace(/\/+$/, '');
  if (/\/v1\/audio\/speech$/.test(u)) return u;
  if (u.endsWith('/v1')) return `${u}/audio/speech`;
  return `${u}${LOCAL_TTS_DEFAULT_PATH}`;
};

// A provider row for the panel's model list (panelState.providers). Even with no signed-in cloud accounts it
// shows the configured model so the user can switch to their local brain.
export function localMenuProvider(config, on = false) {
  const n = normalizeLocal(config);
  const models = n?.model ? [{ id: n.model, name: n.model }] : [];
  return {
    id: LOCAL_PROVIDER_ID,
    label: LOCAL_PROVIDER_LABEL,
    on,
    method: 'local',      // a local gateway, never a cloud OAuth sign-in
    key: true,            // a virtual key is saved in the keychain; the gateway also accepts an empty one
    models: models.map((m) => ({ id: m.id, name: m.name })),
    presets: LOCAL_PRESETS.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, models: p.models })),
  };
}

/**
 * The model metadata for the local provider, so the request budget and the menu label resolve for a gateway
 * model gg-core doesn't know about. modelId is the model string (as sent to the agent); if a context window is
 * given (the panel-picked one, or the gateway's) it's returned for requestBudget, else it falls back to the
 * saved default. Returns null for any non-local id.
 */
export function localModel(provider, modelId, context = null) {
  if (provider !== LOCAL_PROVIDER_ID) return null;
  const id = String(modelId ?? '').trim();
  if (!id) return null;
  const ctx = Number.isFinite(context) && context > 0 ? context : LOCAL_DEFAULT_CONTEXT;
  return { provider: LOCAL_PROVIDER_ID, id, name: id, contextWindow: ctx };
}

/**
 * How makeAgent should reach the local gateway: the gg-ai options that route an OpenAI-compatible custom server.
 * `provider: 'openai'` with a custom `baseUrl` is exactly what gg-ai treats as an unknown compatible server, so
 * this is a routing detail, not a second provider implementation. Returns null when Local is off.
 */
export function localAgentRoute(config = {}, apiKey = '') {
  const n = normalizeLocal(config);
  if (!n || !n.enabled || !n.model) return null;
  return {
    provider: 'openai',
    baseUrl: n.baseUrl,
    model: n.model,
    // Local gateways ignore the key often enough that an empty one must stay valid; send Bearer only when set.
    resolveCredentials: async () => (apiKey ? { apiKey } : {}),
    webSearch: false, // no provider-side search on a local gateway
    cacheRetention: undefined, // prompt caching is an Anthropic concept
  };
}

/**
 * Reasoning models on these gateways (qwen3.x, ornith, deepseek-v4) spend part of the budget on hidden
 * reasoning_content before writing a single visible token. A small max_tokens therefore returns an EMPTY reply
 * with finish_reason 'length' — verified against qwen3:4b and qwen3.5:35b on the DGX. Roamies asks for short
 * spoken replies, so the budget must stay well clear of the reasoning floor.
 */
export const LOCAL_MIN_OUTPUT_TOKENS = 1024;

// True when a completion came back empty because reasoning ate the whole output budget (not a real answer).
export function isReasoningStarved(choice, usage = null) {
  const msg = choice?.message ?? {};
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.trim() : '';
  const finish = choice?.finish_reason;
  if (text) return false;
  return finish === 'length' || reasoning.length > 0 || (usage?.completion_tokens ?? 0) > 0;
}
