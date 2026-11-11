# Local models and voice: what we changed, and how to pull upstream

This branch (`local-models`) adds two things Roamies doesn't ship: local OpenAI-compatible model gateways
(Light LLM) and local speech through Qwen3-TTS, so neither needs a cloud account.

It is based on upstream `main` at `bd1e411` (v0.1.33) as a **three-commit series**, deliberately, so it can be
rebased or cherry-picked cleanly instead of being one large opaque diff.

## The three commits

| Commit | What | Upstream risk |
|---|---|---|
| `Add local Light-LLM providers and a local Qwen3-TTS voice` | Three **new** files, nothing else touched | None — new files can't conflict |
| `Route requests and spoken replies to a local gateway…` | `sidekick.mjs` only | Medium — the busy file |
| `Let the panel and setup guide add, discover and pick local gateways` | `panel.js`, `onboarding/*` | Medium |

Keeping the new modules separate matters: if a future upstream change makes the integration awkward, that first
commit can stand alone and the other two can be reworked without losing the tested libraries.

## The diff surface

**New files (safe):**

```
showcase/tauri/sidecar/localprovider.mjs    gateways, discovery, routing detail, config shapes
showcase/tauri/sidecar/localspeaker.mjs     Qwen3-TTS transport, WAV->PCM, sentence splitting
showcase/tauri/sidecar/test/local.test.mjs  38 offline cases
```

**Modified files (where conflicts will come from):**

```
showcase/tauri/sidecar/sidekick.mjs         +496/-60  the integration
showcase/onboarding/onboarding.js           +118      Connect AI + replies steps
showcase/panel/panel.js                     +92       Model page gateway list
showcase/onboarding/index.html              +37       Local blocks
showcase/onboarding/onboarding.css          +10       Local block styling
showcase/tauri/sidecar/package.json         +1        local.test.mjs in the test chain
```

Total: **8 files, +1626/−60.**

## How to pull upstream updates

```sh
cd "/Users/davidbeam/Documents/Source Code/Roamies"
git fetch origin
git checkout local-models
git rebase origin/main
```

If a rebase conflicts, it will almost certainly be in one of three places, and each has a known shape:

1. **`package.json` test chain** — upstream adds test files, we add `local.test.mjs`. Keep both; ours goes last.
2. **Insertion-point conflicts in `sidekick.mjs`** — both sides added a self-contained block at the same anchor
   (upstream added `onCli`/`shellCall`, we added the local-gateway block). Keep both blocks, either order.
3. **Single-line edits** — upstream changing the same log line or provider label we did. Take both halves.

After resolving, always:

```sh
cd showcase/tauri/sidecar
npm test                      # 27 files, incl. local.test.mjs
```

Then rebuild, because the frontend is compiled into the binary (see below).

## Things upstream will fight you on

- **The updater will overwrite this build.** Upstream's in-app update replaces `/Applications/Roamies.app` with
  the official release, which has no local support. Decline updates, or rebuild after taking one. If you want to
  stop being offered them, remove `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` for your local copy —
  but that is a change to upstream's release config, so keep it out of the branch.
- **The frontend is embedded at compile time.** Editing `showcase/panel/panel.js` alone changes nothing in an
  installed app. `build.sh` copies `../panel`, `../onboarding` and `../roamies` into `dist/`, and Cargo embeds
  `dist/`. So a rebuild is required, and a *stale `dist/`* silently ships old UI. Always re-run the copy step.
- **Release builds on this Mac need `strip` off.** `[profile.release] strip = true` corrupts proc-macro dylibs
  here (`mis-aligned LINKEDIT string pool`, then `can't find crate …`). Not a repo bug and CI is fine. Build with:

```sh
cd showcase/tauri/src-tauri
CARGO_TARGET_DIR=/tmp/rt CARGO_PROFILE_RELEASE_STRIP=false \
CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
npx --no-install @tauri-apps/cli build --bundles app
```

  Do not "fix" `build.sh` for this — `strip` is correct for real releases.

## Endpoints, and why the schemes differ

| Service | Address | Scheme |
|---|---|---|
| Model gateways (LiteLLM) | `https://spark.taila1d32f.ts.net:4000/v1` · `https://igx-thor.taila1d32f.ts.net:4000/v1` | HTTPS |
| Local voice (Qwen3-TTS) | `http://100.119.225.87:8092` | HTTP |

The gateways sit behind `tailscale serve`, which terminates TLS **only on the MagicDNS name** — the raw tailnet
IP on 4000 answers "Client sent an HTTP request to an HTTPS server" for http and fails the TLS handshake for
https. Use the `*.ts.net` names.

The TTS server publishes the Tailscale IP directly from Docker (`SPEECH_TAILSCALE_ADDRESS` in its compose file),
so it is plain HTTP on that address. That traffic is already inside WireGuard. It is not behind `tailscale serve`.

Restart the TTS container (it comes back on its own, `restart: unless-stopped`):

```sh
ssh dgx-spark
cd /opt/dgx-spark-inference-fabric-source/pilot/speech-runtime
SPEECH_BIND_ADDRESS=192.168.2.146 SPEECH_TAILSCALE_ADDRESS=100.119.225.87 \
DGX23_STATE_DIR=/home/db4ai/.local/share/dgx23-pilot docker compose up -d
```

Starting it with a bare `docker start` leaves it detached from its compose network with no ports at all — that
was the original bug. Always bring it up through compose.

## Known constraints

- **Reasoning models need a real output budget.** qwen3.x/ornith/deepseek-v4 spend tokens on hidden
  `reasoning_content` before any visible text, so a small `max_tokens` returns an empty reply with
  `finish_reason: 'length'`. `LOCAL_MIN_OUTPUT_TOKENS` (1024) and `isReasoningStarved()` exist for this.
### Measured latency (DGX, idle box, nothing resident)

| Step | Cost |
|---|---|
| LLM first call, model not loaded | **8.6 s** |
| LLM warm, same model | **1.5–1.7 s** |
| TTS, 5 chars ("Okay.") | 0.6 s |
| TTS, 20 chars | 1.0 s |
| TTS, 72 chars | 3.5 s |
| TTS, very first call after a restart | ~36 s (loads the model) |

So a spoken reply costs roughly `1.5 s (LLM) + ~1 s per sentence (TTS)`, and the first reply after the DGX has
been idle long enough to drop the model costs about 45 s. Under GPU contention those numbers were 131–179 s.

TTS scales with **sentence length**, not sentence count, so short replies are cheap and long ones are not. Keeping
replies short is the single biggest lever on perceived speed.

**Keeping models warm** is the other. Ollama unloads a model after 5 minutes idle by default; set
`OLLAMA_KEEP_ALIVE` on the DGX (e.g. `24h`) so it stays resident, or accept the ~8.6 s first-call penalty.
The TTS container keeps its model loaded once used until the container restarts.

- **The DGX has no passwordless sudo**, so it can only be power-cycled from the machine itself.
