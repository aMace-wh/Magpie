import { SOURCE_ID_RE, stripTracking, stripTrackingInText } from './classify';
import { findSharePayload } from './receive';
import { itemsInCollection } from './smart';
import { ITEM_TYPES, TYPE_INFO, type Collection, type Item, type ItemType, type Place, type SmartRules, type Status, type When } from './types';

/**
 * Sharing without a server: a save, a collection or a whole library is
 * compressed into the URL fragment (fragments never reach the web server), or
 * written to a small ".magpie.json" file when it's too big for a link.
 *
 * v1 links (collections only) stay decodable forever; everything decodes to the v2 shape.
 */

// ---------------------------------------------------------------------------
// v1 (collections only) — kept so old links keep working

export interface SharedItem {
  t: ItemType;
  n: string; // title
  u?: string; // url
  d?: string; // note
  i?: string; // image
  g?: string[]; // tags
  p?: Place;
  s?: string; // source
}

export interface SharedCollection {
  v: 1;
  name: string;
  emoji: string;
  color: string;
  items: SharedItem[];
}

export function toShared(collection: Collection, items: Item[]): SharedCollection {
  return {
    v: 1,
    name: collection.name,
    emoji: collection.emoji,
    color: collection.color,
    items: items.map((i) => {
      const s: SharedItem = { t: i.type, n: i.title };
      if (i.url) s.u = i.url;
      if (i.note) s.d = i.note;
      if (i.image) s.i = i.image;
      if (i.tags.length) s.g = i.tags;
      if (i.place) s.p = i.place;
      if (i.source) s.s = i.source;
      return s;
    }),
  };
}

// ---------------------------------------------------------------------------
// v2

export type ShareKind = 'item' | 'collection' | 'library';

export interface SharedItemV2 extends SharedItem {
  ds?: string; // description from the link preview
  sn?: string; // site name
  w?: Pick<When, 'start' | 'end'>;
  x?: string; // sharedText — the original post / message
  c?: string[]; // collection keys (library only)
  k?: string; // sender's key for a save without a link, so it's recognised in their other shares
  // Personal — only when the sender opted in:
  r?: number; // rating
  rv?: string; // review
  st?: Status;
}

export interface SharedCollectionRef {
  key: string;
  name: string;
  emoji: string;
  color: string;
  /** Short fingerprint of the sender's collection id (shareId), so it merges with the same collection shared on its own. */
  id?: string;
}

export interface SharedPayloadV2 {
  v: 2;
  kind: ShareKind;
  /** Stable id, so re-opening an updated share merges instead of duplicating. */
  shareId: string;
  /** Sender's display name. */
  from?: string;
  name?: string;
  emoji?: string;
  color?: string;
  /** Library only. */
  collections?: SharedCollectionRef[];
  items: SharedItemV2[];
  /** Set on decoding when the share held more saves than can be added at once (only the first ones are kept). */
  total?: number;
}

export interface ShareOptions {
  from?: string;
  /** Include the sender's notes, ratings, reviews and done status. */
  includePersonal?: boolean;
}

const KINDS: ShareKind[] = ['item', 'collection', 'library'];
/** Most saves one share can carry (a library share sends the first ones — the newest, as the app lists them). */
export const MAX_SHARE_ITEMS = 2000;
const MAX_ITEMS = MAX_SHARE_ITEMS;
const MAX_COLLECTIONS = 200;
const NOT_A_SHARE = "That isn't a Magpie share.";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function compactPlace(p: Place | undefined): Place | undefined {
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return undefined;
  const out: Place = { lat: round6(p.lat), lng: round6(p.lng) };
  for (const k of ['address', 'name', 'city', 'country', 'countryCode'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

function compactItem(item: Item, opts: ShareOptions, keys?: string[]): SharedItemV2 {
  const s: SharedItemV2 = { t: item.type, n: item.title };
  // Links go without the sharer's tracking tokens (igsh, si, utm_*…), which could tie your friends back to you.
  if (item.url) s.u = stripTracking(item.url);
  else s.k = shortHash(item.id);
  // For a note the note *is* the content; otherwise it's personal.
  if (item.note && (opts.includePersonal || item.type === 'note')) s.d = item.note;
  if (item.description) s.ds = item.description;
  if (item.image) s.i = item.image;
  if (item.siteName) s.sn = item.siteName;
  if (item.tags.length) s.g = item.tags;
  const place = compactPlace(item.place);
  if (place) s.p = place;
  if (item.source) s.s = item.source;
  if (item.when?.start) s.w = item.when.end ? { start: item.when.start, end: item.when.end } : { start: item.when.start };
  if (item.sharedText) s.x = stripTrackingInText(item.sharedText);
  if (keys?.length) s.c = keys;
  if (opts.includePersonal) {
    if (item.status === 'done') s.st = 'done';
    if (item.rating) s.r = item.rating;
    if (item.review) s.rv = item.review;
  }
  return s;
}

const cleanFrom = (from: string | undefined) => clip(from?.trim(), 60);

/**
 * Text-note saves are your own words (door codes, gift ideas…): a whole-library share only carries them when you
 * include your notes. A note shared on purpose — on its own or in a collection you picked — always goes.
 */
function withoutPrivateNotes(items: Item[], opts: ShareOptions): Item[] {
  return opts.includePersonal ? items : items.filter((i) => i.type !== 'note');
}

export function shareItem(item: Item, opts: ShareOptions = {}): SharedPayloadV2 {
  const p: SharedPayloadV2 = { v: 2, kind: 'item', shareId: `i:${item.id}`, items: [compactItem(item, opts)] };
  const from = cleanFrom(opts.from);
  if (from) p.from = from;
  return p;
}

export function shareCollection(collection: Collection, items: Item[], opts: ShareOptions = {}): SharedPayloadV2 {
  const p: SharedPayloadV2 = {
    v: 2,
    kind: 'collection',
    shareId: `c:${collection.id}`,
    name: collection.name,
    emoji: collection.emoji,
    color: collection.color,
    items: items.map((i) => compactItem(i, opts)),
  };
  const from = cleanFrom(opts.from);
  if (from) p.from = from;
  return p;
}

function buildLibrary(items: Item[], collections: Collection[], opts: ShareOptions, shareId: string): SharedPayloadV2 {
  const keysByItem = new Map<string, string[]>();
  const refs: SharedCollectionRef[] = [];
  for (const c of collections) {
    if (refs.length >= MAX_COLLECTIONS) break;
    const members = itemsInCollection(items, c);
    if (!members.length) continue; // empty collections would just be clutter for your friend
    const key = refs.length.toString(36);
    refs.push({ key, name: c.name, emoji: c.emoji, color: c.color, id: shortHash(c.id) });
    for (const m of members) keysByItem.set(m.id, [...(keysByItem.get(m.id) ?? []), key]);
  }
  const p: SharedPayloadV2 = {
    v: 2,
    kind: 'library',
    shareId,
    items: items.map((i) => compactItem(i, opts, keysByItem.get(i.id))),
  };
  if (refs.length) p.collections = refs;
  const from = cleanFrom(opts.from);
  if (from) p.from = from;
  return p;
}

/**
 * Your whole library (or any selection of it) with the collections the items are in. Text notes stay out unless
 * `includePersonal`, and only the first MAX_SHARE_ITEMS saves go (pass them newest first).
 */
export function shareLibrary(items: Item[], collections: Collection[], opts: ShareOptions = {}): SharedPayloadV2 {
  return buildLibrary(withoutPrivateNotes(items, opts).slice(0, MAX_ITEMS), collections, opts, `l:${getDeviceId()}`);
}

// ---------------------------------------------------------------------------
// Per-device id (library share ids)

const DEVICE_KEY = 'magpie:device-id';
let memoryDeviceId: string | undefined;

function randomId(len = 12): string {
  const bytes = new Uint8Array(len);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/** A random id for this device, kept in localStorage (in memory when storage is unavailable). */
export function getDeviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    if (saved && /^[a-z0-9]{6,40}$/i.test(saved)) return saved;
    const id = memoryDeviceId ?? randomId();
    localStorage.setItem(DEVICE_KEY, id);
    memoryDeviceId = id;
    return id;
  } catch {
    return (memoryDeviceId ??= randomId());
  }
}

// ---------------------------------------------------------------------------
// Encoding

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Caps the output so a tiny crafted link can't inflate into hundreds of megabytes.
const MAX_DECODED_BYTES = 16 * 1024 * 1024;

async function inflate(bytes: Uint8Array, max = MAX_DECODED_BYTES): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error('That share is too big.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const canCompress = () => typeof CompressionStream !== 'undefined';

/** "z" prefix = deflate-compressed, "j" = plain JSON (fallback for old browsers). */
export async function encodeShare(data: SharedCollection | SharedPayloadV2): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (canCompress()) return `z${toBase64Url(await deflate(json))}`;
  return `j${toBase64Url(json)}`;
}

/** Decodes a v1 or v2 share payload (the part after "#/import/") into the normalised v2 shape. */
export async function decodeShare(payload: string): Promise<SharedPayloadV2> {
  const clean = /^[zj][A-Za-z0-9_-]+/.exec(payload.trim())?.[0];
  if (!clean) throw new Error('Unknown share format');
  let bytes = fromBase64Url(clean.slice(1));
  if (clean[0] === 'z') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to open Magpie links.');
    bytes = await inflate(bytes);
  } else if (bytes.byteLength > MAX_DECODED_BYTES) {
    throw new Error('That share is too big.');
  }
  return normalizePayload(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Alias of decodeShare, for readers who expect the name. */
export const decodeAny = decodeShare;

export function shareUrl(payload: string, base = location.href): string {
  const u = new URL(base);
  u.search = '';
  u.hash = `/import/${payload}`;
  return u.toString();
}

/** The address of the app itself (no route), e.g. to tell a friend where to get Magpie. */
export function appUrl(base = location.href): string {
  const u = new URL(base);
  u.search = '';
  u.hash = '';
  return u.toString();
}

// ---------------------------------------------------------------------------
// Validation / normalisation (structure only — transfer.ts sanitises values again on import)

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Trims to `max` code points without splitting emoji; undefined for empty / non-strings. */
function clip(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  return raw.length <= max ? raw : Array.from(raw).slice(0, max).join('');
}

function strList(raw: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map((s) => clip(s, maxLen)).filter((s): s is string => !!s).slice(0, maxItems);
  return out.length ? out : undefined;
}

const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" that is a real calendar date / time. */
export function isWhenString(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const m = WHEN_RE.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1000 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > days) return false;
  return m[4] === undefined || (Number(m[4]) <= 23 && Number(m[5]) <= 59);
}

/** Is `end` a valid end for `start`? Times are compared when both have one, otherwise just the days. */
export function isWhenEnd(start: string, end: unknown): end is string {
  if (!isWhenString(end)) return false;
  // Fixed-width ISO strings compare correctly as text.
  return start.length === 16 && end.length === 16 ? end > start : end.slice(0, 10) >= start.slice(0, 10);
}

function cleanWhen(raw: unknown): SharedItemV2['w'] {
  if (!isObj(raw) || !isWhenString(raw.start)) return undefined;
  return isWhenEnd(raw.start, raw.end) ? { start: raw.start, end: raw.end } : { start: raw.start };
}

function cleanPlace(raw: unknown): Place | undefined {
  if (!isObj(raw)) return undefined;
  const { lat, lng } = raw;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  const p: Place = { lat, lng };
  const address = clip(raw.address, 300);
  const name = clip(raw.name, 200);
  const city = clip(raw.city, 100);
  const country = clip(raw.country, 100);
  const cc = typeof raw.countryCode === 'string' ? raw.countryCode.trim().toUpperCase() : '';
  if (address) p.address = address;
  if (name) p.name = name;
  if (city) p.city = city;
  if (country) p.country = country;
  if (/^[A-Z]{2}$/.test(cc)) p.countryCode = cc;
  return p;
}

function cleanItem(raw: unknown, library: boolean): SharedItemV2 | undefined {
  if (!isObj(raw)) return undefined;
  const s: SharedItemV2 = {
    t: ITEM_TYPES.includes(raw.t as ItemType) ? (raw.t as ItemType) : 'link',
    n: clip(raw.n, 300) ?? 'Untitled',
  };
  const set = <K extends keyof SharedItemV2>(k: K, v: SharedItemV2[K] | undefined) => {
    if (v !== undefined) s[k] = v;
  };
  set('u', clip(raw.u, 2048));
  set('d', clip(raw.d, 5000));
  set('ds', clip(raw.ds, 2000));
  set('i', clip(raw.i, 2048));
  set('sn', clip(raw.sn, 100));
  set('g', strList(raw.g, 30, 60));
  set('p', cleanPlace(raw.p));
  if (typeof raw.s === 'string' && SOURCE_ID_RE.test(raw.s)) s.s = raw.s;
  set('w', cleanWhen(raw.w));
  set('x', clip(raw.x, 5000));
  if (typeof raw.k === 'string' && ITEM_KEY_RE.test(raw.k)) s.k = raw.k;
  if (library) set('c', strList(raw.c, 50, 24));
  if (typeof raw.r === 'number' && Number.isFinite(raw.r)) s.r = raw.r;
  set('rv', clip(raw.rv, 5000));
  if (raw.st === 'done' || raw.st === 'todo') s.st = raw.st;
  return s;
}

const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const SHARE_ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,24}$/;
/** A shortHash: save keys (SharedItemV2.k) and collection fingerprints (SharedCollectionRef.id). */
const ITEM_KEY_RE = /^[a-z0-9]{1,13}$/;

/** Short, stable, non-cryptographic hash (FNV-1a) — for ids of shares that don't carry one, save keys and collection fingerprints. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Validates any decoded share (v1 or v2, with or without a file wrapper) and returns the v2 shape. Throws if it isn't one. */
export function normalizePayload(raw: unknown): SharedPayloadV2 {
  if (!isObj(raw)) throw new Error(NOT_A_SHARE);
  if (raw.v === 1) {
    if (typeof raw.name !== 'string' || !Array.isArray(raw.items)) throw new Error(NOT_A_SHARE);
    const items = raw.items.slice(0, MAX_ITEMS).map((i) => cleanItem(i, false)).filter((i): i is SharedItemV2 => !!i);
    const p: SharedPayloadV2 = {
      v: 2,
      kind: 'collection',
      // v1 links carry no id: derive one from the content so opening the same link twice doesn't duplicate.
      shareId: `v1:${shortHash(JSON.stringify(raw))}`,
      name: clip(raw.name, 80) ?? 'Shared collection',
      items,
    };
    const emoji = clip(raw.emoji, 8);
    if (emoji) p.emoji = emoji;
    if (typeof raw.color === 'string' && COLOR_RE.test(raw.color)) p.color = raw.color;
    return p;
  }
  if (raw.v !== 2 || !KINDS.includes(raw.kind as ShareKind) || !Array.isArray(raw.items)) throw new Error(NOT_A_SHARE);
  const kind = raw.kind as ShareKind;
  const library = kind === 'library';
  const items = raw.items
    .slice(0, kind === 'item' ? 1 : MAX_ITEMS)
    .map((i) => cleanItem(i, library))
    .filter((i): i is SharedItemV2 => !!i);
  if (kind === 'item' && !items.length) throw new Error('That share is empty.');
  const p: SharedPayloadV2 = {
    v: 2,
    kind,
    shareId: typeof raw.shareId === 'string' && SHARE_ID_RE.test(raw.shareId) ? raw.shareId : `h:${shortHash(JSON.stringify(raw.items))}`,
    items,
  };
  if (kind !== 'item' && raw.items.length > MAX_ITEMS) p.total = raw.items.length;
  const from = clip(typeof raw.from === 'string' ? raw.from.trim() : undefined, 60);
  const name = clip(raw.name, 80);
  const emoji = clip(raw.emoji, 8);
  if (from) p.from = from;
  if (name) p.name = name;
  if (emoji) p.emoji = emoji;
  if (typeof raw.color === 'string' && COLOR_RE.test(raw.color)) p.color = raw.color;
  if (library && Array.isArray(raw.collections)) {
    const seen = new Set<string>();
    const refs: SharedCollectionRef[] = [];
    for (const c of raw.collections.slice(0, MAX_COLLECTIONS)) {
      if (!isObj(c) || typeof c.key !== 'string' || !KEY_RE.test(c.key) || seen.has(c.key)) continue;
      seen.add(c.key);
      const ref: SharedCollectionRef = {
        key: c.key,
        name: clip(c.name, 80) ?? 'Collection',
        emoji: clip(c.emoji, 8) ?? '📌',
        color: typeof c.color === 'string' && COLOR_RE.test(c.color) ? c.color : '',
      };
      if (typeof c.id === 'string' && ITEM_KEY_RE.test(c.id)) ref.id = c.id;
      refs.push(ref);
    }
    if (refs.length) p.collections = refs;
    // Drop references to collections that aren't in the share.
    for (const i of items) {
      if (!i.c) continue;
      i.c = i.c.filter((k) => seen.has(k));
      if (!i.c.length) delete i.c;
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// Link budget

/** Longest link we hand to other apps. Some chat apps and SMS cut longer ones. */
export const LINK_BUDGET = 2000;
const SLIM_TEXT = 280;

export interface SharePlan {
  url?: string;
  /** Images, descriptions and original posts were left out to make it fit. */
  slim: boolean;
  /** Even the slim link is too long — share a file instead. */
  tooLong: boolean;
  length: number;
  /** The payload the link carries (slimmed when `slim`). */
  data: SharedPayloadV2;
}

function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Drops images, descriptions and original posts, and shortens long notes / reviews. */
export function slimPayload(p: SharedPayloadV2): SharedPayloadV2 {
  return {
    ...p,
    items: p.items.map((s) => {
      const out = { ...s };
      delete out.i;
      delete out.ds;
      delete out.x;
      if (out.d) out.d = truncate(out.d, SLIM_TEXT);
      if (out.rv) out.rv = truncate(out.rv, SLIM_TEXT);
      return out;
    }),
  };
}

function defaultBase(): string {
  return typeof location !== 'undefined' ? location.href : 'https://magpie.invalid/';
}

/** Works out the link for a share: full if it fits, slim if that fits, otherwise tells you to send a file. */
export async function planShare(payload: SharedPayloadV2, base = defaultBase(), budget = LINK_BUDGET): Promise<SharePlan> {
  const full = shareUrl(await encodeShare(payload), base);
  if (full.length <= budget) return { url: full, slim: false, tooLong: false, length: full.length, data: payload };
  const slim = slimPayload(payload);
  const short = shareUrl(await encodeShare(slim), base);
  if (short.length <= budget) return { url: short, slim: true, tooLong: false, length: short.length, data: slim };
  return { slim: true, tooLong: true, length: short.length, data: slim };
}

// ---------------------------------------------------------------------------
// Files

export const SHARE_FILE_APP = 'magpie-share';

/** Human title for a share: the item's title, the collection's name, or "Sam's saves". */
export function payloadTitle(p: SharedPayloadV2): string {
  if (p.kind === 'item') return p.items[0]?.n ?? 'A save';
  if (p.name) return p.name;
  if (p.kind === 'library') return p.from ? `${p.from}'s saves` : 'Shared saves';
  return 'Shared collection';
}

export function payloadEmoji(p: SharedPayloadV2): string {
  if (p.kind === 'item') return TYPE_INFO[p.items[0]?.t ?? 'link']?.emoji ?? '🔗';
  if (p.emoji) return p.emoji;
  return p.kind === 'library' ? '📚' : '📌';
}

export function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return Array.from(slug).slice(0, 40).join('').replace(/-+$/, '') || 'magpie-share';
}

/**
 * The share as a file your friend opens with Magpie, at full fidelity.
 * `format: 'text'` gives a ".magpie.txt" copy for share sheets that refuse JSON files (Chrome on Android).
 */
export function toShareFile(payload: SharedPayloadV2, format: 'json' | 'text' = 'json'): File {
  const body = JSON.stringify({ app: SHARE_FILE_APP, ...payload }, null, 2);
  const slug = slugify(payloadTitle(payload));
  return format === 'text'
    ? new File([body], `${slug}.magpie.txt`, { type: 'text/plain' })
    : new File([body], `${slug}.magpie.json`, { type: 'application/json' });
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Coerces an untrusted backup item into an Item (types only — values are sanitised on import). */
function coerceItem(raw: unknown, index: number): Item | undefined {
  if (!isObj(raw)) return undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const when = isObj(raw.when) && typeof raw.when.start === 'string' ? { start: raw.when.start, end: str(raw.when.end) } : undefined;
  return {
    // Collection membership is worked out per id, so items without one each get their own.
    id: str(raw.id) ?? `#${index}`,
    type: ITEM_TYPES.includes(raw.type as ItemType) ? (raw.type as ItemType) : 'link',
    title: str(raw.title) ?? 'Untitled',
    url: str(raw.url),
    note: str(raw.note),
    description: str(raw.description),
    image: str(raw.image),
    siteName: str(raw.siteName),
    source: str(raw.source),
    tags: list(raw.tags),
    collectionIds: list(raw.collectionIds),
    status: raw.status === 'done' ? 'done' : 'todo',
    rating: typeof raw.rating === 'number' && Number.isFinite(raw.rating) ? raw.rating : undefined,
    review: str(raw.review),
    place: isObj(raw.place) ? (raw.place as unknown as Place) : undefined,
    when,
    sharedText: str(raw.sharedText),
    createdAt: 0,
    updatedAt: 0,
  };
}

function coerceCollection(raw: unknown): Collection | undefined {
  if (!isObj(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') return undefined;
  const r = isObj(raw.rules) ? raw.rules : undefined;
  const rules: SmartRules | undefined = r
    ? {
        tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
        match: r.match === 'all' ? 'all' : 'any',
        types: Array.isArray(r.types) ? r.types.filter((t): t is ItemType => ITEM_TYPES.includes(t as ItemType)) : [],
        status: r.status === 'todo' || r.status === 'done' ? r.status : 'any',
      }
    : undefined;
  return {
    id: raw.id,
    name: raw.name,
    emoji: typeof raw.emoji === 'string' ? raw.emoji : '📌',
    color: typeof raw.color === 'string' ? raw.color : '',
    kind: raw.kind === 'smart' ? 'smart' : 'manual',
    rules,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** A full Magpie backup ({ app: 'magpie', … }) as a library share. */
export function backupToPayload(raw: unknown): SharedPayloadV2 {
  if (!isObj(raw) || raw.app !== 'magpie' || !Array.isArray(raw.items)) throw new Error(NOT_A_SHARE);
  const items = raw.items
    .slice(0, MAX_ITEMS)
    .map((r, i) => coerceItem(r, i))
    .filter((i): i is Item => !!i);
  const collections = Array.isArray(raw.collections)
    ? raw.collections.map(coerceCollection).filter((c): c is Collection => !!c)
    : [];
  // Same backup file → same id, so opening it twice merges.
  const id = `b:${shortHash(`${String(raw.exportedAt ?? '')}|${items.length}|${items.map((i) => i.id).join(',')}`)}`;
  return normalizePayload(buildLibrary(items, collections, { includePersonal: true }, id));
}

/** Reads a shared file: a ".magpie.json" share, a full backup, or text containing a Magpie link. */
export async function readShareFile(file: File | Blob): Promise<SharedPayloadV2> {
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is too big to be a Magpie share.');
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    json = undefined;
  }
  if (isObj(json)) {
    if (json.app === SHARE_FILE_APP || json.v === 1 || json.v === 2) return normalizePayload(json);
    if (json.app === 'magpie') return backupToPayload(json);
  }
  const payload = findSharePayload(text);
  if (payload) return decodeShare(payload);
  throw new Error("That file isn't a Magpie share.");
}

// ---------------------------------------------------------------------------
// Pasted links

/**
 * The encoded payload from a pasted Magpie link or a message containing one ("…#/import/<payload>").
 * A bare payload is accepted too (for an explicit "Import from link" field); pass `{ bare: false }`
 * when checking text shared from other apps, so a lone word isn't mistaken for a share.
 */
export function parseShareInput(text: string | null | undefined, opts: { bare?: boolean } = {}): string | undefined {
  return findSharePayload(text, opts.bare ?? true);
}

/** parseShareInput + decodeShare. Throws a friendly error when there's no Magpie link in the text. */
export async function decodeShareInput(text: string): Promise<SharedPayloadV2> {
  const payload = parseShareInput(text);
  if (!payload) throw new Error("That doesn't look like a Magpie link.");
  return decodeShare(payload);
}
