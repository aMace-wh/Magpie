import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const geoState = vi.hoisted(() => ({
  paused: false,
  troubles: 0,
  reports: new WeakMap<AbortSignal, { asked: boolean; troubled: boolean }>(),
}));
vi.mock('./geo', () => ({
  searchPlaces: vi.fn(),
  reverseGeocode: vi.fn(),
  geoHealth: () => ({ paused: geoState.paused, troubles: geoState.troubles, userBusy: false }),
  backgroundSignal: vi.fn(() => new AbortController().signal),
  whenUserIdle: vi.fn(async () => undefined),
  lookupReport: (signal: AbortSignal) => geoState.reports.get(signal) ?? { asked: false, troubled: false },
}));

import { backfillPlaceDetails, resetBackfillState } from './backfill';
import { addItem, db } from './db';
import { backgroundSignal, reverseGeocode, whenUserIdle } from './geo';
import { setSettings } from './settings';
import type { Place } from './types';

const reverse = vi.mocked(reverseGeocode);
const idle = vi.mocked(whenUserIdle);
const PT = { city: 'Lisbon', country: 'Portugal', countryCode: 'PT' };
const TRIED_KEY = 'magpie:place-details-tried';

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
const triedIds = () => Object.keys(JSON.parse(storage.getItem(TRIED_KEY) ?? '{}') as Record<string, number>);

/** A reverse lookup that went out and came back with `result` (or timed out, with `troubled`). */
const answer =
  (result: Partial<Place> | undefined, troubled = false) =>
  async (_lat: number, _lng: number, opts?: { signal?: AbortSignal }) => {
    if (troubled) geoState.troubles++;
    if (opts?.signal) geoState.reports.set(opts.signal, { asked: true, troubled });
    return result;
  };

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
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  geoState.paused = false;
  geoState.troubles = 0;
  resetBackfillState();
  setSettings({ previews: true });
  reverse.mockImplementation(answer(PT));
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
    reverse.mockImplementation(answer(undefined));
    expect(await backfillPlaceDetails()).toBe(0);
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it('rests a spot that was asked about and had nothing there, and moves on to the next', async () => {
    const empty = await bare(1);
    await bare(2);
    reverse.mockImplementationOnce(answer(undefined));
    expect(await backfillPlaceDetails()).toBe(1);
    expect(triedIds()).toEqual([empty]);
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

  it('asks as background work', async () => {
    await bare(1);
    await backfillPlaceDetails();
    expect(backgroundSignal).toHaveBeenCalled();
    expect(reverse.mock.calls[0][2]?.signal).toBe(vi.mocked(backgroundSignal).mock.results[0].value);
  });

  it('saves each "tried" mark before asking, so a relaunch mid-run skips that spot', async () => {
    const first = await bare(1);
    await bare(2);
    // The app is closed while the first lookup hangs.
    reverse.mockImplementationOnce(() => new Promise(() => {}));
    void backfillPlaceDetails();
    await vi.waitFor(() => expect(reverse).toHaveBeenCalledTimes(1));
    expect(triedIds()).toEqual([first]);

    // Next launch: the hanging spot is left alone, the next one is filled in.
    resetBackfillState();
    reverse.mockImplementation(answer(PT));
    expect(await backfillPlaceDetails()).toBe(1);
    expect(reverse.mock.calls.map((c) => c[0])).toEqual([39, 40]);
    // Resolved spots don't keep a mark; only the one that never answered does.
    expect(triedIds()).toEqual([first]);
  });

  it('stops at the first timeout or network error and keeps that spot resting', async () => {
    const first = await bare(1);
    await bare(2);
    await bare(3);
    reverse.mockImplementationOnce(answer(undefined, true)); // timed out
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(triedIds()).toEqual([first]);

    // Next launch picks up where it left off.
    resetBackfillState();
    expect(await backfillPlaceDetails()).toBe(2);
    expect(reverse.mock.calls.map((c) => c[0])).toEqual([39, 40, 41]);
  });

  it("doesn't count a spot as tried when the lookup never went out (offline, paused)", async () => {
    const id = await bare(1);
    reverse.mockImplementationOnce(async () => {
      geoState.paused = true; // another lookup tripped the breaker; this one was dropped
      return undefined;
    });
    expect(await backfillPlaceDetails()).toBe(0);
    expect(triedIds()).toEqual([]);

    geoState.paused = false;
    resetBackfillState();
    expect(await backfillPlaceDetails()).toBe(1);
    expect((await db.items.get(id))?.place).toMatchObject(PT);
  });

  it("doesn't rest a spot whose lookup was dropped when other lookups' failures paused them", async () => {
    const id = await bare(1);
    await bare(2);
    reverse.mockImplementationOnce(async () => {
      // Two enrichment lookups failed meanwhile and tripped the breaker; this one never went out.
      geoState.troubles += 2;
      geoState.paused = true;
      return undefined;
    });
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(triedIds()).toEqual([]);

    geoState.paused = false;
    resetBackfillState();
    expect(await backfillPlaceDetails()).toBe(2);
    expect((await db.items.get(id))?.place).toMatchObject(PT);
  });

  it('does nothing while background lookups are paused', async () => {
    await bare(1);
    geoState.paused = true;
    expect(await backfillPlaceDetails()).toBe(0);
    expect(reverse).not.toHaveBeenCalled();
  });

  it("waits for the user's own lookups first", async () => {
    await bare(1);
    let wake!: () => void;
    idle.mockImplementationOnce(() => new Promise<void>((resolve) => (wake = resolve)));
    const run = backfillPlaceDetails();
    await new Promise((r) => setTimeout(r, 20));
    expect(reverse).not.toHaveBeenCalled();
    wake();
    expect(await run).toBe(1);
    expect(idle).toHaveBeenCalledTimes(2); // before starting, and before each lookup
  });
});
