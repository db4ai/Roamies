# Change packet — Local (no-provider) voice + model for Roamies

## Identity and intent

- Change/task ID and authoritative task link: `documentation/task.json` (this manifest is the task).
- User/source request and date: Make Roamies able to (1) connect to a **local/light LLM** served by
  the user's own DGX/IGX (an OpenAI-compatible gateway) instead of only the built-in cloud providers,
  and (2) run its **spoken replies locally** so no paid TTS provider (Fish Audio) is required.
  Mac build first. Date: current session.
- Current baseline commit, dirty-diff identity and environment: repository freshly cloned to
  `/Users/davidbeam/Documents/Source Code/Roamies` (remote `KenKaiii/Roamies`). Unmodified working tree;
  no local commits made. Environment: macOS (Apple), Node 22 for the sidecar, Rust/Tauri for the shell.
- Actual resolved method/skill path and known origin/content identity; unresolved identity stays unknown:
  `software-delivery` delivery method, two-slice feature delivery. All source read directly (the planning
  shell is gated, so `read` was the inspection tool). Open-source identity confirmed via `showcase/tauri/
  sidecar/sidekick.mjs`, `speaker.mjs`, `fish.mjs`, `providers.mjs`, `secrets.mjs`, `voicemodel.mjs`,
  `AGENTS.md`, `README.md`, `showcase/tauri/sidecar/package.json`.
- Goal, user scenario, current workaround and measurable success: user runs a Mac. Today spoken replies
  cost money because they go through Fish Audio, and the only AI brains are cloud providers needing accounts/keys.
  Success: a typed or spoken request completes against a local OpenAI-compatible gateway, AND a spoken reply
  is produced locally with no Fish key, both reachable from the Model/Voice pages in the panel (or the setup guide).
- In scope, non-goals and admitted paths:
  - In scope: a new **"Local" (OpenAI-compatible)** provider; a **LocalVoice** TTS transport; both selectable and
    stored in existing config/secret locations; tests; panel + setup-guide UI for both.
  - Non-goals (deferred): Windows local voice (keep existing Parakeet path), STT changes (macOS speech
    recognition is already local and free — see Impact), local model *serving*, rewriting the Rust shell,
    on-device retraining, benchmarking latency across DGX vs IGX in this slice.
- Delivery profile and consequence of failure: two bounded, independent slices (A: model, B: voice). Wrong
  choice cost is low for A (a bad gateway URL just makes requests fail with a caught error → text stays in panel).
  For B the failure is "voice stays off and falls back to text" — never a crash. Both keep the existing cloud
  path working unchanged when the local option is not enabled.
- Documentation index and authoritative artifact locations/statuses:
  - `documentation/change-packet.md` — this record (requirements, impact, design, verification).
  - `documentation/task.json` — the reviewed task manifest (admitted inputs + executable checks).
  - `documentation/ui-mockups.html` — presented mockups for the Model "Local" section and the LocalVoice config.
- Coding/document standard source and status: `AGENTS.md` (rules: every file touch goes through
  `showcase/tauri/sidecar/safety.mjs`; never `--no-verify`; never commit secrets; CI `.github/workflows/ci.yml`
  must stay green). No linter configured (per `AGENTS.md`).
- Entry path and evidence available; missing artifacts and recovery boundary: evidence = source above (all read).
  Missing artifact = the **exact DGX/IGX TTS server contract** (URL + request/response shape). It is only
  observable once the shell works on the DGX; Slice B is discovery-first (see Bounded tasks, Slice B).
- Existing answers/authorization, proposed assumptions and human-owned open choices:
  - Confirmed by user: gateway is **OpenAI-compatible** ("that's what Light LLM is"); a TTS model likely already
    exists on the DGX but is unused.
  - Proposed assumption (defaulted, correctable): slice **A ships first**; **B discovers the DGX TTS contract first**
    (bounded probe), then implements. No authority granted to implement until `delivery_review_task` is accepted.

## Multi-slice scope

| Capability and source | Included/deferred/excluded, with authority | Delivering tasks/slices and shared contract | Integrated acceptance and remaining work |
| --- | --- | --- | --- |
| A. Local OpenAI-compatible LLM ("Light LLM") | Included (Goal 1), authorized for planning only | Slice A | One request completes end-to-end via the gateway from the panel | remaining: model list from gateway `/models` (optional) |
| B. Local voice (no Fish) | Included (Goal 2), authorized for planning only | Slice B, **discovery-first** | A sentence is spoken locally, played via existing PCM path | remaining: DGX TTS server must expose a fetchable endpoint |
| macOS STT (listening) | Excluded — already local/free | n/a | unchanged | n/a |

## Requirements and acceptance

| Stable ID | Behavior/property and rationale | Source/parent | Concrete acceptance example and method | Status/owner |
| --- | --- | --- | --- | --- |
| R-A-01 | A new provider **local** exists, surfaced in the Model menu/page and setup guide as "Local / Light LLM", separate from the cloud OpenAI ChatGPT sign-in. | Goal 1 | Panel "Model" page shows a Local row; selecting it activates it. Method: `test/localprovider.test.mjs` asserts provider is registered and `MENU_PROVIDERS` includes it. | Planned |
| R-A-02 | `local` takes a **base URL** (the Light LLM gateway, e.g. http://<dgx-or-igx>:port/v1) and an **optional API key** stored like Fish (keychain on macOS, allowed empty). | Goal 1; `secrets.mjs`; `sidekick.mjs` keychain usage | Enter a URL (and empty key) saves; reopen shows them. Method: `test/localprovider.test.mjs`. | Planned |
| R-A-03 | When Local is selected, a request is routed through the gg-ai Agent as an **OpenAI-compatible** call: `provider`/`model` string sent to `baseUrl`, with credentials resolved to the stored key (empty if none). | `sidekick.mjs` `makeAgent` (`resolveCredentials`, `baseUrl`) | One typed request returns a completion from a stub gateway. Method: `test/localprovider.test.mjs` stubs `resolveCredentials`/fetch and asserts the outbound request hits `baseUrl` with `Authorization: Bearer <key>` (or none). | Planned |
| R-A-04 | The local model list is configurable in code (user-picked model + context window), because an Ollama/Light-LLM gateway reports models through `/models`; model metadata must fall back to a local registry when the gateway has none. | Goal 1 | Choosing a model works whether or not `/models` responds. Method: unit asserts context-window/local-model resolution. | Planned |
| R-A-05 | When the local gateway is unreachable or errors, the request degrades to text (caught, no crash); the existing cloud providers keep working unchanged when Local is not selected. | existing error handling in `sidekick.mjs` | Point at a dead URL → panel shows a caught error, no speaker start. Method: `test/localprovider.test.mjs` negative case. | Planned |
| R-B-01 | A **LocalVoice** TTS transport produces spoken replies from a local DGX/IGX TTS service, implementing the existing `createSpeaker` interface so the rest of the pipeline is unchanged. | Goal 2; `speaker.mjs`, `fish.mjs` | One sentence is played through `emit({kind:'speech', pcm})` sourced from a stubbed local TTS server. Method: `test/localspeaker.test.mjs`. | Planned |
| R-B-02 | The LocalVoice transport is **pluggable**: the DGX TTS server contract is abstracted behind a single fetch function; the concrete endpoint (URL/headers/PCM/WAV) is filled in during Slice B discovery, not guessed. | Goal 2; discovery-first | A stub `ttsFetch` returns PCM; `LocalVoice` plays it. Method: `test/localspeaker.test.mjs` with a fake fetch. | Planned |
| R-B-03 | Voice selection persists: a "Local voice" toggle/setting chooses LocalVoice vs Fish; if Local is set but its server is unreachable, spoken replies fall back to text and listening stays local (Apple speech recognition). | Goal 2; `sidekick.mjs` VOICE_ON / macOS speech | Toggle on with dead server → replies are text only; no crash. Method: `test/localspeaker.test.mjs`. | Planned |
| R-B-04 (quality) | No secret or network credential for voice is committed; the local TTS URL is stored in config, the key (if any) in the keychain via existing `secrets` (name `local-tts`, allowed empty). | AGENTS.md "never commit secrets" | Keyring store used; no plaintext key in config/logs. Method: inspect `secrets.set('local-tts', …)` path; test asserts store. | Planned |

## Impact analysis

| Affected contract/state | Producer and consumers | Current source/tool evidence | Failure/compatibility risk | Required checks/artifact updates |
| --- | --- | --- | --- | --- |
| `makeAgent` model routing | the single request path in `sidekick.mjs` | reads `provider`/`model`, calls `new Agent({provider, resolveCredentials, baseUrl, model, ...})` | Local branch must not disturb cloud agents (provider, cache retention) | Unit test asserts local vs cloud routing; run full `npm test`. |
| Provider/model metadata | `getModel`, `getContextWindow`, `getModelsForProvider` (gg-core) | `sidekick.mjs` uses these for budget/menu/label | unknown model id may return undefined → runtime error in budget | R-A-04: add a local model registry; unit assert. |
| `menuProviders` / panel state | Model page, setup guide, menu | `sidekick.mjs` builds provider state for the panel | menu must list Local even with empty cloud sign-ins | Test asserts panel state includes Local. |
| Secret storage | `secrets.mjs` (macOS keychain via `roamies-hands`) | key stored under `fish-audio`; keychain helper already used | new name `local-llm`/`local-tts` must be allowed; empty key must be permitted | Unit assert store/set with empty value. |
| `fishAudio` TTS path | `speaker.mjs`/`fish.mjs` | only spoken-replies provider today | must remain optional; voice must work without a Fish key | Test asserts voice off + text works; no Fish key required. |
| STT / microphone / `onVoice` | macOS speech recognition, `sidekick.mjs` `VOICE_OK`, `onVoice` | listening uses Apple Speech API (local) | n/a — left unchanged (already local, no key) | Regression: existing `test/*.test.mjs` for voice panel state. |
| Panel + setup-guide UI | frontend (Rust→JS protocol messages) | `sidekick.mjs` sends `panel`/`obState` states and reads `onMenu` ids (`local*`, `fishkey`…) | new UI must follow existing message protocol | UI reviewed against mockups before build; check protocol ids. |
| Docs (`README.md`, `PRIVACY.md`, `AGENTS.md`) | user-facing | README advertises Fish Audio + cloud sign-ins | docs describe local option + no-key | Update README/Voice + Model pages and Privacy after build. |
| CI `ci.yml` | repo | `AGENTS.md` requires green CI | new tests must pass | Run `npm test`; ensure no secret/env dependence. |

## Research and decisions

| Role, authoritative location and owner | Revision/identity and input dependencies | Disposition or observed fact | Current applicability and reason/required recheck |
| --- | --- | --- | --- |
| Model provider wiring | `sidekick.mjs` `makeAgent` (this record) | read directly | authoritative for Slice A | recheck if gg-ai version bumps |
| TTS transport contract | **unknown** — DGX TTS server not yet inspected (shell gated) | placeholder: abstract behind one fetch fn | defers to Slice B discovery | recheck on first DGX probe |
| Gateway compatibility | user: OpenAI-compatible ("Light LLM") | accepted | drives R-A-03 routing | recheck if gateway differs |

## Architecture and detailed design

**Two independent slices share one seam: a config-driven provider/voice selection plus reuse of the existing
Agent and speaker pipelines. No new dependencies are introduced for the transport; both talk HTTP/WS the way the
cloud paths already do.**

### Slice A — "Local" (OpenAI-compatible) model provider

Data model (added to `~/.gg/sidekick.json`):
```
config.local = {
  enabled: false,              // "Local / Light LLM" active
  baseUrl: "http://<host>:port/v1",  // the Light LLM gateway, OpenAI-compatible
  keyName: "local-llm",        // secret name in ~/.gg keychain (allow empty)
  model: { id, name, context } // user-picked / auto-discovered model + context window
}
```
Routing (new branch at the top of `makeAgent`, `sidekick.mjs`):
```
if (config.local?.enabled && config.local.model) {
  const key = await secrets.get(config.local.keyName).catch(() => null);
  agentRoute = 'api';
  agent = new Agent({
    model: config.local.model, provider: 'openai',    // OpenAI-compatible client
    system: system(), tools, maxTurns: 24, beforeAgent: common.beforeAgent,
    resolveCredentials: async () => (key ? { apiKey: key } : {}),
    baseUrl: config.local.baseUrl,
    cacheRetention: 'none',                            // gateway is local
    ...common,
  });
}
```
- `provider: 'openai'` + `baseUrl` routes every OpenAI-compatible request to the gateway; `resolveCredentials`
  supplies the stored key (omit the header when the key is empty, so a keyless gateway still works).
- Menu/panel: add `'local'` to `MENU_PROVIDERS`; `getModelsForProvider('local')` returns the configured local
  model (with a tiny local registry fallback for context window); panel `providers[]` for local shows a model
  name instead of cloud sign-ins; Model menu shows a "Local" row with a small "edit gateway" affordance.
- `ensureModel`: keep cloud providers first; if none are signed in, prefer Local when enabled (fail soft with a
  panel message, matching existing `ensureModel` behavior).
- Security: model-list is a plain model string; the key follows the same keychain path pattern as Fish.

### Slice B — LocalVoice (no-Fish TTS)

A `LocalVoice` class implementing the same public surface `createSpeaker` exposes (`setKey`, `setModel`, `start`,
`stop`, plus the emit callback), but its transport fetches audio from the local TTS server and emits PCM:
```
const transport = (text) => ttsFetch(text, { url: config.voice.url, key }); // returns Uint8Array PCM (or WAV→PCM)
new LocalVoice({ url, key, transport, onAudio: pcm => emit({kind:'speech', rate, pcm}), ... });
```
- `ttsFetch` is the single abstraction; the concrete endpoint (path / request body / decoder for PCM vs WAV) is
  filled in during Slice B discovery against the DGX/IGX server. The interface guarantees the rest of `speaker.*`
  /`sidekick.mjs` (beats, cues, `VOICE_ON`, `emit({kind:'speech',pcm})`) is unaffected: same interface, swappable
  source.
- Voice selection: add a `localVoice` setting; `createSpeaker` accepts a transport override so Local vs Fish is
  chosen by config. Reuse `voiceConfig`/`replies` plumbing so text-only fallback works when the Local server is down.
- STT unchanged (already local). No microphone/`roamies-hands` secret path changes beyond the new empty-allowed
  `local-tts` key.

**Coding patterns/lint:** Node ESM `.mjs`, `npm test` runs all `test/*.test.mjs`; no linter exists (`AGENTS.md`).
All file/command/URL actions pass through `safety.mjs`. Mockups authored as self-contained HTML
(`documentation/ui-mockups.html`) reviewed via the inline renderer before the panel build; authoritative review
viewer = the user's native approval dialog (`delivery_review_task`).

## Verification and build

| Requirement/test ID | Fixture and independent expected behavior | Level/method | Exact command/environment | Required result |
| --- | --- | --- | --- | --- |
| R-A-01..05, R-B-01..04 | stubbed fetch/Agent/transport (no network, no real gateway or DGX at test time) | unit | `cd showcase/tauri/sidecar && node --test test/localprovider.test.mjs test/localspeaker.test.mjs` | all pass; asserts routing, menu, fail-soft, empty-key, transport emit |
| Regression | existing suite unchanged | unit | `cd showcase/tauri/sidecar && npm test` | all existing tests pass (no new failures, no secret dependence) |
| Build/bundle | sidecar bundles | build | `cd showcase/tauri/sidecar && npm run build` | `dist/sidekick.mjs` produced, no new external deps (unless Slice B needs a WAV decoder) |
| Slice B discovery | DGX TTS server (user-run, out of test scope) | manual/probe | on DGX: identify TTS endpoint; a short `curl`-equivalent probe | recorded endpoint contract feeds `ttsFetch` impl; otherwise B stays blocked (documented) |

## Bounded tasks and readiness

| Capability/task and next gate | Input identities and evidence links | Reviewer, authority/delegation source and disposition | Blocker, independent ready work and next permitted action |
| --- | --- | --- | --- |
| Slice A: Local LLM provider | `sidekick.mjs` makeAgent; `package.json`; mockups `ui-mockups.html` §A | `task.json` reviewed + accepted → implement | blocked on `delivery_review_task` acceptance; ready once accepted |
| Slice B: LocalVoice | `speaker.mjs`/`fish.mjs` interface; **DGX TTS contract** (unknown until probe) | `task.json` reviewed + accepted | blocked on `delivery_review_task` AND on DGX TTS endpoint probe (independent ready work) |

Unresolved (human-owned): where the user's local voice should physically run — DGX vs IGX — is deferred to Slice B
discovery (latency comparison is explicitly out of scope here, per user request to start with DGX/IGX and revisit).

## Execution and handoff

(To be completed during implementation: changed files, red/green observations, `npm test` output, and handoff
notes. Not implemented yet — planning only.)
