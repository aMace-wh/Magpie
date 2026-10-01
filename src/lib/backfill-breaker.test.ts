import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillPlaceDetails, resetBackfillState } from './backfill';
import { addItem, db } from './db';
import { geoHealth, resetGeoState, searchPlaces } from './geo';

// Backfill with the real geo queue: whether a spot "rests" for a day must depend on its own lookup, not on
// other lookups that failed around it.

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

afterEach(async () => {
  vi.unstubAllGlobals();
  resetGeoState();
  resetBackfillState();
  await db.items.clear();
});

describe('backfill and the breaker', () => {
  it("doesn't rest a spot whose lookup was dropped because enrichment lookups tripped the breaker", async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string) => {
        urls.push(String(u));
        throw new TypeError('Failed to fetch');
      }),
    );
    const item = await addItem({ title: 'Spot', type: 'note', place: { lat: 38.7, lng: -9.1 } });
    // Two background lookups (enrichment of two fresh saves) that can't reach the service.
    const a = searchPlaces('a', undefined, { priority: 'background' }).catch((e: unknown) => e);
    const b = searchPlaces('b', undefined, { priority: 'background' }).catch((e: unknown) => e);
    const run = backfillPlaceDetails();
    await Promise.all([a, b]);
    expect(await run).toBe(0);
    expect(geoHealth().paused).toBe(true);
    expect(urls.some((u) => u.includes('/reverse'))).toBe(false);
    const tried = JSON.parse(localStorage.getItem('magpie:place-details-tried') ?? '{}') as Record<string, number>;
    expect(tried[item.id]).toBeUndefined();
  }, 10000);
});
