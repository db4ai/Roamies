// The Local / Light-LLM provider: Roamies's own OpenAI-compatible model gateway (your DGX or IGX), so a
// request can have a brain without any cloud sign-in or key. Everything a provider needs — a stable id, a
// model list, a base URL and an optional key — lives in config here, because your gateway's model catalog isn't
// always reachable (an Ollama/Light-LLM gateway may not answer /models). The model string and its context window
// are therefore configured in the panel and sent to the OpenAI-compatible agent as-is, rather than pulled from
// gg-core's cloud catalog.
//
// Pure: imported by the sidecar and by the tests with nothing installed. sidekick.mjs adds the routing.

export const LOCAL_PROVIDER_ID = 'local';
// Shown in the Model menu/page, kept distinct from the cloud sign-in labels in providers.mjs.
export const LOCAL_PROVIDER_LABEL = 'Local · Light LLM';
// Default secret name for an optional API key, stored in the keychain like the Fish key; an empty key is fine.
export const LOCAL_DEFAULT_KEY_NAME = 'local-llm';
// When your gateway reports no /models, the model comes from config and its context window from here (a light
// model's size). Sent to the OpenAI-compatible agent as the model string regardless.
export const LOCAL_DEFAULT_CONTEXT = 16384;

// Normalizes the saved Local config into { enabled, baseUrl, keyName, model, context } — or null when off or
// before a gateway URL is set. The url keeps only the scheme+host+port+optional path (a gateway like
// http://192.168.1.22:8000/v1); the model may be an explicit id or null until the gateway lists /models.
export function normalizeLocal(config = {}) {
  if (!config || typeof config?.baseUrl !== 'string' || !config.baseUrl.trim()) return null;
  const url = config.baseUrl.trim().replace(/\/+$/, '');
  const host = (() => { try { return new URL(url === '' ? 'http://x' : url).host; } catch { return null; } })();
  if (!config.baseUrl.trim() || host === '') return null;
  const context = Number.isFinite(config.context) && config.context > 0 ? Math.floor(config.context) : LOCAL_DEFAULT_CONTEXT;
  const model = (config.modelId ?? config.model?.id ?? '').trim();
  return {
    enabled: config.enabled !== false,
    baseUrl: config.baseUrl.trim(),
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
    key: false,           // an optional key is entered in the Local config block, not alongside a cloud account
    models: models.map((m) => ({ id: m.id, name: m.name })),
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
