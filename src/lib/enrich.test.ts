import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./metadata', () => ({ fetchPreview: vi.fn() }));
vi.mock('./thumbs', () => ({ keepThumb: vi.fn(async () => undefined) }));
const geoState = vi.hoisted(() => ({ paused: false, report: { asked: true, troubled: false } }));
vi.mock('./geo', () => ({
  searchPlaces: vi.fn(),
  reverseGeocode: vi.fn(),
  geoHealth: () => ({ paused: geoState.paused, troubles: 0, userBusy: false }),
  backgroundSignal: vi.fn((parent?: AbortSignal) => parent ?? new AbortController().signal),
  lookupReport: () => geoState.report,
}));

import { addItem, db, saveShared, type NewItem } from './db';
import { enrichItem, isShortLink, locationHints, looksLikeVenue, REFRESH_OPTIONS, resolvedShortLink, type EnrichOptions } from './enrich';
import { backgroundSignal, reverseGeocode, searchPlaces, type GeoResult } from './geo';
import { fetchPreview, type LinkPreview } from './metadata';
import { setSettings } from './settings';
import { keepThumb } from './thumbs';
import type { Item } from './types';
import { ANALYSIS_VERSION } from './understand';
import { toLocalIso } from './when';

const preview = vi.mocked(fetchPreview);
const search = vi.mocked(searchPlaces);
const reverse = vi.mocked(reverseGeocode);

const GUESSED: EnrichOptions = { replaceTitle: true, reclassify: true };
const DAY = 86400000;

/** An unambiguous date ~3 weeks away, e.g. "21 October 2026", and its ISO form. */
function futureDate(days = 21): { label: string; iso: string } {
  const d = new Date(Date.now() + days * DAY);
  return { label: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), iso: toLocalIso(d) };
}

async function save(data: Partial<NewItem>): Promise<Item> {
  return addItem({ type: 'link', title: 'Saved link', url: 'https://example.com/post/1', ...data });
}

const get = async (id: string) => (await db.items.get(id))!;

const lisbonResult: GeoResult = { lat: 38.7189, lng: -9.1446, name: 'Hot Clube de Portugal', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' };

beforeEach(async () => {
  await db.items.clear();
  vi.clearAllMocks();
  geoState.paused = false;
  geoState.report = { asked: true, troubled: false };
  setSettings({ previews: true });
  preview.mockResolvedValue({});
  search.mockResolvedValue([]);
  reverse.mockResolvedValue(undefined);
});

afterEach(() => {
  setSettings({ previews: true });
});

describe('enrichItem: previews off', () => {
  it('makes no network calls and changes nothing', async () => {
    setSettings({ previews: false });
    const item = await save({ type: 'event', url: 'https://vm.tiktok.com/ZMabc123/', sharedText: 'Gig 📍 Hot Clube de Portugal, Lisbon', place: { lat: 1, lng: 2 } });
    await enrichItem(item.id, GUESSED);
    expect(preview).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(reverse).not.toHaveBeenCalled();
    expect(await get(item.id)).toEqual(item);
  });
});

describe('enrichItem: identify', () => {
  it('reclassifies with the raw title (keeping its hashtags) when the new guess is confident', async () => {
    const item = await save({ url: 'https://www.instagram.com/p/abc123/', title: 'Instagram post', tags: [] });
    preview.mockResolvedValue({
      title: 'Creamy lemon orzo',
      rawTitle: 'Creamy lemon orzo #pasta #recipe',
      description: 'Ingredients: orzo, lemon, parmesan. Ready in 20 minutes.',
    });
    await enrichItem(item.id, GUESSED);
    const saved = await get(item.id);
    expect(saved.type).toBe('recipe');
    expect(saved.title).toBe('Creamy lemon orzo');
    expect(saved.tags).toContain('pasta');
  });

  it('keeps the type when the new guess is unsure', async () => {
    const item = await save({ type: 'video', url: 'https://www.tiktok.com/@a/video/1', title: 'TikTok video' });
    preview.mockResolvedValue({ title: 'Amazing ramen restaurant in Shibuya' });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).type).toBe('video');
  });

  it("doesn't reclassify or retitle what the user chose", async () => {
    const item = await save({ url: 'https://www.instagram.com/p/abc123/', title: 'My pasta' });
    preview.mockResolvedValue({ title: 'Creamy lemon orzo', rawTitle: 'Creamy lemon orzo #pasta #recipe', description: 'Ingredients: orzo, lemon.' });
    await enrichItem(item.id, { replaceTitle: false, reclassify: false });
    const saved = await get(item.id);
    expect(saved.type).toBe('link');
    expect(saved.title).toBe('My pasta');
  });
});

describe('enrichItem: when', () => {
  it('adds a clear date from the page', async () => {
    const { label, iso } = futureDate();
    const item = await save({ title: 'Big night out' });
    preview.mockResolvedValue({ title: 'Big night out', description: `Doors open ${label}. Tickets on sale now.` });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).when?.start.slice(0, 10)).toBe(iso);
  });

  it('only takes a loose date ("this Saturday") for events', async () => {
    const link = await save({ title: 'A link' });
    const event = await save({ type: 'event', title: 'Street party', url: 'https://example.com/party' });
    preview.mockResolvedValue({ description: 'See you this Saturday!' });
    await enrichItem(link.id, { replaceTitle: false, reclassify: false });
    await enrichItem(event.id, { replaceTitle: false, reclassify: false });
    expect((await get(link.id)).when).toBeUndefined();
    expect((await get(event.id)).when).toBeDefined();
  });

  it('never replaces a date that is already set', async () => {
    const { label } = futureDate();
    const mine = { start: '2031-01-02' };
    const item = await save({ when: mine });
    preview.mockResolvedValue({ description: `On ${label}` });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).when).toEqual(mine);
  });

  it('keeps a date the user set (or removed) while the preview was loading', async () => {
    const { label } = futureDate();
    const item = await save({});
    const mine = { start: '2031-05-06' };
    preview.mockImplementation(async () => {
      await db.items.update(item.id, { when: mine });
      return { description: `On ${label}` } satisfies LinkPreview;
    });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).when).toEqual(mine);

    const removed = await save({ when: { start: '2031-05-06' } });
    preview.mockImplementation(async () => {
      await db.items.update(removed.id, { when: undefined });
      return { description: `On ${label}` } satisfies LinkPreview;
    });
    await enrichItem(removed.id, GUESSED);
    expect((await get(removed.id)).when).toBeUndefined();

    const cleared = await save({});
    preview.mockResolvedValue({ description: `On ${label}` });
    await enrichItem(cleared.id, { ...GUESSED, dates: false });
    expect((await get(cleared.id)).when).toBeUndefined();
  });
});

describe('enrichItem: short links', () => {
  it('knows the redirectors', () => {
    for (const u of [
      'https://vm.tiktok.com/ZMabc/',
      'https://vt.tiktok.com/ZSabc/',
      'https://www.tiktok.com/t/ZTabc/',
      'https://pin.it/abc',
      'https://redd.it/abc',
      'https://spotify.link/abc',
      'https://fb.watch/abc/',
      'https://www.facebook.com/share/r/abc/',
      'https://maps.app.goo.gl/abc',
      'https://goo.gl/maps/abc',
      'https://amzn.to/abc',
      'https://amzn.eu/d/abc',
      'https://a.co/d/abc',
      'https://bit.ly/abc',
      'https://t.co/abc',
    ]) {
      expect(isShortLink(u), u).toBe(true);
    }
    for (const u of ['https://www.tiktok.com/@a/video/1', 'https://www.facebook.com/somepage', 'https://goo.gl/abc', 'javascript:alert(1)', undefined]) {
      expect(isShortLink(u), String(u)).toBe(false);
    }
  });

  it('only accepts a safe, different destination that is not a login wall or home page', () => {
    const short = 'https://vm.tiktok.com/ZMabc/';
    expect(resolvedShortLink(short, 'https://www.tiktok.com/@chef/video/7234567890123456789')).toBe('https://www.tiktok.com/@chef/video/7234567890123456789');
    expect(resolvedShortLink(short, 'https://vm.tiktok.com/ZMabc')).toBeUndefined();
    expect(resolvedShortLink(short, 'https://www.tiktok.com/')).toBeUndefined();
    expect(resolvedShortLink(short, 'https://www.tiktok.com/login?redirect_url=x')).toBeUndefined();
    expect(resolvedShortLink('https://maps.app.goo.gl/abc', 'https://consent.google.com/m?continue=x')).toBeUndefined();
    expect(resolvedShortLink(short, 'javascript:alert(1)')).toBeUndefined();
    expect(resolvedShortLink('https://example.com/a', 'https://example.com/b')).toBeUndefined();
  });

  it('swaps a short link for where it leads and keeps the original as the shared text', async () => {
    const item = await save({ type: 'video', url: 'https://vm.tiktok.com/ZMabc123/', title: 'TikTok video', source: 'tiktok' });
    preview.mockResolvedValue({ finalUrl: 'https://www.tiktok.com/@chef/video/7234567890123456789?_r=1' });
    await enrichItem(item.id, GUESSED);
    const saved = await get(item.id);
    expect(saved.url).toBe('https://www.tiktok.com/@chef/video/7234567890123456789?_r=1');
    expect(saved.sharedText).toBe('https://vm.tiktok.com/ZMabc123/');
    expect(saved.source).toBe('tiktok');
  });

  it('keeps existing shared text, and leaves normal links alone', async () => {
    const short = await save({ url: 'https://bit.ly/abc', sharedText: 'Watch this! https://bit.ly/abc' });
    const normal = await save({ url: 'https://example.com/a' });
    preview.mockResolvedValueOnce({ finalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }).mockResolvedValueOnce({ finalUrl: 'https://example.com/b' });
    await enrichItem(short.id, GUESSED);
    await enrichItem(normal.id, GUESSED);
    const s = await get(short.id);
    expect(s.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(s.sharedText).toBe('Watch this! https://bit.ly/abc');
    expect(s.source).toBe('youtube');
    expect((await get(normal.id)).url).toBe('https://example.com/a');
  });

  it('gets the map pin from a short maps link, then fills in its city and country', async () => {
    const item = await save({ type: 'place', url: 'https://maps.app.goo.gl/xyz', title: 'Hot Clube de Portugal' });
    preview.mockResolvedValue({ finalUrl: 'https://www.google.com/maps/place/Hot+Clube+de+Portugal/@38.7189,-9.1446,17z' });
    reverse.mockResolvedValue({ name: 'Somewhere next door', city: 'Lisbon', country: 'Portugal', countryCode: 'PT', address: 'Praça da Alegria 48, Lisbon, Portugal' });
    await enrichItem(item.id, GUESSED);
    const saved = await get(item.id);
    expect(saved.url).toContain('/maps/place/');
    expect(saved.place).toMatchObject({ lat: 38.7189, lng: -9.1446, name: 'Hot Clube de Portugal', city: 'Lisbon', countryCode: 'PT' });
  });
});

describe('enrichItem: place details', () => {
  it('fills in missing details without overwriting the name', async () => {
    const item = await save({ type: 'place', title: 'My spot', place: { lat: 38.7, lng: -9.14, name: 'My spot' } });
    reverse.mockResolvedValue({ name: 'A neighbour', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).place).toEqual({ lat: 38.7, lng: -9.14, name: 'My spot', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
  });

  it('works for saves without a link too', async () => {
    const item = await addItem({ type: 'place', title: 'Pin', place: { lat: 38.7, lng: -9.14 } });
    reverse.mockResolvedValue({ city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    await enrichItem(item.id, GUESSED);
    expect(preview).not.toHaveBeenCalled();
    expect((await get(item.id)).place?.countryCode).toBe('PT');
  });

  it("doesn't write when the location changed during the lookup", async () => {
    const item = await save({ type: 'place', place: { lat: 38.7, lng: -9.14 } });
    const moved = { lat: 51.5, lng: -0.12, name: 'Elsewhere' };
    reverse.mockImplementation(async () => {
      await db.items.update(item.id, { place: moved });
      return { city: 'Lisbon', country: 'Portugal', countryCode: 'PT' };
    });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).place).toEqual(moved);
  });

  it('skips the lookup when details are complete', async () => {
    const item = await save({ type: 'place', place: { lat: 38.7, lng: -9.14, city: 'Lisbon', country: 'Portugal', countryCode: 'PT' } });
    await enrichItem(item.id, GUESSED);
    expect(reverse).not.toHaveBeenCalled();
  });
});

describe('enrichItem: auto-locate', () => {
  it('finds an event from an explicit 📍 marker', async () => {
    const item = await save({ type: 'event', title: 'Jazz night', sharedText: 'Jazz night 🎷\n📍 Hot Clube de Portugal, Lisbon\n#jazz' });
    search.mockResolvedValue([lisbonResult]);
    await enrichItem(item.id, GUESSED);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe('Hot Clube de Portugal, Lisbon');
    expect((await get(item.id)).place).toEqual({ lat: 38.7189, lng: -9.1446, name: 'Hot Clube de Portugal', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
  });

  it("doesn't let a date on the marker line spoil the search", async () => {
    const { label } = futureDate();
    const item = await save({ type: 'event', title: 'Jazz night', note: `📍 Lisbon — ${label}` });
    search.mockResolvedValue([{ lat: 38.72, lng: -9.14, name: 'Lisbon', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' }]);
    await enrichItem(item.id, GUESSED);
    expect(search.mock.calls[0][0]).toBe('Lisbon');
  });

  it('rejects a result in the wrong country', async () => {
    const item = await save({ type: 'event', title: 'Gig', sharedText: 'Location: Lisbon' });
    search.mockResolvedValue([{ lat: 44.03, lng: -70.1, name: 'Lisbon', city: 'Lisbon', country: 'United States', countryCode: 'US' }]);
    await enrichItem(item.id, GUESSED);
    expect(search).toHaveBeenCalled();
    expect((await get(item.id)).place).toBeUndefined();
  });

  it('files an event that only names its city under that city, in the right country', async () => {
    const item = await save({ type: 'event', title: 'Best gigs in Lisbon this year', sharedText: 'Best gigs in Lisbon this year' });
    search.mockResolvedValue([
      { lat: 44.03, lng: -70.1, name: 'Lisbon', city: 'Lisbon', country: 'United States', countryCode: 'US' },
      { lat: 38.72, lng: -9.14, name: 'Lisboa', city: 'Lisboa', country: 'Portugal', countryCode: 'PT', address: 'Lisboa, Portugal' },
    ]);
    await enrichItem(item.id, GUESSED);
    expect(search.mock.calls.map((c) => c[0])).toEqual(['Lisbon']);
    expect((await get(item.id)).place).toEqual({ lat: 38.72, lng: -9.14, name: 'Lisbon', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    // No reverse lookup for a whole city: its centre would give a random street.
    expect(reverse).not.toHaveBeenCalled();
  });

  it('ignores passing mentions on other kinds', async () => {
    const recipe = await save({ type: 'recipe', title: 'Custard tarts', sharedText: 'Custard tarts like the ones in Lisbon' });
    const video = await save({ type: 'video', title: 'Funny cats', sharedText: 'Funny cats from Lisbon' });
    await enrichItem(recipe.id, GUESSED);
    await enrichItem(video.id, GUESSED);
    expect(search).not.toHaveBeenCalled();
  });

  it('finds a pinned venue on any kind of save, and a generic kind becomes a place', async () => {
    const item = await save({ type: 'video', url: 'https://www.instagram.com/reel/AbC123/', title: 'Instagram reel', sharedText: '' });
    const caption = 'Late-night fado and the best custard tarts\n📍 Hot Clube de Portugal, Lisbon';
    preview.mockResolvedValue({ title: 'Late-night fado and the best custard tarts', description: caption, caption });
    search.mockResolvedValue([lisbonResult]);
    await enrichItem(item.id, { replaceTitle: true, reclassify: true });
    const saved = await get(item.id);
    expect(search.mock.calls[0][0]).toBe('Hot Clube de Portugal, Lisbon');
    expect(saved.place?.countryCode).toBe('PT');
    expect(saved.type).toBe('place');
    expect(saved.analyzed).toBe(ANALYSIS_VERSION);
  });

  it('falls back to the area when the pinned venue is not found, and asks at most twice', async () => {
    const item = await save({ type: 'video', title: 'Instagram reel', note: '📍 Café Imaginário, Kyoto\nOur favourite matcha in Kyoto, Japan' });
    search.mockResolvedValueOnce([]).mockResolvedValueOnce([{ lat: 35.01, lng: 135.77, name: '京都市', city: '京都市', country: '日本', countryCode: 'JP' }]);
    await enrichItem(item.id, GUESSED);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0]).toBe('Kyoto');
    expect((await get(item.id)).place).toMatchObject({ name: 'Kyoto', city: 'Kyoto', countryCode: 'JP' });
  });

  it("doesn't file a save under a country it names only in passing", async () => {
    search.mockImplementation(async (q: string) => {
      const code = /manchester/i.test(q) ? 'GB' : /hong kong|香港/i.test(q) ? 'HK' : /paris/i.test(q) ? 'FR' : /taipei|台北/i.test(q) ? 'TW' : /madrid/i.test(q) ? 'ES' : /lisbon/i.test(q) ? 'PT' : undefined;
      return code ? [{ lat: 1, lng: 2, name: q, country: code, countryCode: code }] : [];
    });
    const cafe = await save({ type: 'place', title: 'Hong Kong style cafe in Manchester' });
    const branch = await save({ type: 'place', title: '香港style茶餐廳 喺台北開分店' });
    const dj = await save({ type: 'event', title: 'Paris Hilton DJ set this Saturday' });
    const either = await save({ type: 'event', title: 'Lisbon or Madrid this weekend?' });
    for (const item of [cafe, branch, dj, either]) await enrichItem(item.id, { replaceTitle: false, reclassify: false });
    expect((await get(cafe.id)).place?.countryCode).toBe('GB');
    expect((await get(branch.id)).place?.countryCode).toBe('TW');
    expect((await get(dj.id)).place).toBeUndefined();
    expect((await get(either.id)).place).toBeUndefined();
    expect(search.mock.calls.map((c) => c[0])).toEqual(['Manchester', '台北']);
  });

  it("stays on the list of places to look up when the lookup never went out, so it's tried again later", async () => {
    const item = await save({ type: 'event', sharedText: '📍 Hot Clube de Portugal, Lisbon' });
    geoState.report = { asked: false, troubled: false };
    search.mockRejectedValue(Object.assign(new Error('paused'), { name: 'GeoPausedError' }));
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).locatePending).toBe(true);
    // Asked and nothing found: settled.
    geoState.report = { asked: true, troubled: false };
    search.mockResolvedValue([]);
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).locatePending).toBeUndefined();
    expect((await get(item.id)).place).toBeUndefined();
  });

  it('searches a venue-like page title for place saves, qualified by the hint', async () => {
    const item = await save({ type: 'place', title: 'Instagram post', sharedText: 'Bombay café in London' });
    preview.mockResolvedValue({ title: 'Dishoom Covent Garden' });
    search.mockResolvedValue([{ lat: 51.5124, lng: -0.1269, name: 'Dishoom', city: 'London', country: 'United Kingdom', countryCode: 'GB' }]);
    await enrichItem(item.id, GUESSED);
    expect(search.mock.calls[0][0]).toBe('Dishoom Covent Garden, London');
    expect((await get(item.id)).place?.countryCode).toBe('GB');
  });

  it('leaves other types, located saves and user choices alone', async () => {
    const recipe = await save({ type: 'recipe', sharedText: 'Custard tarts, the Lisbon way' });
    const placed = await save({ type: 'event', sharedText: '📍 Lisbon', place: { lat: 1, lng: 1, city: 'X', country: 'Portugal', countryCode: 'PT' } });
    const cleared = await save({ type: 'event', sharedText: '📍 Lisbon' });
    await enrichItem(recipe.id, GUESSED);
    await enrichItem(placed.id, GUESSED);
    await enrichItem(cleared.id, { ...GUESSED, locate: false });
    expect(search).not.toHaveBeenCalled();
    expect((await get(cleared.id)).place).toBeUndefined();
  });

  it('fails quietly when the search does', async () => {
    const item = await save({ type: 'event', sharedText: '📍 Lisbon' });
    search.mockRejectedValue(new Error("You're offline — place search needs a connection."));
    await expect(enrichItem(item.id, GUESSED)).resolves.toBe(false);
    expect((await get(item.id)).place).toBeUndefined();
  });
});

describe('saveShared (capture)', () => {
  it('keeps the original text and a clear date, without the explanation fields', async () => {
    const { label, iso } = futureDate();
    const item = await saveShared({ text: `Jazz night ${label} 9pm 📍 Lisbon https://www.instagram.com/p/abc123/` });
    expect(item.sharedText).toContain('Jazz night');
    expect(item.when?.start).toBe(`${iso}T21:00`);
    expect(['reasons', 'confidence', 'alternatives', 'author'].some((k) => k in item)).toBe(false);
  });

  it('leaves loose dates for the user to confirm, unless it is an event', async () => {
    expect((await saveShared({ text: 'Call mum this Saturday' })).when).toBeUndefined();
    expect((await saveShared({ text: 'Call mum this Saturday' }, { type: 'event' })).when).toBeDefined();
  });
});

describe('helpers', () => {
  it('spots venue-like titles', () => {
    expect(looksLikeVenue('Dishoom Covent Garden')).toBe(true);
    expect(looksLikeVenue('Tasca do Chico')).toBe(true);
    expect(looksLikeVenue('Myrtle Café')).toBe(true);
    expect(looksLikeVenue('Best ramen in Tokyo')).toBe(false);
    expect(looksLikeVenue('you have to try this place!!')).toBe(false);
    expect(looksLikeVenue('Top 10 things to do in Lisbon')).toBe(false);
    expect(looksLikeVenue(undefined)).toBe(false);
  });

  it('keeps dates out of location hints', () => {
    expect(locationHints(`📍 Lisbon — ${futureDate().label}`)[0]).toBe('Lisbon');
    expect(locationHints('')).toEqual([]);
  });
});

describe('enrichItem: other sites', () => {
  it("never takes a page's publishing date for a posting day", async () => {
    const day = toLocalIso(new Date());
    const item = await save({ type: 'event', title: 'Jazz tonight', url: 'https://venue.example.com/jazz', sharedText: 'Jazz tonight 8pm! https://venue.example.com/jazz', when: { start: `${day}T20:00`, source: 'tonight 8pm' } });
    preview.mockResolvedValue({ title: 'Live Jazz at the Blue Room', description: 'Live jazz every week in the back room.', publishedAt: `${day}T09:12:00.000Z`, siteName: 'Blue Room' });
    await enrichItem(item.id, { replaceTitle: false, reclassify: true });
    expect((await get(item.id)).when).toEqual({ start: `${day}T20:00`, source: 'tonight 8pm' });
  });

  it('says why no preview came back', async () => {
    const item = await save({});
    const heard: string[] = [];
    preview.mockResolvedValue({ problem: 'timeout' });
    expect(await enrichItem(item.id, { ...REFRESH_OPTIONS, onProblem: (p) => heard.push(p) })).toBe(false);
    preview.mockResolvedValue({ title: 'A page' });
    await enrichItem(item.id, { ...REFRESH_OPTIONS, onProblem: (p) => heard.push(p) });
    expect(heard).toEqual(['timeout']);
  });
});

describe('enrichItem: refresh preview', () => {
  it('brings back neither a date nor a place the user removed', async () => {
    const { label } = futureDate();
    const item = await save({ type: 'event', url: 'https://www.google.com/maps/place/Hot+Clube/@38.7189,-9.1446,17z', sharedText: `Jazz night ${label} 9pm 📍 Hot Clube de Portugal, Lisbon` });
    preview.mockResolvedValue({ title: 'Jazz night', description: `Jazz night ${label}, 9pm`, finalUrl: 'https://www.google.com/maps/place/Hot+Clube/@38.7189,-9.1446,17z' });
    search.mockResolvedValue([lisbonResult]);
    expect(await enrichItem(item.id, REFRESH_OPTIONS)).toBe(true);
    const after = await get(item.id);
    expect(after.when).toBeUndefined();
    expect(after.place).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  it('says when no preview came back (offline), and still updates the image when one did', async () => {
    const item = await save({});
    preview.mockResolvedValue({});
    expect(await enrichItem(item.id, REFRESH_OPTIONS)).toBe(false);
    preview.mockResolvedValue({ image: 'https://i.ytimg.com/vi/x/hqdefault.jpg' });
    expect(await enrichItem(item.id, REFRESH_OPTIONS)).toBe(false);
    preview.mockResolvedValue({ title: 'Page', image: 'https://img.example/new.jpg' });
    expect(await enrichItem(item.id, REFRESH_OPTIONS)).toBe(true);
    expect((await get(item.id)).image).toBe('https://img.example/new.jpg');
    setSettings({ previews: false });
    expect(await enrichItem(item.id, REFRESH_OPTIONS)).toBe(false);
  });
});

describe('Instagram share links', () => {
  it('are short links, resolved even through the login wall', () => {
    const share = 'https://www.instagram.com/share/p/BAAbCdEfGh';
    expect(isShortLink(share)).toBe(true);
    expect(isShortLink('https://www.instagram.com/p/DAbCdEfGhIj/')).toBe(false);
    expect(resolvedShortLink(share, 'https://www.instagram.com/p/DAbCdEfGhIj/?igsh=x')).toBe('https://www.instagram.com/p/DAbCdEfGhIj/?igsh=x');
    expect(resolvedShortLink(share, 'https://www.instagram.com/accounts/login/?next=%2Fp%2FDAbCdEfGhIj%2F')).toBe('https://www.instagram.com/p/DAbCdEfGhIj/');
  });

  it('never follows a login wall to another site', () => {
    const share = 'https://www.instagram.com/share/p/BAAbCdEfGh';
    expect(resolvedShortLink(share, 'https://www.instagram.com/accounts/login/?next=https%3A%2F%2Fevil.example%2Fp%2Fx')).toBeUndefined();
    expect(resolvedShortLink(share, 'https://www.instagram.com/accounts/login/?next=%2F%2Fevil.example%2F')).toBeUndefined();
    expect(resolvedShortLink(share, 'https://www.instagram.com/accounts/login/')).toBeUndefined();
  });
});

describe('enrichItem: geo priority and back-off', () => {
  it('does its place lookups as background work', async () => {
    const item = await save({ type: 'event', sharedText: '📍 Hot Clube de Portugal, Lisbon' });
    search.mockResolvedValue([{ ...lisbonResult, city: undefined }]);
    await enrichItem(item.id, GUESSED);
    expect(search.mock.calls[0][2]).toMatchObject({ priority: 'background' });
    // resolvePlaceDetails only passes a signal on: a background one.
    expect(backgroundSignal).toHaveBeenCalled();
    expect(vi.mocked(backgroundSignal).mock.results.map((r) => r.value)).toContain(reverse.mock.calls[0][2]?.signal);
  });

  it('writes a found place and its details in one go', async () => {
    const item = await save({ type: 'event', sharedText: '📍 Hot Clube de Portugal, Lisbon' });
    search.mockResolvedValue([{ lat: 38.7189, lng: -9.1446, name: 'Hot Clube de Portugal', countryCode: 'PT' }]);
    reverse.mockResolvedValue({ city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    const update = vi.spyOn(db.items, 'update');
    await enrichItem(item.id, GUESSED);
    // The place is written once, with its details (the save is only listed for a lookup before that).
    const places = update.mock.calls.filter(([, changes]) => 'place' in (changes as object));
    expect(places).toHaveLength(1);
    expect((await get(item.id)).place).toEqual({ lat: 38.7189, lng: -9.1446, name: 'Hot Clube de Portugal', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    expect((await get(item.id)).locatePending).toBeUndefined();
    update.mockRestore();
  });

  it('skips place work quietly while background lookups are paused', async () => {
    geoState.paused = true;
    const pinned = await save({ type: 'place', place: { lat: 38.7, lng: -9.14 } });
    const marked = await save({ type: 'event', sharedText: '📍 Lisbon' });
    preview.mockResolvedValue({ title: 'Page', image: 'https://img.example/a.jpg' });
    expect(await enrichItem(pinned.id, GUESSED)).toBe(true);
    await enrichItem(marked.id, GUESSED);
    expect(search).not.toHaveBeenCalled();
    expect(reverse).not.toHaveBeenCalled();
    // The preview itself still lands.
    expect((await get(pinned.id)).image).toBe('https://img.example/a.jpg');
  });

  it("uses the user's priority and signal when someone is waiting (Refresh preview)", async () => {
    const ctrl = new AbortController();
    const item = await save({ type: 'place', place: { lat: 38.7, lng: -9.14 } });
    reverse.mockResolvedValue({ city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    geoState.paused = true; // never holds up a user lookup
    await enrichItem(item.id, { ...REFRESH_OPTIONS, priority: 'user', signal: ctrl.signal });
    expect(backgroundSignal).not.toHaveBeenCalled();
    expect(reverse.mock.calls[0][2]?.signal).toBe(ctrl.signal);
    expect((await get(item.id)).place?.countryCode).toBe('PT');
  });

  it('can resolve after the preview and finish the place quietly', async () => {
    const item = await save({ type: 'place', place: { lat: 38.7, lng: -9.14 } });
    preview.mockResolvedValue({ title: 'Page' });
    let answer!: (p: { city: string; country: string; countryCode: string }) => void;
    reverse.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    expect(await enrichItem(item.id, { ...REFRESH_OPTIONS, waitForPlace: false })).toBe(true);
    await vi.waitFor(() => expect(reverse).toHaveBeenCalled());
    expect((await get(item.id)).place?.countryCode).toBeUndefined();
    answer({ city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    await vi.waitFor(async () => expect((await get(item.id)).place?.countryCode).toBe('PT'));
  });

  it('writes nothing once cancelled', async () => {
    const ctrl = new AbortController();
    const item = await save({ type: 'place', place: { lat: 38.7, lng: -9.14 } });
    preview.mockImplementation(async () => {
      ctrl.abort(); // the user left while the preview loaded
      return { title: 'Page', image: 'https://img.example/a.jpg' };
    });
    expect(await enrichItem(item.id, { ...REFRESH_OPTIONS, priority: 'user', signal: ctrl.signal })).toBe(false);
    expect(preview.mock.calls[0][1]).toBe(ctrl.signal);
    expect(reverse).not.toHaveBeenCalled();
    expect(await get(item.id)).toEqual(item);
  });
});

describe('enrichItem: social posts', () => {
  const reel = 'https://www.instagram.com/reel/AbC123xyz/';
  const caption = 'Sunday market finds 🧺 fresh figs and the best sourdough\n📍 Borough Market, London\n#market #london';
  const post: LinkPreview = {
    title: 'Sunday market finds 🧺 fresh figs and the best sourdough',
    rawTitle: caption.replace(/\s+/g, ' '),
    description: caption,
    caption,
    image: 'https://scontent.cdninstagram.com/v/t51/123.jpg?oe=6A000000',
    siteName: 'Instagram',
    author: 'Mei Chan',
    publishedAt: '2026-03-05T00:00:00.000Z',
    type: 'video',
  };

  it('titles a reel from its caption, stores the author and keeps a copy of the picture', async () => {
    const item = await save({ type: 'video', url: reel, title: 'Instagram reel', source: 'instagram' });
    preview.mockResolvedValue(post);
    search.mockResolvedValue([{ lat: 51.5055, lng: -0.091, name: 'Borough Market', city: 'London', country: 'United Kingdom', countryCode: 'GB' }]);
    await enrichItem(item.id, GUESSED);
    const saved = await get(item.id);
    expect(saved.title).toBe('Sunday market finds 🧺 fresh figs and the best sourdough');
    expect(saved.author).toBe('Mei Chan');
    expect(saved.type).toBe('place');
    expect(saved.place?.name).toBe('Borough Market');
    expect(saved.when).toBeUndefined();
    expect(keepThumb).toHaveBeenCalledWith(item.id, post.image);
  });

  it('replaces an account-name title on "Refresh preview", but never one the user typed', async () => {
    const auto = await save({ type: 'video', url: reel, title: 'Mei Chan (@mei.eats) • Instagram reel' });
    const mine = await save({ type: 'video', url: reel, title: 'Figs for Sunday' });
    preview.mockResolvedValue(post);
    await enrichItem(auto.id, { ...REFRESH_OPTIONS, priority: 'user' });
    await enrichItem(mine.id, { ...REFRESH_OPTIONS, priority: 'user' });
    expect((await get(auto.id)).title).toBe('Sunday market finds 🧺 fresh figs and the best sourdough');
    expect((await get(mine.id)).title).toBe('Figs for Sunday');
    // Someone is waiting: asked even if the preview service's daily allowance is used up.
    expect(preview.mock.calls[0][2]).toEqual({ force: true });
  });

  it("drops a date that is only the day the post went up, and takes the caption's own", async () => {
    const { label, iso } = futureDate(30);
    const item = await save({ type: 'event', url: reel, title: 'Instagram reel', when: { start: '2026-03-05' } });
    const text = `Pop-up market ${label}`;
    preview.mockResolvedValue({ ...post, description: text, caption: text, title: 'Pop-up market', rawTitle: text });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).when?.start).toBe(iso);
    // A date the user set is kept.
    const mine = await save({ type: 'event', url: reel, title: 'Instagram reel', when: { start: '2026-03-07' } });
    await enrichItem(mine.id, GUESSED);
    expect((await get(mine.id)).when).toEqual({ start: '2026-03-07' });
  });

  it('keeps a title the user typed, even when it names the creator', async () => {
    const typed = await save({ type: 'video', url: reel, title: 'Mei Chan' });
    const refreshed = await save({ type: 'video', url: reel, title: 'Mei Chan' });
    preview.mockResolvedValue({ ...post, title: 'Mei Chan (@mei.eats) • Instagram reel', rawTitle: 'Mei Chan (@mei.eats) • Instagram reel', caption: undefined, description: '1,234 likes, 5 comments - mei.eats on March 5, 2026: "Crispy smash burgers at home"' });
    await enrichItem(typed.id, { replaceTitle: false, reclassify: false });
    await enrichItem(refreshed.id, { ...REFRESH_OPTIONS, priority: 'user' });
    expect((await get(typed.id)).title).toBe('Mei Chan');
    expect((await get(refreshed.id)).title).toBe('Mei Chan');
  });

  it('leaves what the user picked in the save sheet: kind, tags, date', async () => {
    const item = await save({ type: 'video', url: reel, title: 'Instagram reel', tags: ['mine'], edited: ['type', 'tags', 'when'] });
    preview.mockResolvedValue(post);
    await enrichItem(item.id, GUESSED);
    expect(await get(item.id)).toMatchObject({ type: 'video', tags: ['mine'], title: post.title });
  });

  it('keeps an event date the caption gives for the day the post went up', async () => {
    const today = new Date();
    const day = toLocalIso(today);
    const item = await save({ type: 'event', url: reel, title: 'Saved link', when: { start: `${day}T21:00`, source: 'Tonight 9pm' } });
    const text = 'Tonight 9pm: DJ set with friends, free entry';
    preview.mockResolvedValue({ ...post, title: text, rawTitle: text, description: text, caption: text, publishedAt: `${day}T00:00:00.000Z` });
    await enrichItem(item.id, GUESSED);
    expect((await get(item.id)).when).toEqual({ start: `${day}T21:00`, source: 'Tonight 9pm' });
  });

  it('marks a save analysed when there is nothing to look up, and asks the preview service normally in the background', async () => {
    const item = await save({ type: 'video', url: reel, title: 'Instagram reel' });
    const stretch = 'Five-minute stretch for desk days';
    preview.mockResolvedValue({ ...post, title: stretch, rawTitle: stretch, description: stretch, caption: stretch, image: undefined });
    await enrichItem(item.id, GUESSED);
    const saved = await get(item.id);
    expect(saved.analyzed).toBe(ANALYSIS_VERSION);
    expect(search).not.toHaveBeenCalled();
    expect(keepThumb).not.toHaveBeenCalled();
    expect(preview.mock.calls[0][2]).toEqual({ force: false });
  });
});
