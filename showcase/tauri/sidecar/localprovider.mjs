// Local (Light-LLM) providers: any number of OpenAI-compatible model gateways the user runs themselves
// (LiteLLM on a DGX, an IGX, an Ollama box, anything that speaks /v1/chat/completions). Each one is saved with
// its own base URL, its own key in the keychain, and its own model, so two gateways can both be configured and
// switched between from the Model menu.
//
// Every provider here is a *routing detail*, not a second implementation: gg-ai already treats
// `{ provider: 'openai', baseUrl, resolveCredentials }` as an unknown OpenAI-compatible server, so a local
// provider only needs a base URL and a key. Verified against the live DGX and IGX LiteLLM gateways.
//
// A provider id is `local-<slug>` (e.g. `local-dgx`), which slots into the app's existing provider/model
// selection: config.provider = 'local-dgx', config.model = 'qwen3.8:27b'.
//
// Pure: imported by the sidecar and by the tests with nothing installed. sidekick.mjs adds the routing.

export const LOCAL_PROVIDER_PREFIX = 'local-';
// The label a provider row falls back to when the user hasn't named it.
export const LOCAL_PROVIDER_LABEL = 'Local · Light LLM';
// Fallback context window when neither the panel nor the gateway says.
export const LOCAL_DEFAULT_CONTEXT = 32768;
// Secret names must match the store's /^[a-z0-9-]{1,40}$/ (see secrets.mjs).
export const localKeyName = (id) => `${LOCAL_PROVIDER_PREFIX}${String(id ?? 'gateway').replace(/[^a-z0-9-]/g, '-')}`.slice(0, 40);

/**
 * Ready-made gateways, offered as one-tap presets. These are the Tailscale (MagicDNS) addresses, so they work
 * from anywhere on the tailnet, not just the home LAN. `models` only seeds the picker until the gateway's own
 * /v1/models answers — the gateway stays the source of truth.
 */
export const LOCAL_PRESETS = [
  {
    id: 'dgx',
    label: 'DGX Spark',
    baseUrl: 'https://spark.taila1d32f.ts.net:4000/v1',
    models: ['qwen3:4b', 'qwen3.5:35b', 'qwen3.8:27b', 'qwen3-coder:30b', 'gpt-oss:120b', 'qwen3-vl:32b'],
  },
  {
    id: 'igx',
    label: 'IGX Thor',
    baseUrl: 'https://igx-thor.taila1d32f.ts.net:4000/v1',
    models: ['qwen3:4b', 'qwen3.8:27b', 'qwen3-coder:30b', 'ornith-1.5:35b', 'qwen3-vl:32b'],
  },
];

// The local TTS server (Qwen3-TTS) is OpenAI-compatible too: POST /v1/audio/speech, Bearer auth, WAV back.
// It binds directly to the Tailscale IP rather than sitting behind `tailscale serve`, so it is plain HTTP on
// that address (the traffic is already inside WireGuard).
export const LOCAL_TTS_DEFAULT_PATH = '/v1/audio/speech';
export const LOCAL_TTS_DEFAULT_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
export const LOCAL_TTS_DEFAULT_VOICE = 'Ryan';
export const LOCAL_TTS_DEFAULT_KEY_NAME = 'local-tts';
export const LOCAL_TTS_DEFAULT_URL = 'http://100.119.225.87:8092';

// --------------------------------------------------------------------------- ids

export const isLocalProviderId = (id) => typeof id === 'string' && id.startsWith(LOCAL_PROVIDER_PREFIX);

// A stable, secret-name-safe id from a user-facing label ("DGX Spark" -> "dgx-spark").
export const slugify = (label = '') => String(label).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'gateway';

// A base URL is usable when it is http(s) with a real host. This rejects a typo like "192.168.2.146:4000"
// (parsed as scheme "192.168.2.146:" with an empty host) rather than saving something that can only fail later.
export const validBaseUrl = (url) => {
  try {
    const u = new URL(String(url ?? '').trim());
    return /^https?:$/.test(u.protocol) && !!u.hostname;
  } catch { return false; }
};

// --------------------------------------------------------------------------- config

/**
 * One saved provider, normalized — or null when it has no usable URL.
 * Accepts both the current shape and the older single-gateway shape (baseUrl/modelId at the top level), so a
 * config written before multiple providers existed still loads.
 */
export function normalizeProvider(raw = {}, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!validBaseUrl(baseUrl)) return null;
  const label = String(raw.label ?? raw.name ?? '').trim() || LOCAL_PRESETS[index]?.label || LOCAL_PROVIDER_LABEL;
  const id = String(raw.id ?? '').trim() || slugify(label);
  // The model may arrive as modelId (panel), model (saved), or a model object.
  const model = String(
    raw.modelId ?? (typeof raw.model === 'string' ? raw.model : raw.model?.id) ?? '',
  ).trim();
  const context = Number.isFinite(raw.context) && raw.context > 0 ? Math.floor(raw.context) : LOCAL_DEFAULT_CONTEXT;
  return {
    id,
    label,
    baseUrl,
    providerId: `${LOCAL_PROVIDER_PREFIX}${id}`,
    keyName: String(raw.keyName ?? '').trim() || localKeyName(id),
    model: model || null,
    context,
    enabled: raw.enabled !== false,
  };
}

/**
 * Every saved provider, normalized and de-duplicated by id. Handles all three config shapes this feature has
 * had: a list (`localProviders`), the single-object form (`local`), and the very first scalar-free form.
 */
export function normalizeProviders(config = {}) {
  let list = [];
  if (Array.isArray(config.localProviders)) list = config.localProviders;
  else if (Array.isArray(config.local?.providers)) list = config.local.providers;
  else if (config.local && typeof config.local === 'object' && (config.local.baseUrl || config.local.modelId)) list = [config.local];
  const out = [];
  const seen = new Set();
  for (const [i, raw] of list.entries()) {
    const n = normalizeProvider(raw, i);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return out;
}

// The provider the app is currently pointed at, or null. `config.provider` holds its providerId.
export function activeProvider(config = {}) {
  const id = config.provider;
  if (!isLocalProviderId(id)) return null;
  return normalizeProviders(config).find((p) => p.providerId === id) ?? null;
}

// True when a local gateway is selected and complete enough to route to.
export function isLocalEnabled(config = {}) {
  const p = activeProvider(config);
  return !!p && p.enabled && !!p.model;
}

// --------------------------------------------------------------------------- endpoints

// The base URL without a trailing /v1.
export const localRoot = (baseUrl = '') => String(baseUrl).trim().replace(/\/+$/, '').replace(/\/v1$/, '');

// …/v1 -> …/v1/models, … -> …/v1/models.
export const localModelsUrl = (baseUrl = '') => {
  const u = String(baseUrl).trim().replace(/\/+$/, '');
  return u.endsWith('/v1') ? `${u}/models` : `${u}/v1/models`;
};

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

/**
 * Ask a gateway what it serves. This is what makes a new provider usable without typing a model id by hand:
 * LiteLLM, Ollama, vLLM and llama.cpp all answer /v1/models in the OpenAI shape. Returns
 * { ok, models: [{ id, name }], error } — never throws, so the panel can show the reason inline.
 */
export async function discoverModels({ baseUrl = '', apiKey = '', fetchImpl = (...a) => fetch(...a), timeoutMs = 20_000 } = {}) {
  const url = localModelsUrl(baseUrl);
  if (!validBaseUrl(baseUrl)) return { ok: false, models: [], error: 'That gateway URL is not valid.' };
  try {
    const res = await fetchImpl(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const hint = res.status === 401 || res.status === 403 ? ' The key was rejected.'
        : res.status === 404 ? ' Is that the /v1 base?' : '';
      return { ok: false, models: [], error: `The gateway answered ${res.status}.${hint}${detail ? ` ${String(detail).slice(0, 100)}` : ''}` };
    }
    const body = await res.json().catch(() => null);
    const models = (body?.data ?? [])
      .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: String(m?.id ?? ''), name: String(m?.name ?? m?.id ?? '') }))
      .filter((m) => m.id);
    if (!models.length) return { ok: false, models: [], error: 'The gateway listed no models.' };
    return { ok: true, models, error: null };
  } catch (e) {
    const timedOut = /timeout|abort/i.test(String(e?.message ?? ''));
    return { ok: false, models: [], error: timedOut ? 'The gateway did not answer in 20s. Is it up?' : `Could not reach the gateway: ${String(e?.message ?? e).slice(0, 110)}` };
  }
}

// --------------------------------------------------------------------------- panel/menu

/**
 * A row per saved provider for the Model menu/page, in the same shape the cloud providers use. Each row offers
 * only the model the user picked for it; the full catalog comes from discoverModels when editing.
 */
export function localMenuProviders(config = {}, signedInLocal = new Set()) {
  return normalizeProviders(config).filter((p) => p.enabled).map((p) => ({
    id: p.providerId,          // 'local-dgx'
    label: p.label,            // 'DGX Spark'
    on: signedInLocal.has(p.providerId) || !!p.model,
    method: 'local',           // a gateway, never a cloud OAuth sign-in
    key: true,                 // its virtual key lives in the keychain (may be empty)
    models: p.model ? [{ id: p.model, name: p.model }] : [],
    baseUrl: p.baseUrl,
    slug: p.id,
  }));
}

/**
 * Model metadata for a local provider, so the request budget and the menu label resolve for a gateway model
 * gg-core has no catalog entry for. Returns null for any non-local provider id.
 */
export function localModel(providerId, modelId, contextOrConfig = null) {
  if (!isLocalProviderId(providerId)) return null;
  const id = String(modelId ?? '').trim();
  if (!id) return null;
  let ctx = null;
  if (typeof contextOrConfig === 'number' && contextOrConfig > 0) ctx = Math.floor(contextOrConfig);
  else if (contextOrConfig && typeof contextOrConfig === 'object') {
    const p = normalizeProviders(contextOrConfig).find((x) => x.providerId === providerId);
    ctx = p?.context ?? null;
  }
  return { provider: providerId, id, name: id, contextWindow: ctx && ctx > 0 ? ctx : LOCAL_DEFAULT_CONTEXT };
}

/**
 * The gg-ai options for a local provider. `provider: 'openai'` with a custom baseUrl is exactly what gg-ai
 * treats as an unknown compatible server. Returns null when the provider is missing or has no model.
 */
export function localAgentRoute(provider, apiKey = '') {
  if (!provider || !provider.baseUrl || !provider.model) return null;
  return {
    provider: 'openai',
    baseUrl: provider.baseUrl,
    model: provider.model,
    // Local gateways often need no key, so an empty one must stay valid; send Bearer only when there is one.
    resolveCredentials: async () => (apiKey ? { apiKey } : {}),
    webSearch: false,            // no provider-side search on a local gateway
    cacheRetention: undefined,   // prompt caching is an Anthropic concept
  };
}

/**
 * Reasoning models on these gateways (qwen3.x, ornith, deepseek-v4) spend part of the budget on hidden
 * reasoning_content before writing a single visible token, so a small max_tokens returns an EMPTY reply with
 * finish_reason 'length' — verified against qwen3:4b and qwen3.5:35b on the DGX. The budget must stay clear of
 * that floor, or short replies come back blank.
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
