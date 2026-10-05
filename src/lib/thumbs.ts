import { useCallback, useSyncExternalStore } from 'react';
import { safeUrl } from './classify';
import { db, onItemsDeleted, THUMB_GRACE_MS, type ThumbRow } from './db';
import { isTimeout, withTimeout } from './dbHealth';
import { getSettings } from './settings';
import type { Item } from './types';
import { whenIdle } from './warmup';

/**
 * Small copies of saves' pictures, kept on this device. Image links from Instagram, Facebook or TikTok are signed
 * and stop working after a few days, and nothing works offline without a copy. Each save gets one copy (a few
 * dozen KB) in IndexedDB, made from its image when the image server allows it (CORS). When it doesn't, a signed
 * image is loaded once so the service worker's thumbnail cache has it before the link expires.
 *
 * Saves whose picture fails to load with no copy here are listed by brokenImageIds(), so a fresh preview can be
 * fetched for them.
 */

/** Copies are at most this many px on their longer side and this many on their shorter one. */
const MAX_LONG = 600;
const MAX_SHORT = 400;
/** A copy bigger than this is encoded again at a lower quality. */
const MAX_BYTES = 60_000;
/** Images this small (and no bigger than a copy would be) are kept as they are. */
const KEEP_AS_IS_BYTES = 60_000;
/** Images bigger than this aren't downloaded for a copy. */
const MAX_SOURCE_BYTES = 8_000_000;
/** Copies kept at most; the oldest go first. */
export const MAX_THUMBS = 2000;
const FETCH_TIMEOUT_MS = 10_000;
const WARM_TIMEOUT_MS = 15_000;
/** A whole attempt at a copy (so a stuck one can't hold up the others). */
const KEEP_TIMEOUT_MS = 40_000;
/** Looking up a copy can't hold up a picture longer than this. */
const LOOKUP_TIMEOUT_MS = 2000;
/** Copies looked up at a time (about a phone screenful), so the first ones come back sooner. */
const LOOKUP_BATCH = 8;
/** Unused object URLs are let go after this long (so going back to a list doesn't flash). */
const RELEASE_MS = 20_000;
/** The background pass over saves without a copy starts this long after the first thumbnail shows. */
const SWEEP_DELAY_MS = 6000;
/** Downloads per background pass. */
const SWEEP_LIMIT = 60;
/** Images loaded just for the service worker's cache per pass: well under what it keeps (200, src/sw.ts). */
const WARM_LIMIT = 30;
/** The service worker's cache of thumbnails (src/sw.ts). */
const THUMB_CACHE = 'thumbnails';
const BROKEN_KEY = 'magpie:broken-images';
const MAX_BROKEN = 200;
const WARMED_KEY = 'magpie:warmed-thumbs';
const MAX_WARMED = 300;

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const isHttp = (src: string) => /^https?:/i.test(src);

// ---------------------------------------------------------------------------
// Signed links

const FB_CDN = /(?:^|\.)(?:cdninstagram\.com|fbcdn\.net)$/i;
const TIKTOK_CDN = /(?:^|\.)tiktokcdn(?:-[a-z]+)?\.com$/i;

/** When a signed image link stops working (Instagram / Facebook `oe=`, TikTok `x-expires=`), in ms. */
export function thumbExpiresAt(url: string | undefined): number | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (FB_CDN.test(u.hostname)) {
    const oe = u.searchParams.get('oe');
    return oe && /^[0-9a-f]{8}$/i.test(oe) ? parseInt(oe, 16) * 1000 : undefined;
  }
  if (TIKTOK_CDN.test(u.hostname)) {
    const x = u.searchParams.get('x-expires');
    return x && /^\d{9,11}$/.test(x) ? Number(x) * 1000 : undefined;
  }
  return undefined;
}

const isExpired = (src: string) => (thumbExpiresAt(src) ?? Infinity) <= Date.now();

/** "scontent-hkg4-1.cdninstagram.com" → "cdninstagram.com" (two labels, three for "com.hk"-style endings). */
function siteOf(src: string): string {
  try {
    const parts = new URL(src).hostname.split('.');
    const n = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 ? 3 : 2;
    return parts.slice(-n).join('.');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Broken pictures

let broken: string[] | undefined;
const brokenListeners = new Set<() => void>();

function brokenList(): string[] {
  if (!broken) {
    try {
      const raw = JSON.parse(localStorage.getItem(BROKEN_KEY) ?? '[]') as unknown;
      broken = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string').slice(-MAX_BROKEN) : [];
    } catch {
      broken = [];
    }
  }
  return broken;
}

function saveBroken(list: string[]): void {
  broken = list;
  try {
    localStorage.setItem(BROKEN_KEY, JSON.stringify(list));
  } catch {
    /* private mode: this session's memory is enough */
  }
}

/** Saves whose picture failed to load with no copy on this device, most recent first. May name deleted saves. */
export function brokenImageIds(): string[] {
  return brokenList().slice().reverse();
}

/** Takes a save off brokenImageIds() (it has a new picture, or a copy). */
export function clearBrokenImage(id: string): void {
  const list = brokenList();
  if (list.includes(id)) saveBroken(list.filter((b) => b !== id));
}

/** Called when a save is added to brokenImageIds(). Returns an unsubscribe function. */
export function onBrokenImage(listener: () => void): () => void {
  brokenListeners.add(listener);
  return () => brokenListeners.delete(listener);
}

function markBroken(id: string): void {
  // Offline isn't broken.
  if (offline()) return;
  const list = brokenList().filter((b) => b !== id);
  list.push(id);
  saveBroken(list.slice(-MAX_BROKEN));
  brokenListeners.forEach((l) => l());
}

async function hasCopy(id: string): Promise<boolean> {
  const e = entries.get(id);
  if (e && e.row !== undefined && !e.tentative) return !!e.row;
  try {
    return (await db.thumbs.where('id').equals(id).count()) > 0;
  } catch {
    return false;
  }
}

async function markBrokenUnlessCopy(id: string): Promise<void> {
  if (!(await hasCopy(id))) markBroken(id);
}

// ---------------------------------------------------------------------------
// What's shown: one entry per save on screen, sharing one object URL per copy

interface Entry {
  refs: number;
  /** The copy on this device: undefined until looked up, null when there's none. */
  row?: ThumbRow | null;
  /** Object URL of row.blob, made when first shown. */
  url?: string;
  /** Remote images that didn't load this session. */
  failed: Set<string>;
  /** The remote image that loaded this session: kept on screen rather than swapped for a fresh copy of it. */
  shown?: string;
  /** A remote image failed before the lookup finished: list the save as broken if there's no copy. */
  checkBroken?: boolean;
  /** The lookup took too long: shown as if there's no copy until it answers. */
  tentative?: boolean;
  listeners: Set<() => void>;
  /** When the last component showing it went away. */
  idleSince?: number;
}

const entries = new Map<string, Entry>();
/** While the copy is being looked up. */
const WAIT = '\0';

function notify(e: Entry): void {
  e.listeners.forEach((l) => l());
}

function setRow(e: Entry, row: ThumbRow | null): void {
  e.tentative = false;
  if (e.row === row) return;
  if (e.url) URL.revokeObjectURL(e.url);
  e.url = undefined;
  e.row = row;
  notify(e);
}

function localUrl(e: Entry): string {
  e.url ??= URL.createObjectURL(e.row!.blob);
  return e.url;
}

/** The best source for a save's picture: its copy, else the link, else an older copy, else nothing (''). */
function pick(e: Entry | undefined, remote: string | undefined): string {
  if (!remote) return '';
  if (!e || e.row === undefined) return WAIT;
  const { row } = e;
  if (row && row.src === remote && e.shown !== remote) return localUrl(e);
  if (!e.failed.has(remote)) return remote;
  // The link doesn't work any more, but there's a copy of the save's earlier picture.
  return row ? localUrl(e) : '';
}

// Copies are looked up in batches, in the order cards render (the first ones are on screen).
const toLoad = new Set<string>();
/** Being looked up (queued or under way). */
const looking = new Set<string>();
let loadQueued = false;
let flushing: Promise<void> | undefined;

function load(id: string): void {
  if (looking.has(id)) return;
  looking.add(id);
  toLoad.add(id);
  // A lookup under way takes it next.
  if (loadQueued || flushing) return;
  loadQueued = true;
  queueMicrotask(() => void flushLoads());
}

/** Looks up everything queued, a batch at a time. Resolves once all of it is known (or taking too long). */
function flushLoads(): Promise<void> {
  loadQueued = false;
  flushing ??= (async () => {
    try {
      while (toLoad.size) {
        const ids = [...toLoad].slice(0, LOOKUP_BATCH);
        ids.forEach((id) => toLoad.delete(id));
        await lookUpBatch(ids);
      }
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}

async function lookUpBatch(ids: string[]): Promise<void> {
  const lookup = db.thumbs.bulkGet(ids);
  const done = () => ids.forEach((id) => looking.delete(id));
  lookup.then(done, done);
  try {
    found(ids, await withTimeout(lookup, LOOKUP_TIMEOUT_MS, 'Thumbnail lookup'));
  } catch {
    // Slow or failing storage: show the links meanwhile, and the copies if it answers after all.
    found(ids, undefined);
    lookup.then((rows) => found(ids, rows), noop);
  }
}

function found(ids: string[], rows: (ThumbRow | undefined)[] | undefined): void {
  ids.forEach((id, i) => {
    const e = entries.get(id);
    // Already known (a copy was just made), or released meanwhile.
    if (!e || (e.row !== undefined && !e.tentative)) return;
    const row = rows?.[i]?.blob ? rows[i]! : null;
    if (!rows) {
      if (e.row === undefined) setRow(e, null);
      e.tentative = true;
      return;
    }
    if (e.checkBroken && !row) markBroken(id);
    e.checkBroken = false;
    setRow(e, row);
  });
}

let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRelease(): void {
  releaseTimer ??= setTimeout(release, RELEASE_MS);
}

function release(): void {
  releaseTimer = undefined;
  const now = Date.now();
  let left = false;
  for (const [id, e] of entries) {
    if (e.refs > 0 || e.idleSince === undefined) continue;
    if (now - e.idleSince < RELEASE_MS) {
      left = true;
      continue;
    }
    if (e.url) URL.revokeObjectURL(e.url);
    entries.delete(id);
  }
  if (left) scheduleRelease();
}

function entryFor(id: string): Entry {
  let e = entries.get(id);
  if (!e) {
    e = { refs: 0, failed: new Set(), listeners: new Set() };
    entries.set(id, e);
  }
  return e;
}

function watch(id: string, listener: () => void): () => void {
  const e = entryFor(id);
  e.listeners.add(listener);
  e.refs++;
  e.idleSince = undefined;
  if (e.row === undefined) load(id);
  scheduleSweep();
  return () => {
    e.listeners.delete(listener);
    if (--e.refs > 0) return;
    e.refs = 0;
    e.idleSince = Date.now();
    scheduleRelease();
  };
}

const noop = () => {};

/** Starts looking up a save's copy unless it's known or on its way. Kept a while even if nothing shows it. */
function lookUp(id: string): void {
  const e = entryFor(id);
  if (!e.refs) {
    // Not let go (and its object URL revoked) just as it's about to be shown.
    e.idleSince = Date.now();
    scheduleRelease();
  }
  if (e.row === undefined) load(id);
}

/** Looks up the copies of these saves now (e.g. before showing them), so they appear without a wait. */
export async function preloadThumbs(ids: string[]): Promise<void> {
  ids.forEach(lookUp);
  await flushLoads();
}

export interface ThumbView {
  /** What to show; undefined when there's nothing (show the fallback tile) or while waiting. */
  src?: string;
  /** The save's own image link (safe to show), whatever `src` is. */
  link?: string;
  /** True for a moment while the copy on this device is looked up: show an empty tile, not the fallback. */
  waiting: boolean;
}

/** React hook: a save's picture (its copy on this device first), or whether it's still being looked up. */
export function useThumb(item: Pick<Item, 'id' | 'image'>): ThumbView {
  const { id } = item;
  const remote = safeUrl(item.image);
  const shown = !!remote;
  // Looked up as the card renders rather than once it's on screen: the copy comes sooner.
  if (shown) lookUp(id);
  const subscribe = useCallback((listener: () => void) => (shown ? watch(id, listener) : noop), [id, shown]);
  const snapshot = () => pick(entries.get(id), remote);
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return s === WAIT ? { link: remote, waiting: true } : { src: s || undefined, link: remote, waiting: false };
}

/** React hook: the best source to show for a save's picture (the link itself while its copy is looked up). */
export function useThumbSrc(item: Pick<Item, 'id' | 'image'>): string | undefined {
  const view = useThumb(item);
  return view.waiting ? view.link : view.src;
}

/** An <img> showing `src` failed to load: shows the next best source, and lists the save if there's none. */
export function thumbFailed(id: string, src: string): void {
  const e = entries.get(id);
  if (!isHttp(src)) {
    // The copy itself didn't load: the link for the rest of this session.
    if (e?.url === src) setRow(e, null);
    return;
  }
  if (e) {
    if (e.failed.has(src)) return;
    e.failed.add(src);
    notify(e);
    if (e.row === undefined) {
      e.checkBroken = true;
      return;
    }
  }
  void markBrokenUnlessCopy(id);
}

/** An <img> showing `src` loaded: the save isn't broken, and a link without a copy gets one (in the background). */
export function thumbShown(id: string, src: string): void {
  if (!isHttp(src)) return;
  clearBrokenImage(id);
  const e = entries.get(id);
  if (e) e.shown = src;
  const key = `${id}\n${src}`;
  if (e?.row?.src === src || !getSettings().previews || tried.has(key)) return;
  tried.add(key);
  whenIdle(() => void keepNow(id, src), { timeout: 5000 });
}

// Back online: links that failed get another try.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    for (const e of entries.values()) {
      if (!e.failed.size) continue;
      e.failed.clear();
      notify(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Making copies

type KeepResult =
  /** A copy was stored. */
  | 'kept'
  /** There already is one. */
  | 'had'
  /** No copy possible, but the service worker has the image. */
  | 'cached'
  /** No copy possible: loaded so the service worker caches it. */
  | 'warmed'
  /** No copy possible, and none needed: the link doesn't expire, and showing it caches it. */
  | 'skipped'
  /** The link has expired; nothing to download. */
  | 'expired'
  /** The image is gone (403 / 404…). */
  | 'broken'
  | 'timeout'
  /** Anything else (offline, not an image, storage full, the save changed or went). */
  | 'failed';

class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Sites whose image servers didn't allow a copy this session. */
const noCors = new Set<string>();
/** "id\nsrc" pairs already tried this session (the background pass and keep-on-show don't try again). */
const tried = new Set<string>();
const inFlight = new Map<string, Promise<KeepResult>>();

// Two downloads at a time.
const MAX_PARALLEL = 2;
let active = 0;
const queue: (() => void)[] = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_PARALLEL) await new Promise<void>((resolve) => queue.push(resolve));
  active++;
  try {
    return await work();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/**
 * Stores a small copy of a save's picture on this device, replacing an older one. Where the image server doesn't
 * allow that, makes sure the service worker caches the image instead. Never rejects.
 */
export function keepThumb(itemId: string, url: string): Promise<void> {
  return keepNow(itemId, url).then(noop, noop);
}

function keepNow(id: string, url: string): Promise<KeepResult> {
  const src = safeUrl(url);
  if (!id || !src) return Promise.resolve('failed');
  const key = `${id}\n${src}`;
  tried.add(key);
  let p = inFlight.get(key);
  if (!p) {
    p = inTurn(() => withTimeout(keep(id, src), KEEP_TIMEOUT_MS, 'Keeping a thumbnail'))
      .catch((e: unknown): KeepResult => (isTimeout(e) ? 'timeout' : 'failed'))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
  return p;
}

async function keep(id: string, src: string): Promise<KeepResult> {
  if ((await db.thumbs.where('[id+src]').equals([id, src]).count()) > 0) return 'had';
  // Gone, or showing another picture by now.
  const item = await db.items.get(id);
  if (!item || safeUrl(item.image) !== src || offline()) return 'failed';
  if (isExpired(src)) {
    // Nothing will show it unless the service worker cached it while it worked.
    if (!(await inSwCache(src))) await markBrokenUnlessCopy(id);
    return 'expired';
  }
  const site = siteOf(src);
  if (!noCors.has(site)) {
    try {
      const small = await shrink(await download(src));
      if (!small) return 'failed';
      return (await store(id, src, small)) ? 'kept' : 'failed';
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 0;
      if (status === 403 || status === 404 || status === 410) {
        await markBrokenUnlessCopy(id);
        return 'broken';
      }
      if (status) return 'failed';
      if ((e as Error | null)?.name === 'AbortError') return 'timeout';
      // A TypeError: no CORS on that server (or the network failed). Either way, not asked again this session.
      if ((e as Error | null)?.name !== 'TypeError') return 'failed';
      noCors.add(site);
    }
  }
  if (await inSwCache(src)) return 'cached';
  // Only a signed link needs loading ahead, before it expires. And only once: had the service worker let it go
  // since, loading it again on every launch would only push other pictures out of its cache.
  const expires = thumbExpiresAt(src);
  if (!expires) return 'skipped';
  if (wasWarmed(src)) return 'cached';
  const loaded = await warm(src);
  if (loaded === 'ok') {
    noteWarmed(src, expires);
    return 'warmed';
  }
  if (loaded === 'error') await markBrokenUnlessCopy(id);
  return loaded === 'timeout' ? 'timeout' : 'broken';
}

async function download(src: string): Promise<Blob> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(src, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // An expiring link is best taken from the cache, even a stale one.
      cache: 'force-cache',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new HttpError(res.status);
    const type = res.headers.get('content-type') ?? '';
    // A login page or an error instead of the image.
    if (type && !/^image\/|^application\/octet-stream/i.test(type)) throw new HttpError(415);
    if (Number(res.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new HttpError(413);
    const blob = await res.blob();
    if (blob.size > MAX_SOURCE_BYTES || blob.size === 0) throw new HttpError(413);
    return blob;
  } finally {
    clearTimeout(timer);
  }
}

// Signed links loaded for the service worker on this device (by a short hash), until they expire.
let warmed: Record<string, number> | undefined;

function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}

function warmedList(): Record<string, number> {
  if (!warmed) {
    try {
      const raw = JSON.parse(localStorage.getItem(WARMED_KEY) ?? '{}') as unknown;
      warmed = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
    } catch {
      warmed = {};
    }
  }
  return warmed;
}

function wasWarmed(src: string): boolean {
  const at = warmedList()[hashOf(src)];
  return typeof at === 'number' && at > Date.now();
}

function noteWarmed(src: string, expires: number): void {
  const now = Date.now();
  const kept = Object.entries(warmedList()).filter(([, at]) => typeof at === 'number' && at > now);
  kept.push([hashOf(src), expires]);
  warmed = Object.fromEntries(kept.slice(-MAX_WARMED));
  try {
    localStorage.setItem(WARMED_KEY, JSON.stringify(warmed));
  } catch {
    /* private mode: this session's memory is enough */
  }
}

/** Loads an image the way an <img> does (so the service worker caches it). */
function warm(src: string): Promise<'ok' | 'error' | 'timeout'> {
  if (typeof Image !== 'function') return Promise.resolve('timeout');
  return new Promise((resolve) => {
    const img = new Image();
    const done = (r: 'ok' | 'error' | 'timeout') => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(r);
    };
    const timer = setTimeout(() => done('timeout'), WARM_TIMEOUT_MS);
    img.onload = () => done('ok');
    img.onerror = () => done('error');
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';
    img.src = src;
  });
}

async function inSwCache(src: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;
  try {
    return !!(await caches.match(src, { cacheName: THUMB_CACHE, ignoreVary: true }));
  } catch {
    return false;
  }
}

interface Canvas2D {
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  encode(type: string, quality: number): Promise<Blob | undefined>;
}

function canvas(w: number, h: number): Canvas2D | undefined {
  if (typeof OffscreenCanvas === 'function') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    return ctx ? { ctx, encode: (type, quality) => c.convertToBlob({ type, quality }).catch(() => undefined) } : undefined;
  }
  if (typeof document === 'undefined') return undefined;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  return ctx ? { ctx, encode: (type, quality) => new Promise((resolve) => c.toBlob((b) => resolve(b ?? undefined), type, quality)) } : undefined;
}

const KEEPABLE = /^image\/(?:jpeg|webp|png|gif|avif)$/i;

/** A copy at most MAX_LONG × MAX_SHORT px, as WebP (JPEG where the browser can't make WebP). */
async function shrink(blob: Blob): Promise<Blob | undefined> {
  const asIs = blob.size <= KEEP_AS_IS_BYTES && KEEPABLE.test(blob.type) ? blob : undefined;
  if (typeof createImageBitmap !== 'function') return asIs;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // Not an image this browser can show.
    return undefined;
  }
  try {
    const { width, height } = bmp;
    if (!width || !height) return undefined;
    const scale = Math.min(1, MAX_LONG / Math.max(width, height), MAX_SHORT / Math.min(width, height));
    if (scale === 1 && asIs) return asIs;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const c = canvas(w, h);
    if (!c) return asIs;
    c.ctx.imageSmoothingQuality = 'high';
    c.ctx.drawImage(bmp, 0, 0, w, h);
    let out = await c.encode('image/webp', 0.72);
    if (out?.type !== 'image/webp') {
      // No WebP encoder (Safari gives PNG instead): JPEG, on white rather than black where it's see-through.
      c.ctx.globalCompositeOperation = 'destination-over';
      c.ctx.fillStyle = '#fff';
      c.ctx.fillRect(0, 0, w, h);
      out = await c.encode('image/jpeg', 0.76);
    }
    if (out && out.size > MAX_BYTES) out = (await c.encode(out.type, 0.5)) ?? out;
    return out && KEEPABLE.test(out.type) ? out : asIs;
  } finally {
    bmp.close();
  }
}

let room: { at: number; ok: boolean } | undefined;

/** Whether there's comfortably room for `bytes` more (checked every half minute). */
async function hasRoom(bytes: number): Promise<boolean> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage?.estimate) return true;
  if (!room || Date.now() - room.at > 30_000) {
    try {
      const { usage = 0, quota = 0 } = await storage.estimate();
      room = { at: Date.now(), ok: !quota || usage + bytes < quota * 0.8 };
    } catch {
      room = { at: Date.now(), ok: true };
    }
  }
  return room.ok;
}

/** Stores a copy if the save still shows this image. Never touches the save itself. */
async function store(id: string, src: string, blob: Blob): Promise<boolean> {
  const item = await db.items.get(id);
  if (!item || safeUrl(item.image) !== src) return false;
  if (!(await hasRoom(blob.size))) return false;
  const row: ThumbRow = { id, src, blob, at: Date.now() };
  try {
    await db.thumbs.put(row);
  } catch (e) {
    if ((e as Error | null)?.name === 'QuotaExceededError') room = { at: Date.now(), ok: false };
    throw e;
  }
  const e = entries.get(id);
  if (e) {
    e.checkBroken = false;
    setRow(e, row);
  }
  clearBrokenImage(id);
  await pruneThumbs().catch(noop);
  return true;
}

/** Drops the oldest copies beyond `max`. Resolves to how many went. */
export async function pruneThumbs(max = MAX_THUMBS): Promise<number> {
  const n = await db.thumbs.count();
  if (n <= max) return 0;
  const old = await db.thumbs.orderBy('at').limit(n - max).primaryKeys();
  await db.thumbs.bulkDelete(old);
  forgetCopies(old);
  return old.length;
}

function forgetCopies(ids: string[]): void {
  for (const id of ids) {
    const e = entries.get(id);
    if (e?.row) setRow(e, null);
  }
}

/** Forgets deleted saves: their copies in memory and their broken listings. */
function forgetSaves(ids: string[]): void {
  forgetCopies(ids);
  const gone = new Set(ids);
  const list = brokenList();
  if (list.some((b) => gone.has(b))) saveBroken(list.filter((b) => !gone.has(b)));
}

/** Deletes these saves' copies. Never rejects. */
export async function deleteThumbs(ids: string[]): Promise<void> {
  if (!ids.length) return;
  forgetSaves(ids);
  try {
    await db.thumbs.bulkDelete(ids);
  } catch {
    /* storage trouble: the next pass tidies up */
  }
}

// Deleted saves (db.ts drops their copies) leave nothing behind here either.
onItemsDeleted((ids) => {
  if (ids !== 'all') return forgetSaves(ids);
  forgetCopies([...entries.keys()]);
  saveBroken([]);
});

// ---------------------------------------------------------------------------
// The background pass

let sweeping: Promise<number> | undefined;
let sweepScheduled = false;

function scheduleSweep(): void {
  if (sweepScheduled || typeof window === 'undefined') return;
  sweepScheduled = true;
  setTimeout(() => whenIdle(() => void keepMissingThumbs(), { timeout: 10_000 }), SWEEP_DELAY_MS);
}

const nextIdle = () => new Promise<void>((resolve) => whenIdle(() => resolve(), { timeout: 2000 }));

/**
 * Makes copies for saves that have a picture but no copy yet, those whose links expire soonest first, up to
 * `limit` downloads. Also tidies up copies of deleted saves. Does nothing while offline or with link previews
 * off. A second call while one runs gets the same run. Resolves to the number of copies made.
 */
export function keepMissingThumbs({ limit = SWEEP_LIMIT }: { limit?: number } = {}): Promise<number> {
  if (sweeping) return sweeping;
  const run: Promise<number> = sweep(limit)
    .catch(() => 0)
    .finally(() => {
      if (sweeping === run) sweeping = undefined;
    });
  sweeping = run;
  return run;
}

async function sweep(limit: number): Promise<number> {
  if (!getSettings().previews || offline()) return 0;
  const [items, keys] = await Promise.all([db.items.toArray(), db.thumbs.orderBy('[id+src]').keys()]);
  const kept = new Map((keys as unknown as [string, string][]).map(([id, src]) => [id, src]));
  const ids = new Set(items.map((i) => i.id));
  const orphans = [...kept.keys()].filter((id) => !ids.has(id));
  // After the "Undo" window of a save deleted just now.
  if (orphans.length) setTimeout(() => void dropOrphans(orphans), THUMB_GRACE_MS);
  const list = brokenList();
  if (list.some((b) => !ids.has(b))) saveBroken(list.filter((b) => ids.has(b)));

  const due = items
    .flatMap((i) => {
      const src = safeUrl(i.image);
      return src && kept.get(i.id) !== src && !tried.has(`${i.id}\n${src}`)
        ? [{ id: i.id, src, expires: thumbExpiresAt(src) ?? Infinity, at: i.createdAt }]
        : [];
    })
    .sort((a, b) => a.expires - b.expires || b.at - a.at);

  let made = 0;
  let downloads = 0;
  let warms = 0;
  let timeouts = 0;
  for (const { id, src } of due) {
    if (downloads >= limit || warms >= WARM_LIMIT || timeouts >= 3 || offline() || !getSettings().previews) break;
    await nextIdle();
    const r = await keepNow(id, src);
    if (r === 'kept') made++;
    if (r === 'warmed') warms++;
    if (r === 'kept' || r === 'warmed' || r === 'broken' || r === 'failed' || r === 'timeout') downloads++;
    timeouts = r === 'timeout' ? timeouts + 1 : 0;
  }
  return made;
}

/** Deletes the copies of saves that are (still) gone. */
async function dropOrphans(ids: string[]): Promise<void> {
  try {
    const items = await db.items.bulkGet(ids);
    await deleteThumbs(ids.filter((_, i) => !items[i]));
  } catch {
    /* next time */
  }
}

/** Forgets this session's state. For tests. */
export function resetThumbsState(): void {
  for (const e of entries.values()) if (e.url) URL.revokeObjectURL(e.url);
  entries.clear();
  toLoad.clear();
  looking.clear();
  loadQueued = false;
  flushing = undefined;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = undefined;
  noCors.clear();
  tried.clear();
  inFlight.clear();
  broken = undefined;
  warmed = undefined;
  room = undefined;
  sweeping = undefined;
}
