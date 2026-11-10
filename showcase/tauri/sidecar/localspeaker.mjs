// The Local voice: spoken replies come from a TTS service already running on the user's DGX or IGX, instead of
// Fish Audio. It mirrors the public surface Sidekick uses on createSpeaker (setKey / setModel / setVoice / start /
// stop, and an onAudio callback), so the rest of Sidekick — streaming, the cue filter, beats, the
// {kind:'speech', pcm} messages to the overlay — is unchanged. The only difference is the transport: a function
// that turns text into audio bytes from your local server. That endpoint (path, request body, whether it returns
// PCM or WAV) is injected as `transport`; nothing in here needs to know its shape.
//
// Pure: importable by the sidecar and by the tests with nothing installed. sidekick.mjs supplies the transport.

// A no-voice transport (nothing running yet, or voice off) is the same shape as a live one — emit nothing.
export const SILENT_TRANSPORT = () => ({ stop: () => {}, onProblem: () => {} });

// Bytes of audio to a Uint8Array: Buffer, Uint8Array, ArrayBuffer, or { buffer, byteOffset?, byteLength? }.
// Anything else (null, a string) becomes empty, so a bad transport can never push junk into the audio path.
export const toBytes = (b) => {
  if (b == null) return new Uint8Array(0);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (b.buffer instanceof ArrayBuffer && Number.isFinite(b.byteLength)) return new Uint8Array(b.buffer, b.byteOffset ?? 0, b.byteLength);
  return new Uint8Array(0);
};

const emit = (state, b) => {
  if (state.stopped) return;
  const buf = toBytes(b);
  if (buf.length) state.onAudio(buf);
};

/**
 * One reply's local voice. start(text) plays a sentence through the injected transport and pipes its bytes back
 * through onAudio(bytes); end() finishes the reply, abort()/stop() cuts it off. It performs no network calls
 * itself — `transport(text)` is the server contract, returning either { chunk } (whole reply), or
 * { onChunk: Promise<bytes>, stop() } (streamed), or throwing when the server refuses.
 */
export const createLocalVoice = ({
  baseURL = '',
  model = '',
  transport = SILENT_TRANSPORT,
  onAudio = () => {},
  onEnd = () => {},
  onError = () => {},
} = {}) => {
  const state = {
    key: null, voice: null, baseURL, model, transport, onAudio, onEnd, onError,
    seq: 0, stopped: false, current: null, text: '',
  };

  // Run the transport for one sentence. `stopper` collects how to finish it: resolve on success (emits onEnd),
  // reject on a transport error (reports onError), and abort to cut a streaming request short.
  const play = (text, stopper) => {
    let result;
    try {
      result = state.transport(String(text ?? ''));
    } catch (e) {
      stopper.reject(e);
      return;
    }
    if (result?.chunk) emit(state, result.chunk);
    if (typeof result?.stop === 'function') stopper.abort = () => { try { result.stop(); } catch {} };
    if (result && typeof result.onChunk?.then === 'function') {
      result.onChunk.then((c) => {
        if (state.stopped) return;
        if (c) emit(state, c);
        stopper.resolve();
      }, (e) => stopper.reject(e));
      return;
    }
    stopper.resolve();
  };

  const makeStopper = () => {
    let settled = false;
    const stopper = {
      abort: null,
      resolve() {
        if (settled) return;
        settled = true;
        state.onEnd?.();
      },
      reject(e) {
        if (settled) return;
        settled = true;
        state.onError?.(e);
      },
    };
    return stopper;
  };

  const cut = () => {
    state.stopped = true;
    const c = state.current;
    state.current = null;
    c?.abort?.();
  };

  return {
    setKey(k) { state.key = k ?? null; },
    setModel(m) { state.model = m ?? ''; },
    setVoice(v) { state.voice = v ?? null; },
    get key() { return state.key; },
    get voice() { return state.voice; },
    get model() { return state.model; },
    // Whether the local service is usable: a real transport plus a base URL. The caller decides text-only fallback.
    get local() {
      return typeof state.transport === 'function' && state.transport !== SILENT_TRANSPORT && !!String(state.baseURL ?? '').trim();
    },
    /** A new reply's voice. say(sentence) as they stream in, then end(). */
    start(text = '') {
      cut();
      state.stopped = false;
      state.text = String(text ?? '');
      const me = {
        id: `l${++state.seq}`,
        say(s) { if (state.stopped) return; state.text = String(s ?? ''); },
        end() { state.onEnd?.(); },
        abort() { cut(); },
      };
      play(state.text, makeStopper());
      state.current = me;
      return me;
    },
    stop() { cut(); },
  };
};
