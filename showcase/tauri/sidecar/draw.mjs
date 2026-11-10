// The draw tool's pieces: the beats-and-marks schema (checked before anything draws), where each mark goes on the
// real screen, the parts already drawn (p1, p2 …) so follow-ups can edit them, photos and favicons for cards, and a
// small SMILES reader for molecules. No model-written code ever runs: the overlay only draws these structures.
import { z } from 'zod';
import { checkUrl } from './safety.mjs';

export const LIMITS = { beats: 12, marks: 40, points: 200, parts3d: 40, atoms: 120, photoBytes: 800_000, iconBytes: 64_000 };
export const TONES = ['accent', 'teal', 'amber', 'coral', 'lilac', 'sky', 'lime', 'red', 'white'];
// Marks on the real screen (they need a place on it), actions in apps, and cards drawn on calm space.
export const SCREEN = ['point', 'target', 'hover', 'ring', 'frame', 'underline', 'strike', 'check', 'cross', 'connect', 'trace', 'num', 'label', 'write', 'scroll', 'spotlight', 'highlight', 'line', 'curve', 'arrow', 'circle', 'rect'];
export const ACTIONS = ['emote', 'sfx', 'type', 'copy', 'open', 'handoff', 'button'];
export const CARDS = ['card', 'note', 'list', 'clip', 'sources', 'photo', 'graph', 'legend', 'timeline', 'molecule', 'model', 'ticket', 'medal'];
export const KINDS = [...SCREEN, ...ACTIONS, ...CARDS];
// Drawn from a list of points (screenshot pixels) instead of one place.
const PATHS = new Set(['trace', 'line', 'curve', 'arrow']);
const EMOTES = ['hype', 'wave', 'upset', 'remind', 'motivate'];
const SOUNDS = ['pop', 'tick', 'blip', 'whoosh', 'scan', 'done', 'page', 'hype', 'focus', 'expand'];
const SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus'];

const num = z.number();
const pair = z.array(num).length(2);
const triple = z.array(num).length(3);
const Target = z.object({
  text: z.string().min(1).max(80).optional(), every: z.boolean().optional(), within: z.object({ x: num, y: num, w: num, h: num }).optional(),
  id: z.number().int().optional(),
  x: num.optional(), y: num.optional(), w: num.optional(), h: num.optional(),
});
const Mark = z.object({
  kind: z.enum(KINDS),
  at: Target.optional(), to: Target.optional(), tie: Target.optional(),
  label: z.string().min(1).max(40).optional(), text: z.string().min(1).max(600).optional(),
  r: num.optional(), n: z.number().int().optional(), dir: z.enum(['up', 'down']).optional(), tone: z.enum(TONES).optional(),
  size: num.optional(), points: z.array(pair).max(LIMITS.points).optional(),
  name: z.string().max(20).optional(), url: z.string().max(2000).optional(), query: z.string().min(1).max(100).optional(),
  title: z.string().min(1).max(60).optional(), heading: z.string().min(1).max(80).optional(),
  items: z.array(z.string().min(1).max(120)).max(12).optional(),
  sources: z.array(z.object({ name: z.string().min(1).max(40), url: z.string().max(2000) })).max(8).optional(),
  x_range: pair.optional(), y_range: pair.optional(),
  plots: z.array(z.object({ points: z.array(pair).min(2).max(LIMITS.points), tone: z.enum(TONES).optional(), label: z.string().max(30).optional() })).max(4).optional(),
  dots: z.array(z.object({ x: num, y: num, label: z.string().max(30).optional() })).max(12).optional(),
  keys: z.array(z.object({ tone: z.enum(TONES), text: z.string().min(1).max(40) })).max(8).optional(),
  events: z.array(z.object({ when: z.string().min(1).max(16), text: z.string().min(1).max(60) })).max(10).optional(),
  smiles: z.string().min(1).max(200).optional(),
  parts: z.array(z.object({
    shape: z.enum(SHAPES), at: triple.optional(), size: triple.optional(), rot: triple.optional(),
    tone: z.enum(TONES).optional(), label: z.string().max(30).optional(),
  })).max(LIMITS.parts3d).optional(),
  action: z.object({ do: z.enum(['ask', 'open', 'copy']), value: z.string().min(1).max(600) }).optional(),
  task: z.string().max(120).optional(),
});
const Beat = z.object({ say: z.string().min(1).max(240), marks: z.array(Mark).max(LIMITS.marks), wait: z.enum(['click', 'hover']).optional() });
const Edit = z.object({ do: z.enum(['recolor', 'move', 'erase', 'clear']), part: z.string().max(8).optional(), tone: z.enum(TONES).optional(), dx: num.optional(), dy: num.optional() });
export const DrawArgs = z.object({
  target: z.string().optional(),
  beats: z.array(Beat).max(LIMITS.beats).optional(),
  edit: z.array(Edit).max(20).optional(),
});

const hasAt = (t) => !!t && (t.text != null || t.id != null || (t.x != null && t.y != null));
/** Everything wrong with a draw call that the schema can't say, as lines for the model; [] when it's fine. */
export function checkDraw(args) {
  const out = [], beats = args.beats ?? [], edits = args.edit ?? [];
  if (!beats.length && !edits.length) out.push('Give beats to draw, or edit to change what is drawn.');
  beats.forEach((b, i) => {
    b.marks.forEach((m, j) => {
      const where = `beat ${i + 1} mark ${j + 1} (${m.kind})`, need = (ok, what) => { if (!ok) out.push(`${where}: needs ${what}.`); };
      if (PATHS.has(m.kind)) need(m.points?.length >= 2 || hasAt(m.at), 'points ([x, y] screenshot pixels, at least 2) or at');
      else if (m.kind === 'connect') { need(hasAt(m.at), 'at'); need(hasAt(m.to), 'to'); }
      else if (SCREEN.includes(m.kind)) need(hasAt(m.at), 'at (text, id, or x and y)');
      if (m.kind === 'label' || m.kind === 'write') need(m.text || m.label, 'text');
      if (m.kind === 'emote') need(EMOTES.includes(m.name), `name, one of ${EMOTES.join(', ')}`);
      if (m.kind === 'sfx') need(SOUNDS.includes(m.name), `name, one of ${SOUNDS.join(', ')}`);
      if (m.kind === 'type') { need(hasAt(m.at), 'at (the field)'); need(m.text, 'text'); }
      if (m.kind === 'copy') need(m.text, 'text');
      if (m.kind === 'open') need(m.url, 'url');
      if (m.kind === 'button') { need(m.text && m.text.length <= 40, 'text (under 40 characters)'); need(m.action, 'action ({do: ask|open|copy, value})'); }
      if (m.kind === 'card') need(m.text || m.heading, 'text or heading');
      if (m.kind === 'note') need(m.text, 'text');
      if (m.kind === 'list') need(m.items?.length, 'items');
      if (m.kind === 'clip') need(m.title && m.text, 'title and text');
      if (m.kind === 'sources') need(m.sources?.length, 'sources');
      if (m.kind === 'photo') need(m.query || m.url, 'query (a thing with a Wikipedia page) or url');
      if (m.kind === 'graph') need(m.plots?.length || m.dots?.length, 'plots or dots');
      if (m.kind === 'legend') need(m.keys?.length, 'keys');
      if (m.kind === 'timeline') need(m.events?.length >= 2, 'events (at least 2)');
      if (m.kind === 'molecule') { need(m.smiles, 'smiles'); if (m.smiles) { try { parseSmiles(m.smiles); } catch (e) { out.push(`${where}: ${e.message}`); } } }
      if (m.kind === 'model') need(m.parts?.length, 'parts');
      if (m.kind === 'ticket') need(m.title, 'title');
      if (m.kind === 'medal') need(m.text, 'text');
    });
    if (b.wait && !b.marks.some((m) => SCREEN.includes(m.kind) && hasAt(m.at))) out.push(`beat ${i + 1}: wait needs a mark on the thing to ${b.wait} (a target or hover with at).`);
  });
  edits.forEach((e, i) => {
    if (e.do !== 'clear' && !e.part) out.push(`edit ${i + 1} (${e.do}): needs part (an id like p3).`);
    if (e.do === 'recolor' && !e.tone) out.push(`edit ${i + 1}: recolor needs tone.`);
    if (e.do === 'move' && e.dx == null && e.dy == null) out.push(`edit ${i + 1}: move needs dx or dy (screen points).`);
  });
  return out;
}

// ---------------------------------------------------------------- where marks go
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** A thing's corner radius from its box and accessibility role: round for small square things and checkboxes, a pill
 *  for thin things and words, a gently rounded box for fields, lists and anything bigger. r: given by the model. */
export function shapeRadius(w, h, role = '', r) {
  if (r != null && Number.isFinite(r)) return Math.max(0, r);
  const short = Math.min(w, h), long = Math.max(w, h), ro = String(role).toLowerCase();
  if (/check|radio|switch|toggle/.test(ro) && long <= 40) return short / 2;
  if (/field|text ?area|combo|search|table|list|group|image|web|scroll|window|area|cell|row|outline/.test(ro)) return clamp(short * 0.12, 4, 12);
  if (short <= 56) return short / 2;
  if (long <= 120 && long < short * 1.4) return short / 2;
  return clamp(short * 0.12, 8, 18);
}

/** The text match to mark: a whole label or heading (exact or word), not words buried in a paragraph. */
export function pickTextMatch(matches, find) {
  const q = String(find).trim();
  return (matches ?? []).find((m) => m.match !== 'partial' && m.text.trim().length <= Math.max(40, q.length * 3)) ?? null;
}

/** Big enough to be a window or a pane of one. The fit to drawn content is for icons, words and buttons: on a box
 *  this size it joined the neighbouring windows in, so frames came out several windows wide. */
export const windowSized = ([, , w, h]) => w >= 200 && h >= 150;
/** The open window a box was drawn round: every edge within 6% of that window's side (16 to 48 points). The closest
 *  when several fit, the frontmost on a tie; null when none does. windows: [x, y, w, h] each, front to back. */
export function fitWindow(rect, windows) {
  const [x, y, w, h] = rect;
  let best = null, bestOff = Infinity;
  for (const b of windows ?? []) {
    if (!Array.isArray(b) || !(b[2] > 0 && b[3] > 0)) continue;
    const tx = clamp(b[2] * 0.06, 16, 48), ty = clamp(b[3] * 0.06, 16, 48);
    const l = Math.abs(x - b[0]), r = Math.abs(x + w - b[0] - b[2]), t = Math.abs(y - b[1]), u = Math.abs(y + h - b[1] - b[3]);
    if (l > tx || r > tx || t > ty || u > ty) continue;
    if (l + r + t + u < bestOff) { bestOff = l + r + t + u; best = b; }
  }
  return best ? [...best] : null;
}

/** One place → { rect: [x, y, w, h] in global screen points, r, role, name }. look: { text(find), id(n), pixel(x, y), refine?(rect), snap?(rect), windows?() }. */
export async function resolveTarget(t, look, r) {
  let rect, role = '', name = '', live;
  if (t.text != null) {
    const m = await look.text(t.text);
    rect = m.bounds; role = m.role ?? 'text'; name = m.text;
  } else if (t.id != null) {
    const c = await look.id(t.id);
    rect = c.bounds; role = c.role ?? ''; name = c.label || c.role || '';
    live = c.id;
  } else if (t.x != null && t.y != null) {
    // x, y is the thing's centre, with or without w, h: models give centres either way, and read as a top-left
    // corner every loop sat half its size too low and to the right.
    if (t.w != null && t.h != null && t.w > 0 && t.h > 0) {
      const a = await look.pixel(t.x - t.w / 2, t.y - t.h / 2), b = await look.pixel(t.x + t.w / 2, t.y + t.h / 2);
      rect = [a[0], a[1], b[0] - a[0], b[1] - a[1]];
      // Round a window: that window's own edges, or the box as given when no window is there.
      if (windowSized(rect)) rect = fitWindow(rect, await look.windows?.()) ?? rect;
      // Fitted to what's really drawn there (an icon, a shape, a word, a letter); else the button or field it's a few
      // pixels off. Models' pixel guesses are often a letter or a few points out.
      else rect = (await look.refine?.(rect)) ?? (await look.snap?.(rect)) ?? rect;
    } else { const a = await look.pixel(t.x, t.y), g = [a[0] - 14, a[1] - 14, 28, 28]; rect = (await look.refine?.(g)) ?? g; }
  } else throw new Error('Give a place: text shown on screen, an id from read_window, or x and y from a screenshot.');
  rect = rect.map((v) => Math.round(v));
  return { rect, r: shapeRadius(rect[2], rect[3], role, r), role, name, ...(live != null ? { live } : {}) };
}

/** The beats with every place resolved to the screen. Paths (trace, line…) map each screenshot pixel. Cards and actions
 *  keep their content; ties and fields are resolved too. Throws the first problem, naming the mark. */
export async function resolveTargets(beats, look) {
  const out = [];
  for (const [i, b] of beats.entries()) {
    // A beat's marks are found together, so the helper fits their boxes in one go; their order stays.
    const found = await Promise.all(b.marks.map(async (m, j) => {
      const where = `beat ${i + 1} mark ${j + 1} (${m.kind})`;
      try {
        // Every place some text appears (each letter s, each mention of a word): one mark per place, in reading order.
        // within alone picks the one in that area (the text appears more than once).
        if ((m.at?.every || m.at?.within) && m.at.text != null && look.textAll) {
          let hits = await look.textAll(m.at.text);
          // within: only the ones in that part of the screenshot (x, y its centre, w, h its size).
          if (m.at.within) {
            const { x, y, w, h } = m.at.within, a = await look.pixel(x - w / 2, y - h / 2), z2 = await look.pixel(x + w / 2, y + h / 2);
            hits = hits.filter(({ bounds: [bx, by, bw, bh] }) => bx + bw / 2 >= a[0] && bx + bw / 2 <= z2[0] && by + bh / 2 >= a[1] && by + bh / 2 <= z2[1]);
          }
          if (!hits.length) throw new Error(`"${m.at.text}" isn't on screen${m.at.within ? ' in that area' : ''}.`);
          return hits.slice(0, m.at.every ? LIMITS.marks : 1).map((h) => ({ ...m, from: j, at: { rect: h.bounds.map((v) => Math.round(v)), r: shapeRadius(h.bounds[2], h.bounds[3], 'text', m.r), role: 'text', name: String(m.at.text) } }));
        }
        // from: which of the beat's marks it was made from (every can turn one into several).
        const o = { ...m, from: j };
        if (m.at && hasAt(m.at)) o.at = await resolveTarget(m.at, look, m.r);
        if (m.to && hasAt(m.to)) o.to = await resolveTarget(m.to, look);
        if (m.tie && hasAt(m.tie)) o.tie = await resolveTarget(m.tie, look);
        if (PATHS.has(m.kind) && m.points?.length >= 2) o.points = await Promise.all(m.points.map(([x, y]) => look.pixel(x, y)));
        if (m.kind === 'molecule') o.mol = parseSmiles(m.smiles);
        return [o];
      } catch (e) { throw new Error(`${where}: ${e?.message ?? e}`); }
    }));
    out.push({ say: b.say, wait: b.wait ?? null, marks: found.flat().slice(0, LIMITS.marks) });
  }
  return out;
}

// ---------------------------------------------------------------- parts drawn so far
const quote = (s) => `“${String(s).replace(/\s+/g, ' ').slice(0, 40)}”`;
/** What a mark is, in a few words, for the tool result: ring “Export”, card “Compound interest”. */
export function partDesc(m) {
  const words = m.label ?? m.title ?? m.heading ?? m.at?.name ?? m.text ?? m.query ?? m.smiles ?? '';
  return `${m.kind}${words ? ` ${quote(words)}` : ''}`;
}
const SILENT = new Set(['emote', 'sfx', 'copy', 'open', 'handoff']);
/** The parts on screen: ids never reused in a conversation, screen marks cleared on their own, cards until closed. */
export function createParts() {
  const all = new Map();
  let n = 0;
  return {
    /** Gives every drawn mark in these beats an id (part) and returns the new ids. */
    assign(beats) {
      const ids = [];
      for (const b of beats) for (const m of b.marks) {
        if (SILENT.has(m.kind)) continue;
        m.part = `p${++n}`;
        all.set(m.part, { kind: m.kind, desc: partDesc(m), screen: SCREEN.includes(m.kind) || m.kind === 'type' || (m.kind === 'button' && !!m.at) });
        ids.push(m.part);
      }
      return ids;
    },
    has: (id) => all.has(id),
    get: (id) => all.get(id),
    remove(id) { all.delete(id); },
    clear() { all.clear(); },
    clearScreen() { for (const [id, p] of all) if (p.screen) all.delete(id); },
    get screenCount() { return [...all.values()].filter((p) => p.screen).length; },
    get ids() { return [...all.keys()]; },
    describe: (ids = [...all.keys()]) => describeParts(ids.map((id) => [id, all.get(id)]).filter(([, p]) => p)),
  };
}
/** "p1 ring “Export”, p2 card “Interest”" — the ids the model edits with. */
export const describeParts = (entries) => entries.map(([id, p]) => `${id} ${p.desc}`).join(', ');

// ---------------------------------------------------------------- photos and favicons
// Fetched through the same rules as fetch_url (public http(s) only, every redirect checked), size-capped, and handed
// to the overlay as data URLs so it can dither them on its canvas without loading anything itself.
async function getChecked(url, { fetchImpl = fetch, max, accept }) {
  let at = String(url), res;
  for (let hop = 0; ; hop++) {
    const v = checkUrl(at);
    if (v.level === 'block') throw new Error(`Blocked for safety: ${v.reason}`);
    res = await fetchImpl(at, { headers: { 'user-agent': 'Roamies-Sidekick', accept }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!next) break;
    if (hop >= 4) throw new Error('Too many redirects.');
    at = new URL(next, at).href;
  }
  if (!res.ok) throw new Error(`${res.status} from ${new URL(at).hostname}`);
  const len = +(res.headers.get('content-length') ?? 0);
  if (max && len > max) throw new Error('That picture is too big.');
  const buf = Buffer.from(await res.arrayBuffer());
  if (max && buf.length > max) throw new Error('That picture is too big.');
  return { buf, type: String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), url: at };
}
const IMAGE = /^image\/(png|jpeg|jpg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;
async function imageData(url, opts) {
  const { buf, type } = await getChecked(url, { ...opts, accept: 'image/*' });
  if (!IMAGE.test(type)) throw new Error("That link isn't a picture.");
  return `data:${type};base64,${buf.toString('base64')}`;
}
/** A named thing's picture: its Wikipedia summary thumbnail (query), or a picture URL the model already found. */
export async function photoFor({ query, url }, { fetchImpl = fetch } = {}) {
  if (url) return { src: await imageData(url, { fetchImpl, max: LIMITS.photoBytes }), credit: new URL(url).hostname.replace(/^www\./, '') };
  // Titles are case-sensitive after the first letter, which Wikipedia always capitalises.
  const title = String(query).trim().replace(/\s+/g, '_'), page = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.charAt(0).toUpperCase() + title.slice(1))}`;
  const { buf } = await getChecked(page, { fetchImpl, max: 200_000, accept: 'application/json' });
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { throw new Error(`No Wikipedia page for "${query}".`); }
  const pic = j?.thumbnail?.source ?? j?.originalimage?.source;
  if (!pic) throw new Error(`Wikipedia has no picture for "${query}".`);
  return { src: await imageData(pic, { fetchImpl, max: LIMITS.photoBytes }), title: j.title ?? query, credit: 'Wikipedia' };
}
const icons = new Map();
/** A site's favicon as a data URL (cached), or null: the overlay draws a dot instead. */
export async function faviconFor(link, { fetchImpl = fetch } = {}) {
  let host;
  try { const u = new URL(String(link)); if (!/^https?:$/.test(u.protocol)) return null; host = u.hostname; } catch { return null; }
  if (icons.has(host)) return icons.get(host);
  const got = await imageData(`https://${host}/favicon.ico`, { fetchImpl, max: LIMITS.iconBytes }).catch(() => null);
  icons.set(host, got);
  return got;
}

// ---------------------------------------------------------------- SMILES (a small, strict subset)
const ORGANIC = ['Cl', 'Br', 'B', 'C', 'N', 'O', 'P', 'S', 'F', 'I'];
const AROMATIC = ['b', 'c', 'n', 'o', 'p', 's'];
const VALENCE = { B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1] };
/** Atoms (element, aromatic, charge, hydrogens) and bonds (order 1, 2, 3 or 1.5 aromatic) from a SMILES string.
 *  Supports organic-subset and bracket atoms ([NH4+], [O-], [nH], [Fe+2]), = # : - bonds, branches and ring
 *  closures (1-9, %10-%99). Anything else (chirality, / \, dots, isotopes) is refused with a reason. */
export function parseSmiles(s) {
  const str = String(s ?? '').trim();
  if (!str) throw new Error('The SMILES is empty.');
  const atoms = [], bonds = [], stack = [], rings = new Map();
  let prev = null, bond = null, i = 0;
  const fail = (why) => { throw new Error(`Can't read SMILES "${str.slice(0, 40)}" at ${i + 1}: ${why}.`); };
  const addAtom = (a) => {
    if (atoms.length >= LIMITS.atoms) fail(`more than ${LIMITS.atoms} atoms`);
    atoms.push(a); const k = atoms.length - 1;
    if (prev != null) bonds.push({ a: prev, b: k, order: bond ?? (a.arom && atoms[prev].arom ? 1.5 : 1) });
    prev = k; bond = null;
  };
  while (i < str.length) {
    const ch = str[i];
    if (ch === '(') { if (prev == null) fail('a branch before any atom'); stack.push(prev); i++; continue; }
    if (ch === ')') { if (!stack.length) fail('a ) without its ('); prev = stack.pop(); i++; continue; }
    if (ch === '-' || ch === '=' || ch === '#' || ch === ':') { if (bond != null) fail('two bonds in a row'); bond = { '-': 1, '=': 2, '#': 3, ':': 1.5 }[ch]; i++; continue; }
    if (/[0-9%]/.test(ch)) {
      if (prev == null) fail('a ring number before any atom');
      let n;
      if (ch === '%') { const m = /^%(\d\d)/.exec(str.slice(i)); if (!m) fail('% needs two digits'); n = +m[1]; i += 3; } else { n = +ch; i++; }
      if (rings.has(n)) {
        const o = rings.get(n); rings.delete(n);
        if (o.at === prev) fail('a ring closing on itself');
        const order = bond ?? o.bond ?? (atoms[o.at].arom && atoms[prev].arom ? 1.5 : 1);
        bonds.push({ a: o.at, b: prev, order }); bond = null;
      } else { rings.set(n, { at: prev, bond }); bond = null; }
      continue;
    }
    if (ch === '[') {
      const end = str.indexOf(']', i);
      if (end < 0) fail('a [ without its ]');
      const m = /^([A-Z][a-z]?|se|as|[bcnops])(H\d?)?([+-]\d?|\+\+|--)?$/.exec(str.slice(i + 1, end));
      if (!m) fail(`"[${str.slice(i + 1, end)}]" is not a supported bracket atom (no isotopes or chirality)`);
      const arom = /^[a-z]/.test(m[1]), el = arom ? m[1][0].toUpperCase() + m[1].slice(1) : m[1];
      const h = m[2] ? (m[2].length > 1 ? +m[2].slice(1) : 1) : 0;
      const c = m[3] ? (m[3] === '++' ? 2 : m[3] === '--' ? -2 : (m[3][0] === '+' ? 1 : -1) * (m[3].length > 1 ? +m[3].slice(1) : 1)) : 0;
      addAtom({ el, arom, charge: c, h, bracket: true });
      i = end + 1; continue;
    }
    const org = ORGANIC.find((e) => str.startsWith(e, i));
    if (org) { addAtom({ el: org, arom: false, charge: 0, h: null }); i += org.length; continue; }
    if (AROMATIC.includes(ch)) { addAtom({ el: ch.toUpperCase(), arom: true, charge: 0, h: null }); i++; continue; }
    fail(`"${ch}" is not supported`);
  }
  if (stack.length) fail('a ( without its )');
  if (rings.size) fail(`ring ${[...rings.keys()][0]} is never closed`);
  if (bond != null) fail('a bond with nothing after it');
  // Implicit hydrogens for organic-subset atoms: the smallest normal valence that fits, minus the bonds.
  for (const [k, a] of atoms.entries()) {
    if (a.h != null) continue;
    // Aromatic n, o, s, p carry no implicit hydrogen (pyrrole's is written [nH]); an aromatic bond counts once, plus
    // one for the ring's shared double bond.
    if (a.arom && a.el !== 'C' && a.el !== 'B') { a.h = 0; continue; }
    const mine = bonds.filter((b) => b.a === k || b.b === k);
    const used = mine.reduce((s, b) => s + (b.order === 1.5 ? 1 : b.order), 0) + (mine.some((b) => b.order === 1.5) ? 1 : 0);
    const v = (VALENCE[a.el] ?? [0]).find((x) => x >= used) ?? used;
    a.h = Math.max(0, v - used);
  }
  return { atoms: atoms.map(({ el, arom, charge, h }) => ({ el, arom, charge, h })), bonds };
}
