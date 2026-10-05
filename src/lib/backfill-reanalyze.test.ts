import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Looking again at older saves, and asking again for previews that never came. All examples are made up.

const state = vi.hoisted(() => ({
  limitedUntil: 0,
  broken: [] as string[],
  idle: undefined as undefined | (() => void)[],
  report: { asked: true, troubled: false },
}));
vi.mock('./metadata', () => ({ fetchPreview: vi.fn(), previewsLimitedUntil: () => state.limitedUntil }));
vi.mock('./thumbs', () => ({
  keepThumb: vi.fn(async () => undefined),
  brokenImageIds: () => state.broken.slice(),
  clearBrokenImage: vi.fn((id: string) => (state.broken = state.broken.filter((b) => b !== id))),
}));
vi.mock('./geo', () => ({
  searchPlaces: vi.fn(async () => []),
  reverseGeocode: vi.fn(async () => undefined),
  geoHealth: () => ({ paused: false, troubles: 0, userBusy: false }),
  backgroundSignal: vi.fn(() => new AbortController().signal),
  whenUserIdle: vi.fn(async () => undefined),
  lookupReport: () => state.report,
}));
vi.mock('./warmup', async (importOriginal) => {
  const real = await importOriginal<typeof import('./warmup')>();
  // Idle moments on demand when a test holds them, else right away.
  const whenIdle = (cb: (d: { timeRemaining(): number }) => void) => {
    const run = () => cb({ timeRemaining: () => 50 });
    if (state.idle) state.idle.push(run);
    else setTimeout(run, 0);
    return () => {};
  };
  return { ...real, whenIdle };
});

import { reanalyzeSaves, resetBackfillState, retryPreviews } from './backfill';
import { addItem, db, updateItem, type NewItem } from './db';
import { searchPlaces } from './geo';
import { fetchPreview } from './metadata';
import { setSettings } from './settings';
import { clearBrokenImage } from './thumbs';
import { exportBackup, importBackup } from './transfer';
import { ANALYSIS_VERSION } from './understand';

const preview = vi.mocked(fetchPreview);
const search = vi.mocked(searchPlaces);
const REEL = 'https://www.instagram.com/reel/AbC123def/';
const get = async (id: string) => (await db.items.get(id))!;

/** A save as older versions stored an Instagram reel: the account as title, the description as the service gave it. */
async function older(caption: string, extra: Partial<NewItem> = {}) {
  return addItem({
    type: 'video',
    title: 'Mei Chan (@mei.eats) • Instagram reel',
    url: REEL,
    sharedText: REEL,
    siteName: 'Instagram',
    description: `1,204 likes, 33 comments - mei.eats on September 12, 2026: “${caption}”.`,
    ...extra,
  });
}

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

beforeEach(async () => {
  await db.items.clear();
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', memoryStorage());
  resetBackfillState();
  setSettings({ previews: true });
  state.limitedUntil = 0;
  state.broken = [];
  state.idle = undefined;
  state.report = { asked: true, troubled: false };
  preview.mockResolvedValue({});
  search.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reanalyzeSaves', () => {
  it('gives older saves a caption title, a better kind and a clean description, and drops the posting date', async () => {
    const item = await older('Five-minute desk stretches 🧘 neck and shoulder mobility routine, 3 sets each #mobility', { when: { start: '2026-09-12' } });
    expect(await reanalyzeSaves()).toBe(1);
    const saved = await get(item.id);
    expect(saved).toMatchObject({
      title: 'Five-minute desk stretches',
      type: 'workout',
      author: 'Mei Chan',
      description: 'Five-minute desk stretches 🧘 neck and shoulder mobility routine, 3 sets each #mobility',
      analyzed: ANALYSIS_VERSION,
    });
    expect(saved.when).toBeUndefined();
    expect(saved.tags).toContain('mobility');
    expect(saved.updatedAt).toBeGreaterThanOrEqual(item.updatedAt);
    // Once is enough.
    expect(await reanalyzeSaves()).toBe(0);
  });

  it('leaves what the user chose alone, and only marks it as looked at', async () => {
    const item = await older('Travel vlog: a day in Taipei 🇹🇼 night markets and temples', { type: 'recipe', title: 'Weeknight dumplings', when: { start: '2026-12-01' } });
    expect(await reanalyzeSaves()).toBe(1); // the description loses its wrapper
    const saved = await get(item.id);
    expect(saved).toMatchObject({ type: 'recipe', title: 'Weeknight dumplings', when: { start: '2026-12-01' }, analyzed: ANALYSIS_VERSION });
  });

  it("doesn't bump a save's version when there's nothing to change", async () => {
    const item = await addItem({ type: 'note', title: 'Call the plumber' });
    expect(await reanalyzeSaves()).toBe(0);
    const saved = await get(item.id);
    expect(saved.analyzed).toBe(ANALYSIS_VERSION);
    expect(saved.updatedAt).toBe(item.updatedAt);
  });

  it('skips a save edited while it was being looked at', async () => {
    const item = await older('Five-minute desk stretches 🧘 neck and shoulder mobility routine, 3 sets each');
    state.idle = [];
    const run = reanalyzeSaves();
    await vi.waitFor(() => expect(state.idle!.length).toBe(1));
    await db.items.update(item.id, { title: 'My stretches', updatedAt: item.updatedAt + 1 });
    state.idle.shift()!();
    await run;
    const saved = await get(item.id);
    expect(saved.title).toBe('My stretches');
    expect(saved.analyzed).toBeUndefined();
  });

  it('looks up a few pinned places per run, and marks them once asked', async () => {
    const a = await older('Best egg tarts in town 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong');
    const b = await older('Rooftop bar with a view 🍸\n📍 Level 30, Queen’s Road Central, Hong Kong');
    await db.items.update(b.id, { createdAt: a.createdAt + 1 });
    search.mockResolvedValue([{ lat: 22.283, lng: 114.153, name: 'Somewhere', city: 'Hong Kong', country: 'Hong Kong', countryCode: 'HK' }]);
    await reanalyzeSaves({ locate: 1 });
    expect(search).toHaveBeenCalledTimes(1);
    const [first, second] = [await get(a.id), await get(b.id)];
    // Newest first. Both are looked at once; the other one waits on the list of places to look up.
    expect(second.place?.countryCode).toBe('HK');
    expect(second.analyzed).toBe(ANALYSIS_VERSION);
    expect(second.locatePending).toBeUndefined();
    expect(second.type).toBe('place');
    expect(first.place).toBeUndefined();
    expect(first).toMatchObject({ analyzed: ANALYSIS_VERSION, locatePending: true, type: 'place', title: 'Best egg tarts in town' });
    // The next run picks up the other one.
    await reanalyzeSaves({ locate: 1 });
    expect(await get(a.id)).toMatchObject({ place: { countryCode: 'HK' } });
    expect((await get(a.id)).locatePending).toBeUndefined();
  });

  it('stops looking places up at the first timeout, and tries that save again later', async () => {
    const item = await older('Best egg tarts in town 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong');
    await older('Rooftop bar with a view 🍸\n📍 Level 30, Queen’s Road Central, Hong Kong');
    state.report = { asked: true, troubled: true };
    search.mockRejectedValue(new Error('Place search is taking too long.'));
    await reanalyzeSaves();
    expect(search).toHaveBeenCalledTimes(1);
    expect((await get(item.id)).locatePending).toBe(true);
  });

  it('still tidies titles with link previews off, but looks nothing up', async () => {
    setSettings({ previews: false });
    const item = await older('Best egg tarts in town 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong');
    await reanalyzeSaves();
    expect(search).not.toHaveBeenCalled();
    expect((await get(item.id)).title).toBe('Best egg tarts in town');
  });
});

describe('reanalyzeSaves and what the user changed', () => {
  it('keeps a kind, tags and a date the user changed before it got to them', async () => {
    const item = await older('Pilates core flow 🧘 20 minutes, no equipment #pilates\nClass on Saturday 24 October 2026', { tags: ['pilates', 'saved'] });
    await updateItem(item.id, { type: 'link' });
    await updateItem(item.id, { tags: ['saved'] });
    expect((await get(item.id)).edited).toEqual(['type', 'tags']);
    await reanalyzeSaves();
    const saved = await get(item.id);
    expect(saved).toMatchObject({ type: 'link', tags: ['saved'], title: 'Pilates core flow 🧘 20 minutes, no equipment', analyzed: ANALYSIS_VERSION });
    // A date they removed isn't brought back either.
    const dated = await older('Rooftop film night 🎬 Saturday 24 October 2026, 8pm', { type: 'event', when: { start: '2026-10-24T20:00' } });
    await updateItem(dated.id, { when: undefined });
    await reanalyzeSaves();
    expect((await get(dated.id)).when).toBeUndefined();
  });

  it('looks at a save once, even while its place lookup waits', async () => {
    setSettings({ previews: false });
    const item = await older('Best egg tarts in town 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong');
    await reanalyzeSaves();
    expect(await get(item.id)).toMatchObject({ type: 'place', analyzed: ANALYSIS_VERSION, locatePending: true });
    // The user disagrees; the next launches leave that alone and still look the place up.
    await updateItem(item.id, { type: 'video', title: 'Tarts' });
    setSettings({ previews: true });
    search.mockResolvedValue([{ lat: 22.28, lng: 114.15, name: 'Somewhere', city: 'Hong Kong', country: 'Hong Kong', countryCode: 'HK' }]);
    await reanalyzeSaves();
    const saved = await get(item.id);
    expect(saved).toMatchObject({ type: 'video', title: 'Tarts', place: { countryCode: 'HK' } });
    expect(saved.locatePending).toBeUndefined();
  });

  it("never looks up a place the user removed, nor touches other sites' saves", async () => {
    const pinned = await older('Best egg tarts in town 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong', { place: { lat: 1, lng: 2, countryCode: 'HK' } });
    await updateItem(pinned.id, { place: undefined });
    const event = await addItem({ type: 'event', title: 'Jazz night', url: 'https://example.com/jazz', description: 'Jazz night on Saturday 24 October 2026 at the club' });
    const video = await addItem({ type: 'video', title: 'Easy carbonara recipe', url: 'https://example.com/v/1', description: 'Ingredients: 200g spaghetti, 2 eggs. Method: boil, whisk, toss.' });
    const place = await addItem({ type: 'place', title: 'Ramen night', url: 'https://example.com/r', description: '📍 Ichiran Shibuya, Tokyo' });
    await reanalyzeSaves();
    expect(search).not.toHaveBeenCalled();
    expect((await get(pinned.id)).place).toBeUndefined();
    expect((await get(event.id)).when).toBeUndefined();
    expect((await get(video.id)).type).toBe('video');
    expect((await get(place.id)).place).toBeUndefined();
    for (const id of [event.id, video.id, place.id]) expect((await get(id)).updatedAt).toBe((await db.items.get(id))!.createdAt);
  });

  it('keeps what was done and what the user set through a backup and restore', async () => {
    const item = await older('Best egg tarts in town 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong');
    setSettings({ previews: false });
    await reanalyzeSaves();
    await updateItem(item.id, { tags: ['mine'] });
    const backup = await exportBackup();
    await db.items.clear();
    await importBackup(JSON.parse(JSON.stringify(backup)));
    expect(await get(item.id)).toMatchObject({ analyzed: ANALYSIS_VERSION, edited: ['tags'], locatePending: true, tags: ['mine'] });
  });
});

describe('retryPreviews', () => {
  const caption = 'Late-night ramen worth the queue 🍜';
  const answer = { title: caption, rawTitle: caption, description: caption, caption, siteName: 'Instagram', image: 'https://img.example/ramen.jpg' };

  it('asks again for a save that never got a preview, then not again for 12 hours', async () => {
    const item = await addItem({ type: 'video', title: 'Instagram reel', url: REEL });
    preview.mockResolvedValueOnce({ problem: 'timeout' });
    expect(await retryPreviews()).toBe(0);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(await retryPreviews()).toBe(0);
    expect(preview).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ now: Date.now() + 12 * 3600_000 + 1000, toFake: ['Date'] });
    preview.mockResolvedValue(answer);
    expect(await retryPreviews()).toBe(1);
    expect(await get(item.id)).toMatchObject({ title: 'Late-night ramen worth the queue', image: answer.image });
  });

  it("doesn't add a date or place to a save that has one, or that the user cleared", async () => {
    const dated = await addItem({ type: 'event', title: 'Instagram reel', url: REEL, when: { start: '2026-10-20T19:00' } });
    const cleared = await addItem({ type: 'event', title: 'Instagram reel', url: 'https://www.instagram.com/reel/Zz9/', when: { start: '2026-10-20' } });
    await updateItem(cleared.id, { when: undefined });
    const text = 'Opening night 🎨 Saturday 24 October 2026, 7pm\n📍 Harbour Gallery, Central, Hong Kong';
    preview.mockResolvedValue({ title: 'Opening night', rawTitle: text, description: text, caption: text, siteName: 'Instagram' });
    expect(await retryPreviews()).toBe(2);
    expect((await get(dated.id)).when).toEqual({ start: '2026-10-20T19:00' });
    expect((await get(cleared.id)).when).toBeUndefined();
  });

  it('asks at most a handful per run, newest first, and stops for the day when the service is out of requests', async () => {
    for (let i = 0; i < 7; i++) await addItem({ type: 'link', title: `Link ${i}`, url: `https://example.com/${i}` });
    expect(await retryPreviews({ missing: 3, pictures: 0 })).toBe(0);
    expect(preview).toHaveBeenCalledTimes(3);
    preview.mockClear();
    resetBackfillState();
    preview.mockImplementation(async () => {
      state.limitedUntil = Date.now() + 3600_000;
      return { problem: 'limited' };
    });
    vi.stubGlobal('localStorage', memoryStorage());
    await retryPreviews();
    expect(preview).toHaveBeenCalledTimes(1);
    await retryPreviews();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it('leaves saves with a preview, notes and other links alone', async () => {
    await addItem({ type: 'link', title: 'Has one', url: 'https://example.com/a', image: 'https://img.example/a.jpg' });
    await addItem({ type: 'note', title: 'Just a note' });
    await addItem({ type: 'place', title: 'Pin', url: 'geo:22.3,114.2' });
    expect(await retryPreviews()).toBe(0);
    expect(preview).not.toHaveBeenCalled();
  });

  it('gets a fresh picture for saves whose picture stopped loading', async () => {
    const item = await addItem({ type: 'video', title: 'Ramen', url: REEL, image: 'https://img.example/old.jpg', siteName: 'Instagram' });
    state.broken = [item.id, 'gone'];
    preview.mockResolvedValue(answer);
    expect(await retryPreviews()).toBe(1);
    expect((await get(item.id)).image).toBe(answer.image);
    // A title the user gave is kept; the gone save is just taken off the list.
    expect((await get(item.id)).title).toBe('Ramen');
    expect(clearBrokenImage).toHaveBeenCalledWith('gone');
    expect(state.broken).toEqual([]);
  });

  it('does nothing offline, with previews off or while the service is out of requests', async () => {
    await addItem({ type: 'link', title: 'Link', url: 'https://example.com/a' });
    setSettings({ previews: false });
    expect(await retryPreviews()).toBe(0);
    setSettings({ previews: true });
    state.limitedUntil = Date.now() + 1000;
    expect(await retryPreviews()).toBe(0);
    state.limitedUntil = 0;
    vi.stubGlobal('navigator', { onLine: false });
    expect(await retryPreviews()).toBe(0);
    expect(preview).not.toHaveBeenCalled();
  });

  it('asks for at most 20 previews a day in all', async () => {
    for (let i = 0; i < 25; i++) await addItem({ type: 'link', title: `Link ${i}`, url: `https://example.com/${i}` });
    for (let run = 0; run < 6; run++) {
      resetBackfillState();
      // Each launch remembers the budget, but not the per-save tries (a fresh device would retry them).
      const budget = localStorage.getItem('magpie:preview-budget');
      vi.stubGlobal('localStorage', memoryStorage());
      if (budget) localStorage.setItem('magpie:preview-budget', budget);
      await retryPreviews();
    }
    expect(preview).toHaveBeenCalledTimes(20);
  });
});
