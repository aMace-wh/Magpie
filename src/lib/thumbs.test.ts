import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeUrl } from './classify';
import { addItem, clearAll, db, deleteItem, THUMB_GRACE_MS, updateItem } from './db';
import { setSettings } from './settings';
import {
  brokenImageIds,
  clearBrokenImage,
  deleteThumbs,
  keepMissingThumbs,
  keepThumb,
  onBrokenImage,
  preloadThumbs,
  pruneThumbs,
  resetThumbsState,
  thumbExpiresAt,
  thumbFailed,
  thumbShown,
  useThumb,
  useThumbSrc,
} from './thumbs';
import { exportBackup } from './transfer';
import type { Item } from './types';

// Synthetic links in the shapes the CDNs use.
const hex = (ms: number) => Math.floor(ms / 1000).toString(16).toUpperCase();
const LATER = Date.UTC(2030, 0, 1);
const igImage = (n: number, expires = LATER) =>
  `https://scontent-abc1-1.cdninstagram.com/v/t51.2885-15/${n}_n.jpg?stp=dst-jpg_e35&_nc_ht=scontent-abc1-1.cdninstagram.com&oe=${hex(expires)}&oh=00_AbCd${n}`;
const plainImage = (n: number) => `https://img.example.com/covers/${n}.jpg`;

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}

// Image decoding and encoding, as the browser would.
let bitmap = { width: 1080, height: 1920 };
let webp = true;
/** Bytes an encode makes at quality 1. */
let encodedBytes = 50_000;
const canvases: { width: number; height: number }[] = [];

class FakeCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    canvases.push({ width, height });
  }
  getContext() {
    return { drawImage() {}, fillRect() {}, fillStyle: '', globalCompositeOperation: '', imageSmoothingQuality: '' };
  }
  convertToBlob({ type, quality }: { type: string; quality: number }) {
    const out = type === 'image/webp' && !webp ? 'image/png' : type;
    return Promise.resolve(new Blob([new Uint8Array(Math.round(encodedBytes * quality))], { type: out }));
  }
}

// Loading through an <img> (what makes the service worker cache it).
const loaded: { src: string; referrerPolicy: string }[] = [];
let imageLoads = true;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  referrerPolicy = '';
  decoding = '';
  set src(v: string) {
    loaded.push({ src: v, referrerPolicy: this.referrerPolicy });
    setTimeout(() => (imageLoads ? this.onload?.() : this.onerror?.()), 0);
  }
}

const jpeg = (bytes: number) => new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jpeg(250_000));
const bitmapMock = vi.fn(async (_blob: Blob) => ({ ...bitmap, close: vi.fn() }));

beforeEach(async () => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', bitmapMock);
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('Image', FakeImage);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jpeg(250_000));
  bitmapMock.mockClear();
  bitmap = { width: 1080, height: 1920 };
  webp = true;
  encodedBytes = 50_000;
  imageLoads = true;
  canvases.length = 0;
  loaded.length = 0;
  await Promise.all([db.items.clear(), db.collections.clear(), db.thumbs.clear()]);
  resetThumbsState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const save = (image?: string) => addItem({ title: 'A reel', type: 'video', image });

describe('keepThumb', () => {
  it('stores a small WebP copy of the picture, fetched without credentials or referrer', async () => {
    const item = await save(igImage(1));
    await keepThumb(item.id, igImage(1));
    const row = await db.thumbs.get(item.id);
    expect(row?.src).toBe(igImage(1));
    expect(row?.blob.type).toBe('image/webp');
    expect(row!.blob.size).toBeLessThanOrEqual(60_000);
    // 1080 × 1920 → at most 600 px tall and 400 px wide.
    expect(canvases).toEqual([{ width: 338, height: 600 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('encodes a busy picture again at a lower quality to keep it small', async () => {
    encodedBytes = 100_000;
    const item = await save(igImage(3));
    await keepThumb(item.id, igImage(3));
    expect((await db.thumbs.get(item.id))?.blob.size).toBe(50_000);
  });

  it('makes a JPEG where the browser has no WebP encoder', async () => {
    webp = false;
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    expect((await db.thumbs.get(item.id))?.blob.type).toBe('image/jpeg');
  });

  it('keeps a small image as it is', async () => {
    bitmap = { width: 320, height: 240 };
    fetchMock.mockImplementation(async () => jpeg(20_000));
    const item = await save(plainImage(2));
    await keepThumb(item.id, plainImage(2));
    const row = await db.thumbs.get(item.id);
    expect(row?.blob.size).toBe(20_000);
    expect(row?.blob.type).toBe('image/jpeg');
    expect(canvases).toEqual([]);
  });

  it('keeps one copy per save, replaced when its picture changes', async () => {
    const item = await save(igImage(1));
    await keepThumb(item.id, igImage(1));
    await updateItem(item.id, { image: igImage(2) });
    await keepThumb(item.id, igImage(2));
    expect(await db.thumbs.count()).toBe(1);
    expect((await db.thumbs.get(item.id))?.src).toBe(igImage(2));
  });

  it("doesn't store a picture the save no longer has, or download one it already has a copy of", async () => {
    const item = await save(igImage(2));
    await keepThumb(item.id, igImage(1));
    expect(await db.thumbs.count()).toBe(0);
    await Promise.all([keepThumb(item.id, igImage(2)), keepThumb(item.id, igImage(2))]);
    await keepThumb(item.id, igImage(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips what isn’t an image (a login page)', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const item = await save(plainImage(3));
    await keepThumb(item.id, plainImage(3));
    expect(await db.thumbs.count()).toBe(0);
  });

  it('falls back to loading it as an image (for the service worker cache) where CORS is refused', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const a = await save(igImage(1));
    const b = await save(igImage(2));
    await keepThumb(a.id, igImage(1));
    expect(await db.thumbs.count()).toBe(0);
    expect(loaded).toEqual([{ src: igImage(1), referrerPolicy: 'no-referrer' }]);
    // The same site isn't asked again this session.
    await keepThumb(b.id, igImage(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loaded.map((l) => l.src)).toEqual([igImage(1), igImage(2)]);
    expect(brokenImageIds()).toEqual([]);
  });

  it("doesn't load again what the service worker has cached, nor ask a site that refused CORS", async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const match = vi.fn(async (url: string) => (url === igImage(1) ? new Response('') : undefined));
    vi.stubGlobal('caches', { match });
    const a = await save(igImage(1));
    const b = await save(igImage(2));
    await keepThumb(a.id, igImage(1));
    expect(loaded).toEqual([]);
    expect(match).toHaveBeenCalledWith(igImage(1), expect.objectContaining({ cacheName: 'thumbnails' }));
    await keepThumb(b.id, igImage(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loaded.map((l) => l.src)).toEqual([igImage(2)]);
  });

  it('lists the save when its picture is gone and there is no copy', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 403 }));
    const item = await save(igImage(1));
    await keepThumb(item.id, igImage(1));
    expect(brokenImageIds()).toEqual([item.id]);
    expect(loaded).toEqual([]);
  });

  it("doesn't download an expired signed link", async () => {
    const old = igImage(1, Date.now() - 60_000);
    const item = await save(old);
    await keepThumb(item.id, old);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(brokenImageIds()).toEqual([item.id]);
  });

  it('never rejects, even when storage is full, and leaves the save alone', async () => {
    const item = await save(plainImage(4));
    vi.spyOn(db.thumbs, 'put').mockRejectedValue(Object.assign(new Error('full'), { name: 'QuotaExceededError' }));
    await expect(keepThumb(item.id, plainImage(4))).resolves.toBeUndefined();
    expect(await db.items.get(item.id)).toEqual(item);
  });

  it('clears a broken listing once a copy is made', async () => {
    const item = await save(plainImage(5));
    thumbFailed(item.id, plainImage(5));
    await vi.waitFor(() => expect(brokenImageIds()).toEqual([item.id]));
    await keepThumb(item.id, plainImage(5));
    expect(brokenImageIds()).toEqual([]);
  });
});

describe('signed links', () => {
  it('reads when Instagram / Facebook and TikTok image links expire', () => {
    expect(thumbExpiresAt(igImage(1))).toBe(LATER);
    expect(thumbExpiresAt(`https://scontent.xx.fbcdn.net/v/t1.0-9/1_n.jpg?_nc_cat=1&oe=${hex(LATER)}&oh=1`)).toBe(LATER);
    expect(thumbExpiresAt('https://p16-sign-va.tiktokcdn.com/obj/cover.jpeg?x-expires=1893456000&x-signature=abc')).toBe(1893456000000);
    expect(thumbExpiresAt('https://img.example.com/a.jpg?oe=70DBD880')).toBeUndefined();
    expect(thumbExpiresAt('not a link')).toBeUndefined();
    expect(thumbExpiresAt(undefined)).toBeUndefined();
  });
});

describe('storage', () => {
  it('evicts the oldest copies beyond the cap', async () => {
    const blob = new Blob(['x'], { type: 'image/webp' });
    await db.thumbs.bulkPut([1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, src: plainImage(n), blob, at: n })));
    expect(await pruneThumbs(3)).toBe(2);
    expect((await db.thumbs.toCollection().primaryKeys()).sort()).toEqual(['s3', 's4', 's5']);
    expect(await pruneThumbs(3)).toBe(0);
  });

  it('deletes a copy with its save, after the Undo window', async () => {
    const kept = await save(plainImage(1));
    const undone = await save(plainImage(2));
    await keepThumb(kept.id, plainImage(1));
    await keepThumb(undone.id, plainImage(2));
    thumbFailed(kept.id, plainImage(9));
    await vi.waitFor(() => expect(brokenImageIds()).toEqual([]));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await deleteItem(kept.id);
    await deleteItem(undone.id);
    await db.items.put(undone); // Undo
    expect(await db.thumbs.count()).toBe(2);
    await vi.advanceTimersByTimeAsync(THUMB_GRACE_MS);
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await db.thumbs.toCollection().primaryKeys()).sort()).toEqual([undone.id]));
  });

  it('clears every copy (and the broken list) with everything else', async () => {
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    const other = await save(plainImage(2));
    thumbFailed(other.id, plainImage(2));
    await vi.waitFor(() => expect(brokenImageIds()).toEqual([other.id]));
    await clearAll();
    expect(await db.thumbs.count()).toBe(0);
    expect(brokenImageIds()).toEqual([]);
  });

  it('deleteThumbs drops copies and broken listings', async () => {
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    await deleteThumbs([item.id, 'gone']);
    expect(await db.thumbs.count()).toBe(0);
  });

  it('keeps copies out of backups', async () => {
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    const backup = await exportBackup();
    expect(Object.keys(backup)).not.toContain('thumbs');
    expect(JSON.stringify(backup)).not.toMatch(/blob/i);
    expect(backup.items).toHaveLength(1);
  });

  it('has the thumbs table in schema v3, next to the saves', () => {
    expect(db.verno).toBe(3);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['collections', 'items', 'thumbs']);
  });
});

describe('broken pictures', () => {
  it('lists saves whose picture failed with no copy, newest first, kept across sessions', async () => {
    const a = await save(plainImage(1));
    const b = await save(plainImage(2));
    thumbFailed(a.id, plainImage(1));
    thumbFailed(b.id, plainImage(2));
    await vi.waitFor(() => expect(brokenImageIds()).toEqual([b.id, a.id]));
    resetThumbsState();
    expect(brokenImageIds()).toEqual([b.id, a.id]);
    clearBrokenImage(b.id);
    expect(brokenImageIds()).toEqual([a.id]);
    // Showing fine again takes it off.
    thumbShown(a.id, plainImage(1));
    expect(brokenImageIds()).toEqual([]);
  });

  it("doesn't list a save that has a copy, or anything while offline", async () => {
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    thumbFailed(item.id, plainImage(1));
    const other = await save(plainImage(2));
    vi.stubGlobal('navigator', { onLine: false });
    thumbFailed(other.id, plainImage(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(brokenImageIds()).toEqual([]);
  });

  it('is capped, and tells listeners', async () => {
    const heard = vi.fn();
    const off = onBrokenImage(heard);
    for (let n = 0; n < 205; n++) thumbFailed(`s${n}`, plainImage(n));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(205));
    off();
    const ids = brokenImageIds();
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('s204');
    expect(ids).not.toContain('s0');
  });
});

describe('background pass', () => {
  it('copies pictures without a copy, soonest-expiring first', async () => {
    const soon = igImage(1, Date.now() + 86_400_000);
    const later = igImage(2, Date.now() + 5 * 86_400_000);
    const kept = await save(plainImage(9));
    await keepThumb(kept.id, plainImage(9));
    fetchMock.mockClear();
    const plain = await save(plainImage(3));
    const b = await save(later);
    const a = await save(soon);
    await save(undefined);
    expect(await keepMissingThumbs()).toBe(3);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([soon, later, plainImage(3)]);
    expect((await db.thumbs.toCollection().primaryKeys()).sort()).toEqual([a.id, b.id, kept.id, plain.id].sort());
  });

  it('where CORS is refused, loads only signed links ahead, a few per pass and once across launches', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const signed = Array.from({ length: 34 }, (_, n) => igImage(n + 1));
    for (const src of signed) await save(src);
    await save(plainImage(1));
    await keepMissingThumbs();
    // Never the plain link (showing it caches it), and well under what the service worker keeps.
    expect(loaded).toHaveLength(30);
    expect(loaded.map((l) => l.src)).not.toContain(plainImage(1));
    const loadedBefore = new Set(loaded.map((l) => l.src));
    // Next launch: the rest, but not again the ones already loaded (even if the service worker let them go).
    resetThumbsState();
    loaded.length = 0;
    await keepMissingThumbs();
    expect(loaded.map((l) => l.src).sort()).toEqual(signed.filter((src) => !loadedBefore.has(src)).sort());
  });

  it('does nothing with link previews off', async () => {
    await save(plainImage(1));
    setSettings({ previews: false });
    try {
      expect(await keepMissingThumbs()).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setSettings({ previews: true });
    }
  });

  it('tidies up copies of deleted saves after the Undo window', async () => {
    const blob = new Blob(['x'], { type: 'image/webp' });
    await db.thumbs.put({ id: 'orphan', src: plainImage(1), blob, at: 1 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await keepMissingThumbs({ limit: 0 });
    expect(await db.thumbs.count()).toBe(1);
    await vi.advanceTimersByTimeAsync(THUMB_GRACE_MS);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await db.thumbs.count()).toBe(0));
  });

  it('keeps a picture once it has shown', async () => {
    const item = await save(plainImage(1));
    thumbShown(item.id, plainImage(1));
    await vi.waitFor(async () => expect((await db.thumbs.get(item.id))?.src).toBe(plainImage(1)));
  });
});

describe('useThumb / useThumbSrc', () => {
  function Probe({ item }: { item: Pick<Item, 'id' | 'image'> }) {
    const view = useThumb(item);
    const best = useThumbSrc(item);
    return createElement('pre', null, JSON.stringify({ src: view.src ?? null, waiting: view.waiting, best: best ?? null, link: view.link ?? null }));
  }

  const render = (item: Pick<Item, 'id' | 'image'>) => {
    const html = renderToStaticMarkup(createElement(Probe, { item }));
    const json = html.replace(/^<pre>|<\/pre>$/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    const { link, ...rest } = JSON.parse(json) as { src: string | null; waiting: boolean; best: string | null; link: string | null };
    expect(link).toBe(safeUrl(item.image) ?? null);
    return rest;
  };

  it('picks the copy on this device over the link', async () => {
    const local = await save(igImage(1));
    const remote = await save(igImage(2));
    await keepThumb(local.id, igImage(1));

    // Not looked up yet: an empty tile, or the link for plain consumers.
    expect(render(local)).toEqual({ src: null, waiting: true, best: igImage(1) });

    await preloadThumbs([local.id, remote.id]);
    const shown = render(local);
    expect(shown.src).toMatch(/^blob:/);
    expect(shown.best).toBe(shown.src);
    // One object URL per copy.
    expect(render(local).src).toBe(shown.src);
    expect(render(remote)).toEqual({ src: igImage(2), waiting: false, best: igImage(2) });
  });

  it('looks copies up as cards render, in batches in render order, never twice', async () => {
    const items = [];
    for (let i = 0; i < 15; i++) {
      const item = await save(plainImage(i));
      await db.thumbs.put({ id: item.id, src: plainImage(i), blob: new Blob(['x'], { type: 'image/webp' }), at: i });
      items.push(item);
    }
    const bulkGet = vi.spyOn(db.thumbs, 'bulkGet');
    items.forEach((item) => expect(render(item).waiting).toBe(true));
    // Rendered again before the answer: not asked again.
    items.forEach((item) => render(item));
    await preloadThumbs([]);
    expect(bulkGet.mock.calls.map(([ids]) => ids)).toEqual([items.slice(0, 8).map((i) => i.id), items.slice(8).map((i) => i.id)]);
    items.forEach((item) => expect(render(item).src).toMatch(/^blob:/));
    expect(bulkGet).toHaveBeenCalledTimes(2);
  });

  it('shows the fallback and lists the save when the link fails without a copy', async () => {
    const item = await save(igImage(2));
    await preloadThumbs([item.id]);
    thumbFailed(item.id, igImage(2));
    expect(render(item)).toEqual({ src: null, waiting: false, best: null });
    await vi.waitFor(() => expect(brokenImageIds()).toEqual([item.id]));
  });

  it('shows the new picture over an older copy, and the older copy when the new link fails', async () => {
    const item = await save(igImage(1));
    await keepThumb(item.id, igImage(1));
    await updateItem(item.id, { image: igImage(2) });
    const now = { id: item.id, image: igImage(2) };
    await preloadThumbs([item.id]);
    expect(render(now).src).toBe(igImage(2));
    thumbFailed(item.id, igImage(2));
    expect(render(now).src).toMatch(/^blob:/);
    await new Promise((r) => setTimeout(r, 20));
    expect(brokenImageIds()).toEqual([]);
  });

  it('switches to a copy made meanwhile, and back to the link when it is deleted', async () => {
    const item = await save(plainImage(1));
    await preloadThumbs([item.id]);
    expect(render(item).src).toBe(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    expect(render(item).src).toMatch(/^blob:/);
    await deleteThumbs([item.id]);
    expect(render(item).src).toBe(plainImage(1));
  });

  it("doesn't swap a picture that has loaded for its new copy", async () => {
    const item = await save(plainImage(1));
    await preloadThumbs([item.id]);
    thumbShown(item.id, plainImage(1));
    await vi.waitFor(async () => expect(await db.thumbs.count()).toBe(1));
    expect(render(item).src).toBe(plainImage(1));
    // Should the link fail after all, the copy takes over.
    thumbFailed(item.id, plainImage(1));
    expect(render(item).src).toMatch(/^blob:/);
  });

  it('falls back to the link when the copy itself fails to load, keeping it stored', async () => {
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    await preloadThumbs([item.id]);
    const local = render(item).src!;
    thumbFailed(item.id, local);
    expect(render(item).src).toBe(plainImage(1));
    expect(await db.thumbs.count()).toBe(1);
  });

  it('shows the link while a slow lookup runs, then the copy once it answers', async () => {
    const item = await save(plainImage(1));
    await keepThumb(item.id, plainImage(1));
    const rows = await db.thumbs.bulkGet([item.id]);
    let answer!: (r: typeof rows) => void;
    vi.spyOn(db.thumbs, 'bulkGet').mockReturnValue(new Promise<typeof rows>((r) => (answer = r)) as never);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = preloadThumbs([item.id]);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    vi.useRealTimers();
    expect(render(item).src).toBe(plainImage(1));
    // There may well be a copy: not listed.
    thumbFailed(item.id, plainImage(1));
    answer(rows);
    await vi.waitFor(() => expect(render(item).src).toMatch(/^blob:/));
    expect(brokenImageIds()).toEqual([]);
  });

  it('shows nothing for a save without a picture', () => {
    expect(render({ id: 'x', image: undefined })).toEqual({ src: null, waiting: false, best: null });
    expect(render({ id: 'y', image: 'javascript:alert(1)' })).toEqual({ src: null, waiting: false, best: null });
  });
});
