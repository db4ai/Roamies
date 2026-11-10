// The Local voice: spoken replies come from a TTS service already running on the user's DGX or IGX, instead of
// Fish Audio. It implements the same public surface createSpeaker exposes (setKey / setModel / setVoice / start /
// stop plus the emit callback), so the rest of Sidekick — streaming, cue filter, beats, the {kind:'speech', pcm}
// messages to the overlay — is unchanged. The only difference is the transport: a function that turns text into
// audio bytes from your local server. That endpoint (path, request body, whether it returns PCM or WAV) is filled
// in during Slice B discovery and injected as `transport`; nothing else in here needs to know.
//
// Pure: importable by the sidecar and by the tests with nothing installed. sidekick.mjs wires the transport.

// A no-voice transport (nothing running yet, or voice off) is the same shape as a live one — emit nothing.
export const SILENT_TRANSPORT = () => ({ stop: () => {}, onProblem: () => {} });

/**
 * One reply's local voice. On start(), it runs the transport for the streamed sentences and pipes back raw bytes
 * to onAudio(bytes); onEnd() once when the reply is done, onError(err) instead when it fails. stop() aborts the
 * outstanding request. It performs no network calls itself — `transport(text)` is the injected server contract.
 * bytesPerChunk: optional size hint if the transport streams (else it's a single whole reply).
 */
export const createLocalVoice = ({
  baseURL = '',
  model = '',
  transport = SILENT_TRANSPORT,
  onAudio = () => {},
  onEnd = () => {},
  onError = () => {},
  bytesPerChunk = 4096,
} = {}) => {
  const state = { baseURL, model, transport, onAudio, onEnd, onError, bytesPerChunk: Math.max(1, bytesPerChunk | 0), stopped: false };

  // A transport is a single function text -> { chunk: Uint8, done: ()=>} (chunk may be a Node Buffer, a plain
  // Uint8Array, or an object with a .buffer). It returns a stop() so a cut-off reply never lingers.
  const play = (text, stopper) => {
    let result;
    try {
      result = state.transport(text);
    } catch (e) { return stopper?.reject(e); }
    if (result?.chunk) emit(state, result.chunk);
    if (result?.stop) { stopper?.abort = () => result.stop(); }
    if (result && typeof result?.onChunk === 'function') {
      result.onChunk
        .then((c) => { c && emit(state, c); stopper.resolve?.(); })
        .catch((e) => stopper?.reject(e));
    } else {
      stopper?.resolve?.();
    }
  };

  return {
    setKey(k) { state.key = k ?? null; },
    setModel(m) { state.model = m; },
    setVoice(v) { state.voice = v; },
    start(text) {
      const stopper = { resolve: null, reject: null, abort: null };
      const p = new Promise((res, rej) => {
        stopper.resolve = () => { state.onEnd?.(); res(true); };
        stopper.reject = (e) => { state.onError?.(e); res(false); };
        play(String(text ?? ''), stopper);
      });
      state._stopper = stopper;
      return {
        id: `l${++state.seq}`,
        say(s) { state._lastText = String(s ?? ''); },
        end() { if (state.model) onAudio(null); state.onEnd?.(); },
        abort() { state.stopped = true; stopper.abort?.(); },
        get ok() { return !!state.transport && !!state.baseUrl(); },
        _play: () => play(state._lastText ?? String(text ?? ''), stopper),
      };
    },
    // Whether the local service is reachable (transport set + baseURL given). The caller decides text-only fallback.
    get local() { return typeof state.transport === 'function' && state.transport !== SILENT_TRANSPORT && !!String(state.baseURL).trim(); },
    stop() { state.stopped = true; state.onEnd?.(); },
  };
};

// Bytes of audio to a Uint8Array: Buffer, Uint8Array, or {buffer, byteOffset?, byteLength?}; null -> [].
export const toBytes = (b) => {
  if (b == null) return new Uint8Array(0);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (b.buffer instanceof ArrayBuffer && b.byteLength != null) return new Uint8Array(b.buffer, b.byteOffset ?? 0, b.byteLength);
  return new Uint8Array(0);
};
const emit = (state, b) => { const buf = toBytes(b); if (buf.length) state.onAudio(buf); };
