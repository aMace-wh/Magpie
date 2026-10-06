import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Clearing what earlier versions kept from an error page, the platform's logo or the account's page, and what the
// next previews do with those saves. Made-up examples.

const state = vi.hoisted(() => ({ broken: [] as string[] }));
vi.mock('./thumbs', () => ({
  keepThumb: vi.fn(async () => undefined),
  brokenImageIds: () => state.broken.slice(),
  clearBrokenImage: vi.fn((id: string) => (state.broken = state.broken.filter((b) => b !== id))),
  deleteThumbs: vi.fn(async () => undefined),
}));
vi.mock('./geo', () => ({
  searchPlaces: vi.fn(async () => []),
  reverseGeocode: vi.fn(async () => undefined),
  geoHealth: () => ({ paused: false, troubles: 0, userBusy: false }),
  backgroundSignal: vi.fn((parent?: AbortSignal) => parent ?? new AbortController().signal),
  lookupReport: () => ({ asked: false, troubled: false }),
  whenUserIdle: vi.fn(async () => undefined),
}));

import { cleanBadPreviews, resetBackfillState, retryPreviews } from './backfill';
import { addItem, db } from './db';
import { enrichItem, REFRESH_OPTIONS } from './enrich';
import { resetPreviewLimit } from './metadata';
import { setSettings } from './settings';
import { deleteThumbs } from './thumbs';

const REEL = 'https://www.instagram.com/reel/AbC123def/';
const TRIES_KEY = 'magpie:preview-tries';
const PFP = 'https://scontent.cdninstagram.com/v/pfp.jpg';
const PROFILE_TEXT = '12K Followers, 300 Following, 1,234 Posts - See Instagram photos and videos from Mei Chan (@mei.eats)';
const get = async (id: string) => (await db.items.get(id))!;

/** A localStorage that lives as long as the test (Node has none). */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  };
}

let storage: Storage;
const tries = () => JSON.parse(storage.getItem(TRIES_KEY) ?? '{}') as Record<string, { at: number; n: number }>;

/** microlink answers every request with `data`; returns the fetch mock. */
function microlink(data: Record<string, unknown>) {
  const fn = vi.fn(async () => new Response(JSON.stringify({ status: 'success', data }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const reelAnswer = (caption: string) => ({
  title: 'Mei Chan (@mei.eats) • Instagram reel',
  description: `1,204 likes, 33 comments - mei.eats on September 12, 2026: “${caption}”.`,
  image: { url: 'https://scontent.cdninstagram.com/v/reel.jpg' },
  publisher: 'Instagram',
  url: REEL,
});

beforeEach(async () => {
  await db.items.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  resetBackfillState();
  resetPreviewLimit();
  setSettings({ previews: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cleanBadPreviews', () => {
  it("clears an error page's text and the logo, and the copy kept of it", async () => {
    const bad = await addItem({ type: 'video', title: 'Instagram reel', url: REEL, source: 'instagram', siteName: 'Instagram', image: 'https://static.cdninstagram.com/rsrc.php/v4/logo.png', description: "Sorry, this page isn't available." });
    const good = await addItem({ type: 'video', title: 'Night market crawl', url: 'https://www.instagram.com/reel/XyZ789abc/', source: 'instagram', siteName: 'Instagram', image: 'https://scontent.cdninstagram.com/v/x.jpg', description: 'Night market crawl' });
    await db.thumbs.put({ id: bad.id, src: bad.image!, blob: new Blob(['logo']), at: Date.now() });
    expect(await cleanBadPreviews()).toBe(1);
    const after = await get(bad.id);
    expect(after.image).toBeUndefined();
    expect(after.description).toBeUndefined();
    expect(after.siteName).toBeUndefined();
    expect(after.title).toBe('Instagram reel');
    expect(after.updatedAt).toBeGreaterThanOrEqual(bad.updatedAt);
    // The copy goes a moment later, once the cards have the cleaned save.
    expect(vi.mocked(deleteThumbs)).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(vi.mocked(deleteThumbs)).toHaveBeenCalledWith([bad.id]), { timeout: 4000 });
    expect(await get(good.id)).toEqual(good);
    // Nothing left to do the next time.
    expect(await cleanBadPreviews()).toBe(0);
  });

  it('keeps the copy of a picture that came back meanwhile, not one of the old picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const logo = 'https://static.cdninstagram.com/rsrc.php/v4/logo.png';
    const back = await addItem({ type: 'video', title: 'Instagram reel', url: REEL, source: 'instagram', image: logo });
    const stale = await addItem({ type: 'video', title: 'Instagram reel', url: 'https://www.instagram.com/reel/XyZ789abc/', source: 'instagram', image: logo });
    for (const id of [back.id, stale.id]) await db.thumbs.put({ id, src: logo, blob: new Blob(['logo']), at: Date.now() });
    const run = cleanBadPreviews();
    await vi.advanceTimersByTimeAsync(100);
    expect(await run).toBe(2);
    // Both get their post's picture back; only the first has a copy of it by the time the old copies go.
    const reel = 'https://scontent.cdninstagram.com/v/reel.jpg';
    await db.items.update(back.id, { image: reel });
    await db.items.update(stale.id, { image: reel });
    await db.thumbs.put({ id: back.id, src: reel, blob: new Blob(['reel']), at: Date.now() });
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(vi.mocked(deleteThumbs)).toHaveBeenCalledWith([stale.id]));
  });

  it("clears an account's page that came back instead of the reel, with the title and author it gave it", async () => {
    const item = await addItem({ type: 'video', title: 'Reel by Mei Chan', url: REEL, source: 'instagram', siteName: 'Instagram', author: 'Mei Chan', image: PFP, description: PROFILE_TEXT });
    expect(await cleanBadPreviews()).toBe(1);
    const after = await get(item.id);
    expect([after.image, after.description, after.siteName, after.author]).toEqual([undefined, undefined, undefined, undefined]);
    expect(after.title).toBe('Instagram reel');
  });

  it('keeps a public post whose caption starts like an error page', async () => {
    const description = 'Page not found? Try this hidden café in Taipei #taipei';
    const item = await addItem({ type: 'video', title: 'Page not found? Try this hidden café', url: REEL, source: 'instagram', siteName: 'Instagram', image: 'https://scontent.cdninstagram.com/v/x.jpg', description });
    expect(await cleanBadPreviews()).toBe(0);
    expect((await get(item.id)).description).toBe(description);
  });

  it('puts cleaned saves, and bare posts given up on before, first in line once', async () => {
    const bad = await addItem({ type: 'video', title: 'Instagram reel', url: REEL, source: 'instagram', image: 'https://static.cdninstagram.com/rsrc.php/v4/logo.png' });
    const bare = await addItem({ type: 'video', title: 'Instagram reel', url: 'https://www.instagram.com/reel/Dd8bare12/', source: 'instagram' });
    const site = await addItem({ type: 'link', title: 'example.com', url: 'https://example.com/a' });
    const at = Date.now() - 3600_000;
    storage.setItem(TRIES_KEY, JSON.stringify({ [bad.id]: { at, n: 8 }, [bare.id]: { at, n: 3 }, [site.id]: { at, n: 3 } }));
    await cleanBadPreviews();
    expect(Object.keys(tries())).toEqual([site.id]);
    // Only once: after that, the bare post waits its turn like any other.
    storage.setItem(TRIES_KEY, JSON.stringify({ [bare.id]: { at, n: 3 } }));
    await cleanBadPreviews();
    expect(Object.keys(tries())).toEqual([bare.id]);
  });
});

describe('the next previews of those saves', () => {
  it("never stores an account's page given under the reel's own link, so nothing is cleaned and fetched again every launch", async () => {
    const item = await addItem({ type: 'video', title: 'Instagram reel', url: REEL, source: 'instagram' });
    // Under the reel's link, and with no link at all.
    for (const url of [REEL, undefined]) {
      const fetch = microlink({ title: 'Mei Chan (@mei.eats) • Instagram photos and videos', description: PROFILE_TEXT, image: { url: PFP }, publisher: 'Instagram', url });
      expect(await enrichItem(item.id, REFRESH_OPTIONS)).toBe(false);
      const stored = await get(item.id);
      expect([stored.title, stored.image, stored.description, stored.author, stored.previewIssue]).toEqual(['Instagram reel', undefined, undefined, undefined, 'unavailable']);
      // The next launches: nothing to clean, and the retries back off.
      storage.removeItem(TRIES_KEY);
      resetBackfillState();
      const perLaunch: number[] = [];
      for (let launch = 0; launch < 3; launch++) {
        expect(await cleanBadPreviews()).toBe(0);
        const before = fetch.mock.calls.length;
        await retryPreviews({ missing: 5, pictures: 0 });
        perLaunch.push(fetch.mock.calls.length - before);
      }
      expect(perLaunch).toEqual([1, 0, 0]);
      expect((await get(item.id)).image).toBeUndefined();
    }
  });

  it("gives an account's leftovers the reel's caption title and author once it's public again", async () => {
    const item = await addItem({ type: 'video', title: 'Reel by Some One', url: REEL, source: 'instagram', siteName: 'Instagram', author: 'Some One', image: PFP, description: PROFILE_TEXT });
    expect(await cleanBadPreviews()).toBe(1);
    microlink(reelAnswer('Night market crawl at Raohe'));
    expect(await retryPreviews({ missing: 5, pictures: 0 })).toBe(1);
    const after = await get(item.id);
    expect(after).toMatchObject({ title: 'Night market crawl at Raohe', description: 'Night market crawl at Raohe', image: 'https://scontent.cdninstagram.com/v/reel.jpg', author: 'Mei Chan' });
    expect(after.previewIssue).toBeUndefined();
  });

  it('follows a share link to its reel instead of calling it unavailable', async () => {
    const share = 'https://www.instagram.com/share/reel/BAxyz12345/';
    const item = await addItem({ type: 'video', title: 'Instagram reel', url: share, source: 'instagram' });
    microlink({ ...reelAnswer('Night market crawl'), url: 'https://www.instagram.com/reel/DAbcdEFGhij/' });
    expect(await enrichItem(item.id, { replaceTitle: true, reclassify: true })).toBe(true);
    const after = await get(item.id);
    expect(after.url).toBe('https://www.instagram.com/reel/DAbcdEFGhij/');
    expect(after.title).toBe('Night market crawl');
    expect(after.previewIssue).toBeUndefined();
  });
});
