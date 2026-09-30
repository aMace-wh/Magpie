import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./geo', () => ({ searchPlaces: vi.fn(), reverseGeocode: vi.fn() }));

import { backfillPlaceDetails, resetBackfillState } from './backfill';
import { addItem, db } from './db';
import { reverseGeocode } from './geo';
import { setSettings } from './settings';
import type { Place } from './types';

const reverse = vi.mocked(reverseGeocode);
const PT = { city: 'Lisbon', country: 'Portugal', countryCode: 'PT' };

/** A save whose place is bare coordinates, created `order` ms apart so "oldest first" is well defined. */
async function bare(order: number, place: Partial<Place> = {}) {
  const item = await addItem({ type: 'place', title: `Spot ${order}`, place: { lat: 38 + order, lng: -9.14, ...place } });
  await db.items.update(item.id, { createdAt: 1000 + order });
  return item.id;
}

beforeEach(async () => {
  await db.items.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetBackfillState();
  setSettings({ previews: true });
  reverse.mockResolvedValue(PT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSettings({ previews: true });
});

describe('backfillPlaceDetails', () => {
  it('fills in missing details, oldest first, up to the limit', async () => {
    const ids = [await bare(3), await bare(1), await bare(2)];
    const done = await backfillPlaceDetails({ limit: 2 });
    expect(done).toBe(2);
    expect(reverse).toHaveBeenCalledTimes(2);
    expect(reverse.mock.calls.map((c) => c[0])).toEqual([39, 40]);
    const [newest, oldest, middle] = await Promise.all(ids.map((id) => db.items.get(id)));
    expect(oldest?.place).toMatchObject(PT);
    expect(middle?.place).toMatchObject(PT);
    expect(newest?.place?.countryCode).toBeUndefined();
  });

  it('skips saves that are complete, have no place, or whose place moved during the lookup', async () => {
    await addItem({ type: 'note', title: 'No place' });
    await addItem({ type: 'place', title: 'Done', place: { lat: 1, lng: 2, ...PT } });
    const moving = await bare(1);
    const moved: Place = { lat: 51.5, lng: -0.12, name: 'Elsewhere' };
    reverse.mockImplementationOnce(async () => {
      await db.items.update(moving, { place: moved });
      return PT;
    });
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).toHaveBeenCalledTimes(1);
    expect((await db.items.get(moving))?.place).toEqual(moved);
  });

  it('never overwrites details that are there', async () => {
    const id = await bare(1, { name: 'My favourite bench', city: 'Belém' });
    reverse.mockResolvedValue({ name: 'Somewhere else', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    await backfillPlaceDetails();
    expect((await db.items.get(id))?.place).toMatchObject({ name: 'My favourite bench', city: 'Belém', countryCode: 'PT', country: 'Portugal' });
  });

  it('shares one run between concurrent calls', async () => {
    await bare(1);
    await bare(2);
    const [a, b] = [backfillPlaceDetails(), backfillPlaceDetails()];
    expect(a).toBe(b);
    expect(await a).toBe(2);
    expect(reverse).toHaveBeenCalledTimes(2);
  });

  it("doesn't ask twice in one session for a spot that can't be resolved", async () => {
    await bare(1);
    reverse.mockResolvedValue(undefined);
    expect(await backfillPlaceDetails()).toBe(0);
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it('does nothing with link previews off', async () => {
    const id = await bare(1);
    setSettings({ previews: false });
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).not.toHaveBeenCalled();
    expect((await db.items.get(id))?.place?.countryCode).toBeUndefined();
  });

  it('does nothing offline', async () => {
    await bare(1);
    vi.stubGlobal('navigator', { onLine: false });
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).not.toHaveBeenCalled();
  });
});
