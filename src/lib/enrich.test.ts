import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./metadata', () => ({ fetchPreview: vi.fn() }));
vi.mock('./geo', () => ({ searchPlaces: vi.fn(), reverseGeocode: vi.fn() }));

import { addItem, db, saveShared, type NewItem } from './db';
import { enrichItem, isShortLink, locationHints, looksLikeVenue, REFRESH_OPTIONS, resolvedShortLink, type EnrichOptions } from './enrich';
import { reverseGeocode, searchPlaces, type GeoResult } from './geo';
import { fetchPreview, type LinkPreview } from './metadata';
import { setSettings } from './settings';
import type { Item } from './types';
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

  it('ignores passing mentions without a marker', async () => {
    const item = await save({ type: 'event', title: 'Best gigs in Lisbon this year', sharedText: 'Best gigs in Lisbon this year' });
    await enrichItem(item.id, GUESSED);
    expect(search).not.toHaveBeenCalled();
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
    const recipe = await save({ type: 'recipe', sharedText: '📍 Lisbon' });
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
