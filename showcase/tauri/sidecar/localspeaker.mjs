// The Local voice: spoken replies come from the Qwen3-TTS server already running on the user's DGX, instead of
// Fish Audio. It mirrors the surface Sidekick uses on createSpeaker (setKey / setModel / setVoice / start / stop,
// plus per-reply say / end / abort), so streaming, the cue filter, beats and the {kind:'speech', pcm} messages to
// the overlay stay unchanged.
//
// The DGX server (pilot/speech-runtime/server.py) is OpenAI-compatible:
//   POST /v1/audio/speech   Authorization: Bearer <media-api.key>
//   { model, input, voice, language, response_format: 'wav' }  ->  audio/wav (24 kHz mono PCM16)
// with X-Audio-Sample-Rate on the response. So there is no bespoke protocol to guess: one fetch per sentence,
// and the WAV body is split into its PCM frames for the overlay. Measured warm latency on the DGX is ~0.5 s per
// short phrase (first call after a cold start pays a ~35 s model load).
//
// Pure: importable by the sidecar and by the tests with nothing installed. sidekick.mjs supplies the endpoint.

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

/**
 * Split a WAV file into the PCM payload the overlay wants. The DGX returns a RIFF/WAVE header ahead of 24 kHz
 * mono PCM16; the overlay plays raw frames, so the 44-byte (or larger, with extra chunks) header is skipped by
 * walking the chunk list rather than assuming a fixed offset. Returns { pcm, rate, channels, bits } — pcm is the
 * data chunk only, and rate falls back to the header (or the X-Audio-Sample-Rate value) when needed.
 */
export const wavToPcm = (input) => {
  const bytes = toBytes(input);
  const empty = { pcm: new Uint8Array(0), rate: 0, channels: 1, bits: 16 };
  if (bytes.length < 12) return empty;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return empty;
  let off = 12, rate = 0, channels = 1, bits = 16, pcm = new Uint8Array(0);
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      channels = view.getUint16(body + 2, true) || 1;
      rate = view.getUint32(body + 4, true) || 0;
      bits = view.getUint16(body + 14, true) || 16;
    } else if (id === 'data') {
      // A truncated final chunk is clamped rather than read past the buffer.
      pcm = bytes.subarray(body, Math.min(body + size, bytes.length));
      break;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  return { pcm, rate, channels, bits };
};

// Split a reply into speakable sentences so each one can be fetched and played as soon as it exists, instead of
// waiting for the whole reply. Keeps the terminator; drops empties. Short fragments stay with their neighbour so
// the voice doesn't clip into unnatural one-word sentences.
export const splitSentences = (text = '') => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const parts = clean.match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [clean];
  const out = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    if (out.length && (s.length < 12 || out[out.length - 1].length < 12)) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
};

/**
 * One reply's local voice. start(text) fetches each sentence through the injected transport and pipes its PCM
 * back through onAudio(bytes, rate); end() finishes the reply, abort()/stop() cuts it off. It performs no network
 * calls itself — `transport(text, signal)` is the server contract, returning
 *   { chunk: <wav bytes> }            whole reply at once, or
 *   { onChunk: Promise<bytes> }       streamed/awaited, or
 *   throwing                          when the server refuses.
 */
export const createLocalVoice = ({
  baseURL = '',
  model = '',
  onAudio = () => {},
  onEnd = () => {},
  onError = () => {},
  onProblem = () => {},
  transport = SILENT_TRANSPORT,
  sentenceSplit = true,
} = {}) => {
  const state = {
    key: null, voice: null, language: 'English', baseURL, model, transport, sentenceSplit,
    onAudio, onEnd, onError, onProblem,
    seq: 0, stopped: false, current: null, text: '', said: [], heard: false, pending: 0,
  };

  // Pipe one audio body to the overlay, converting WAV to PCM when it is WAV (a raw PCM server passes through).
  const emit = (b, rateHint = 0) => {
    if (state.stopped) return;
    const bytes = toBytes(b);
    if (!bytes.length) return;
    const { pcm, rate } = wavToPcm(bytes);
    const body = pcm.length ? pcm : bytes; // not WAV: assume the server already sent raw frames
    const hz = rate || rateHint || 24000;
    if (!state.heard) state.heard = true;
    state.onAudio(body, hz);
  };

  const playOne = (text, stopper, rateHint = 0) =>
    new Promise((resolve) => {
      let result;
      try {
        result = state.transport(String(text ?? ''), stopper.signal);
      } catch (e) {
        stopper.reject(e);
        return resolve();
      }
      if (!result) return stopper.resolve();
      if (result.chunk) emit(result.chunk, rateHint);
      if (typeof result.stop === 'function') stopper.abort = () => { try { result.stop(); } catch {} };
      if (result.onChunk && typeof result.onChunk.then === 'function') {
        result.onChunk.then(
          (c) => { if (!state.stopped && c) emit(c, rateHint); stopper.resolve(); resolve(); },
          (e) => { stopper.reject(e); resolve(); },
        );
        return;
      }
      stopper.resolve();
      resolve();
    });

  const makeStopper = () => {
    let settled = false;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    return {
      signal: controller?.signal,
      abort: () => controller?.abort(),
      resolve() { if (settled) return; settled = true; },
      reject(e) { if (settled) return; settled = true; state.onError?.(e); },
    };
  };

  const cut = () => {
    state.stopped = true;
    const c = state.current;
    state.current = null;
    c?.stopper?.abort?.();
  };

  return {
    setKey(k) { state.key = k || null; },
    // The transport is swappable so the endpoint, key or voice can change without rebuilding the voice (which
    // would drop the reply in flight). Without this the engine keeps whatever transport it was created with.
    setTransport(fn) { if (typeof fn === 'function') state.transport = fn; },
    getTransport() { return state.transport; },
    setModel(m) { state.model = m || ''; },
    setVoice(v) { state.voice = v || null; },
    setLanguage(l) { state.language = l || 'English'; },
    get key() { return state.key; },
    get voice() { return state.voice; },
    get model() { return state.model; },
    get on() { return typeof state.transport === 'function' && state.transport !== SILENT_TRANSPORT; },
    // Usable right now: a real transport, a base URL, and (for the DGX server) a key.
    get local() { return this.on && !!String(state.baseURL ?? '').trim(); },
    get heard() { return state.heard; },

    /** A new reply's voice. say(sentence) as text streams in, then end(). */
    start() {
      cut();
      state.stopped = false;
      state.said = [];
      state.heard = false;
      state.pending = 0;
      const stopper = makeStopper();
      let ended = false;
      // Sentences are synthesised ONE AT A TIME, in order. Fetching them concurrently and playing whatever
      // arrives first is what made the voice start mid-sentence: a short second sentence would overtake a slow
      // first one. The queue also keeps only one request on the TTS server, which serialises anyway.
      let queue = Promise.resolve();
      // end() only fires once the last sentence's audio has been fetched, so a short reply isn't clipped by the
      // reply's end arriving before its audio does.
      const finishIfIdle = () => {
        if (state.stopped || state.pending > 0 || !ended) return;
        state.stopped = true;
        state.onEnd?.();
      };
      const me = {
        id: `l${++state.seq}`,
        say(s) {
          if (state.stopped) return;
          const text = String(s ?? '').trim();
          if (!text) return;
          state.said.push(text);
          for (const piece of state.sentenceSplit ? splitSentences(text) : [text]) {
            state.pending++;
            queue = queue.then(() => {
              if (state.stopped) { state.pending--; return; }
              return playOne(piece, stopper).then(() => { state.pending--; finishIfIdle(); });
            });
          }
        },
        /** Something slow is starting. The DGX has no pre-recorded beats, so the reply just stays quiet. */
        beat() { return false; },
        end() { ended = true; finishIfIdle(); },
        abort() { cut(); },
        get ok() { return !!String(state.baseURL ?? '').trim(); },
      };
      state.current = { ...me, stopper };
      return me;
    },
    stop() { cut(); },
  };
};

/**
 * The real DGX transport: one POST per sentence to /v1/audio/speech, OpenAI-compatible. Returns the shape
 * createLocalVoice expects (an onChunk promise resolving to WAV bytes) plus a stop() that aborts the request.
 * `fetchImpl` is injectable so the tests stay offline. A non-2xx response rejects with the server's detail, which
 * lands in onError and lets Sidekick fall back to text instead of speaking silence.
 */
export const createSpeechTransport = ({
  baseURL = '',
  apiKey = '',
  model = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
  voice = 'Ryan',
  language = 'English',
  instructions = '',
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = 120_000,
  logger = () => {},
} = {}) => (text, signal) => {
  const url = String(baseURL ?? '').trim();
  const input = String(text ?? '').trim();
  if (!url || !input) return null;
  const own = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = own ? setTimeout(() => own.abort(), timeoutMs) : null;
  const onAbort = () => own?.abort();
  if (signal && own) signal.addEventListener('abort', onAbort, { once: true });
  const settle = () => { try { clearTimeout(timer); } catch {} signal?.removeEventListener?.('abort', onAbort); };
  const onChunk = (async () => {
    const started = Date.now();
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          input,
          voice,
          language,
          response_format: 'wav',
          ...(instructions ? { instructions } : {}),
        }),
        signal: own?.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch {}
        throw new Error(`local TTS ${res.status}${detail ? `: ${detail}` : ''}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      logger('local_speech', { ms: Date.now() - started, bytes: buf.length, chars: input.length });
      return buf;
    } finally {
      settle();
    }
  })();
  return { onChunk, stop: () => { settle(); own?.abort(); } };
};
