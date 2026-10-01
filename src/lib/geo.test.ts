import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addressDetails,
  backgroundSignal,
  BREAKER_PAUSE_MS,
  geoHealth,
  holdBackgroundLookups,
  LOOKUP_TIMEOUT_MS,
  lookupReport,
  NOMINATIM_GAP_MS,
  resetGeoState,
  reverseGeocode,
  searchPlaces,
  whenUserIdle,
} from './geo';

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

const calledUrl = (i = 0) => new URL(String(fetchMock.mock.calls[i][0]));
const calledHeaders = (i = 0) => (fetchMock.mock.calls[i][1] as RequestInit).headers as Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  resetGeoState();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const LISBON_ROWS = [
  {
    lat: '38.7077',
    lon: '-9.1365',
    name: 'Time Out Market',
    display_name: 'Time Out Market, Avenida 24 de Julho, Cais do Sodré, Lisboa, 1200-479, Portugal',
    address: { amenity: 'Time Out Market', city: 'Lisboa', country: 'Portugal', country_code: 'pt' },
  },
  {
    lat: '41.1496',
    lon: '-8.6109',
    name: '',
    display_name: '24, Rua das Flores, Porto, Portugal',
    address: { town: 'Porto', county: 'Área Metropolitana do Porto', country: 'Portugal', country_code: 'pt' },
  },
  { lat: 'nope', lon: '1', display_name: 'Broken row' },
];

describe('searchPlaces', () => {
  it('asks for address details and maps rows to full places', async () => {
    fetchMock.mockResolvedValue(json(LISBON_ROWS));
    const results = await searchPlaces('time out market lisbon');

    const url = calledUrl();
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(url.searchParams.get('addressdetails')).toBe('1');
    expect(url.searchParams.get('q')).toBe('time out market lisbon');
    expect(url.searchParams.get('format')).toBe('jsonv2');

    expect(results).toHaveLength(2); // the row without valid coordinates is dropped
    expect(results[0]).toEqual({
      lat: 38.7077,
      lng: -9.1365,
      name: 'Time Out Market',
      address: 'Time Out Market, Avenida 24 de Julho, Cais do Sodré, Lisboa, 1200-479, Portugal',
      city: 'Lisboa',
      country: 'Portugal',
      countryCode: 'PT',
    });
    // No name: falls back to the first part of the address that isn't a house number.
    expect(results[1].name).toBe('Rua das Flores');
    expect(results[1].city).toBe('Porto');
  });

  it('biases results around a nearby place', async () => {
    fetchMock.mockResolvedValue(json([]));
    await searchPlaces('cafe', { lat: 51.5, lng: -0.12 });
    expect(calledUrl().searchParams.get('viewbox')).toBe('-0.62,52,0.38,51');
  });

  it('does not search for an empty query', async () => {
    expect(await searchPlaces('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the device language', async () => {
    vi.stubGlobal('navigator', { language: 'pt-PT' });
    fetchMock.mockResolvedValue(json([]));
    await searchPlaces('Lisboa');
    expect(calledHeaders()['accept-language']).toBe('pt-PT');
  });

  it('throws friendly errors and does not cache failures', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(searchPlaces('Kyoto')).rejects.toThrow('Place search failed (503)');

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = searchPlaces('Kyoto');
    const check = expect(offline).rejects.toThrow(/check your connection/);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    await check;

    fetchMock.mockResolvedValueOnce(json([]));
    const ok = searchPlaces('Kyoto');
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(await ok).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('skips malformed rows instead of crashing', async () => {
    fetchMock.mockResolvedValue(json([null, 5, 'x', [], { lat: '1', lon: '2', name: 'A', namedetails: null, address: null }]));
    const results = await searchPlaces('anything');
    expect(results).toEqual([{ lat: 1, lng: 2, name: 'A' }]);
  });

  it('explains a response that is not JSON (captive portal, proxy page)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => JSON.parse('<html>Sign in to Wi-Fi</html>'),
    } as unknown as Response);
    await expect(searchPlaces('Kyoto')).rejects.toThrow('Place search returned something unexpected — try again.');

    // Not cached: the next try asks again.
    fetchMock.mockResolvedValue(json([]));
    const retry = searchPlaces('Kyoto');
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(await retry).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after a timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    );
    const slow = searchPlaces('Somewhere slow');
    const check = expect(slow).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.user);
    await check;
  });
});

describe('reverseGeocode', () => {
  it('reads venue, address, city and country', async () => {
    fetchMock.mockResolvedValue(
      json({
        lat: '51.5124',
        lon: '-0.1270',
        category: 'amenity',
        type: 'restaurant',
        addresstype: 'amenity',
        name: 'Dishoom',
        display_name: 'Dishoom, 12, Upper St Martin’s Lane, Covent Garden, London, WC2H 9FB, United Kingdom',
        address: { amenity: 'Dishoom', suburb: 'Covent Garden', city: 'London', country: 'United Kingdom', country_code: 'gb' },
      }),
    );
    const place = await reverseGeocode(51.512412345, -0.127);
    expect(place).toEqual({
      name: 'Dishoom',
      address: 'Dishoom, 12, Upper St Martin’s Lane, Covent Garden, London, WC2H 9FB, United Kingdom',
      city: 'London',
      country: 'United Kingdom',
      countryCode: 'GB',
    });
    const url = calledUrl();
    expect(url.pathname).toBe('/reverse');
    expect(url.searchParams.get('lat')).toBe('51.51241');
    expect(url.searchParams.get('lon')).toBe('-0.12700');
    expect(url.searchParams.get('zoom')).toBe('18');
    expect(url.searchParams.get('addressdetails')).toBe('1');
  });

  it('skips street names as venue names and uses the village as the city', async () => {
    fetchMock.mockResolvedValue(
      json({
        category: 'highway',
        type: 'residential',
        addresstype: 'road',
        name: 'Rua Direita',
        display_name: 'Rua Direita, Monsaraz, Évora, Portugal',
        address: { road: 'Rua Direita', village: 'Monsaraz', county: 'Reguengos de Monsaraz', country: 'Portugal', country_code: 'pt' },
      }),
    );
    const place = await reverseGeocode(38.44, -7.38);
    expect(place?.name).toBeUndefined();
    expect(place?.city).toBe('Monsaraz');
    expect(place?.countryCode).toBe('PT');
  });

  it('falls back to address parts for an unnamed venue', async () => {
    fetchMock.mockResolvedValue(
      json({ addresstype: 'tourism', name: '', display_name: 'x', address: { tourism: 'Miradouro da Graça', city: 'Lisbon', country_code: 'pt' } }),
    );
    expect((await reverseGeocode(38.716, -9.131))?.name).toBe('Miradouro da Graça');
  });

  it('resolves undefined instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unable to geocode' }));
    expect(await reverseGeocode(0.5, -30)).toBeUndefined();

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = reverseGeocode(10, 10);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(await offline).toBeUndefined();

    fetchMock.mockResolvedValueOnce(json({}, 429));
    const limited = reverseGeocode(11, 11);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(await limited).toBeUndefined();

    expect(await reverseGeocode(NaN, 1)).toBeUndefined();
    expect(await reverseGeocode(95, 1)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resolves undefined for odd bodies (null, arrays, not JSON)', async () => {
    fetchMock.mockResolvedValueOnce(json(null));
    expect(await reverseGeocode(1, 1)).toBeUndefined();

    fetchMock.mockResolvedValueOnce(json([{ address: { city: 'Nope' } }]));
    const arr = reverseGeocode(2, 2);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(await arr).toBeUndefined();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse('nope') } as unknown as Response);
    const html = reverseGeocode(3, 3);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(await html).toBeUndefined();
  });
});

describe('politeness queue and cache', () => {
  it('spaces requests at least 1100 ms apart', async () => {
    fetchMock.mockResolvedValue(json([]));
    const first = searchPlaces('Lisbon');
    const second = searchPlaces('Porto');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await Promise.all([first, second]);
    expect(NOMINATIM_GAP_MS).toBeGreaterThanOrEqual(1100);
  });

  it('serves repeats from the cache without waiting or fetching', async () => {
    fetchMock.mockResolvedValue(json({ address: { city: 'Kyoto', country: 'Japan', country_code: 'jp' }, display_name: 'Kyoto, Japan' }));
    const a = await reverseGeocode(35.0116, 135.7681);
    // Rounds to the same 5 decimals: a cache hit, answered straight away.
    const b = await reverseGeocode(35.011600001, 135.768100004);
    expect(b).toEqual(a);

    fetchMock.mockResolvedValue(json(LISBON_ROWS));
    const s1 = searchPlaces('Time Out Market');
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    await s1;
    const s2 = await searchPlaces('  time out   MARKET ');
    expect(s2).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one request between identical lookups in flight', async () => {
    fetchMock.mockResolvedValue(json([]));
    await Promise.all([searchPlaces('Seoul'), searchPlaces('Seoul'), searchPlaces('seoul')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops a lookup cancelled while it was waiting its turn', async () => {
    fetchMock.mockResolvedValue(json([]));
    const ctrl = new AbortController();
    const first = searchPlaces('Oslo');
    const second = searchPlaces('Bergen', undefined, { signal: ctrl.signal });
    const check = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    await first;
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resetGeoState clears the cache', async () => {
    fetchMock.mockResolvedValue(json([]));
    await searchPlaces('Tallinn');
    resetGeoState();
    await searchPlaces('Tallinn');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/** A fetch that never answers until aborted (a phone network where Nominatim hangs). */
const hang = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

/** Fetches that wait to be answered one by one; `asked()` lists the queries / coordinates in the order sent. */
function heldFetches() {
  const pending: { url: URL; answer: (body: unknown) => void }[] = [];
  fetchMock.mockImplementation(
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ url: new URL(url), answer: (body) => resolve(json(body)) });
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  const asked = () => pending.map((p) => p.url.searchParams.get('q') ?? p.url.searchParams.get('lat'));
  return { pending, asked };
}

const bg = { priority: 'background' } as const;

describe('priority lanes', () => {
  it('runs a user lookup next, ahead of background ones queued before it', async () => {
    const { pending, asked } = heldFetches();
    const background = ['A', 'B', 'C'].map((q) => searchPlaces(q, undefined, bg));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked()).toEqual(['A']);

    const mine = searchPlaces('Wan Chai');
    expect(geoHealth().userBusy).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(asked()).toEqual(['A']); // waits for the one in flight, and the gap
    pending[0].answer([]);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS - 500);
    expect(asked()).toEqual(['A', 'Wan Chai']);

    pending[1].answer([]);
    expect(await mine).toEqual([]);
    expect(geoHealth().userBusy).toBe(false);
    // Then the background ones, the gap still kept.
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS - 1);
    expect(asked()).toEqual(['A', 'Wan Chai']);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked()).toEqual(['A', 'Wan Chai', 'B']);
    pending[2].answer([]);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    pending[3].answer([]);
    await Promise.all(background);
    expect(asked()).toEqual(['A', 'Wan Chai', 'B', 'C']);
  });

  it('cuts a slow background request short once the gap is up, so a user lookup waits at most the gap', async () => {
    const { pending, asked } = heldFetches();
    const a = searchPlaces('A', undefined, bg);
    void searchPlaces('B', undefined, bg);
    await vi.advanceTimersByTimeAsync(300);
    const mine = searchPlaces('Mine');
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS - 301);
    expect(asked()).toEqual(['A']);
    await vi.advanceTimersByTimeAsync(1);
    // …only up to the gap: A makes way.
    expect(asked()).toEqual(['A', 'Mine']);
    pending[1].answer([]);
    expect(await mine).toEqual([]);
    // A goes again, ahead of B, and nothing counts it as a failure.
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(asked()).toEqual(['A', 'Mine', 'A']);
    expect(geoHealth().troubles).toBe(0);
    pending[2].answer([{ lat: '1', lon: '2', name: 'Found' }]);
    expect(await a).toEqual([expect.objectContaining({ name: 'Found' })]);
  });

  it('ends a user lookup within the gap plus its own timeout, even behind a hanging background one', async () => {
    fetchMock.mockImplementation(hang);
    void reverseGeocode(1, 1, bg);
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const mine = searchPlaces('Mine')
      .catch((e: unknown) => e)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS + LOOKUP_TIMEOUT_MS.user - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await mine) as Error).message).toMatch(/took too long/);
    expect(NOMINATIM_GAP_MS + LOOKUP_TIMEOUT_MS.user).toBeLessThanOrEqual(12000);
  });

  it("doesn't cut short a background request someone joined", async () => {
    const { pending, asked } = heldFetches();
    const shared = searchPlaces('Kyoto', undefined, bg);
    await vi.advanceTimersByTimeAsync(0);
    const mine = searchPlaces('kyoto');
    void searchPlaces('Other');
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked()).toEqual(['Kyoto']);
    pending[0].answer([]);
    expect(await mine).toEqual([]);
    expect(await shared).toEqual([]);
  });

  it('lets a user lookup that arrives during the gap go first', async () => {
    const { pending, asked } = heldFetches();
    void searchPlaces('A', undefined, bg);
    void searchPlaces('B', undefined, bg);
    await vi.advanceTimersByTimeAsync(300);
    pending[0].answer([]); // answers quickly; B waits out the gap
    await vi.advanceTimersByTimeAsync(300);
    const mine = searchPlaces('Mine');
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS - 601);
    expect(asked()).toEqual(['A']);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked()).toEqual(['A', 'Mine']);
    pending[1].answer([]);
    expect(await mine).toEqual([]);
  });

  it('moves a queued background lookup up when someone starts waiting on it', async () => {
    const { pending, asked } = heldFetches();
    void searchPlaces('A', undefined, bg);
    void searchPlaces('B', undefined, bg);
    const shared = searchPlaces('Kyoto', undefined, bg);
    const mine = searchPlaces('kyoto');
    await vi.advanceTimersByTimeAsync(0);
    pending[0].answer([]);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(asked()).toEqual(['A', 'Kyoto']);
    pending[1].answer([]);
    expect(await mine).toEqual([]);
    expect(await shared).toEqual([]);
  });

  it('keeps a shared lookup going while anyone still wants it', async () => {
    const { pending, asked } = heldFetches();
    void searchPlaces('First');
    const a = new AbortController();
    const b = new AbortController();
    const one = searchPlaces('Oslo', undefined, { signal: a.signal });
    const two = searchPlaces('Oslo', undefined, { signal: b.signal });
    const oneCancelled = expect(one).rejects.toMatchObject({ name: 'AbortError' });
    a.abort();
    await oneCancelled;
    pending[0].answer([]);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(asked()).toEqual(['First', 'Oslo']);
    pending[1].answer([]);
    expect(await two).toEqual([]);
  });

  it('gives background lookups a shorter timeout', async () => {
    fetchMock.mockImplementation(hang);
    let settled = false;
    const slow = searchPlaces('Somewhere slow', undefined, bg).finally(() => (settled = true));
    const check = expect(slow).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.background - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await check;
    expect(LOOKUP_TIMEOUT_MS.background).toBeLessThanOrEqual(6000);
    expect(LOOKUP_TIMEOUT_MS.background).toBeLessThan(LOOKUP_TIMEOUT_MS.user);
  });

  it('treats lookups made with a background signal as background work', async () => {
    fetchMock.mockImplementation(hang);
    const parent = new AbortController();
    const signal = backgroundSignal(parent.signal);
    let result: unknown = 'pending';
    void reverseGeocode(38.7, -9.14, { signal }).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.background);
    expect(result).toBeUndefined(); // gave up at the background timeout
    parent.abort();
    expect(signal.aborted).toBe(true);
  });

  it('holds background lookups while asked to, never user ones', async () => {
    fetchMock.mockResolvedValue(json([]));
    const release = holdBackgroundLookups();
    expect(geoHealth().userBusy).toBe(true);
    const background = searchPlaces('Background', undefined, bg);
    const mine = searchPlaces('Mine');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await mine).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    let idle = false;
    void whenUserIdle().then(() => (idle = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);
    release();
    release(); // harmless
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
    expect(await background).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('lookupReport', () => {
  it('says whether a lookup was asked, and whether it ran into trouble', async () => {
    fetchMock.mockResolvedValueOnce(json({ address: { country_code: 'pt' } }));
    const answered = backgroundSignal();
    await reverseGeocode(1, 1, { signal: answered });
    expect(lookupReport(answered)).toEqual({ asked: true, troubled: false });

    // Cached: the answer is known, so it counts as asked.
    const again = backgroundSignal();
    await reverseGeocode(1, 1, { signal: again });
    expect(lookupReport(again)).toEqual({ asked: true, troubled: false });

    fetchMock.mockImplementation(hang);
    const timedOut = backgroundSignal();
    const p = reverseGeocode(2, 2, { signal: timedOut });
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS + LOOKUP_TIMEOUT_MS.background);
    await p;
    expect(lookupReport(timedOut)).toEqual({ asked: true, troubled: true });
    expect(lookupReport(new AbortController().signal)).toEqual({ asked: false, troubled: false });
  });

  it("doesn't count a lookup dropped by the breaker, or cancelled, as asked", async () => {
    fetchMock.mockImplementation(hang);
    void searchPlaces('a', undefined, bg).catch(() => {});
    void searchPlaces('b', undefined, bg).catch(() => {});
    const dropped = backgroundSignal();
    const lookup = reverseGeocode(3, 3, { signal: dropped });
    const parent = new AbortController();
    const cancelled = backgroundSignal(parent.signal);
    const gone = reverseGeocode(4, 4, { signal: cancelled });
    parent.abort();
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS + 2 * LOOKUP_TIMEOUT_MS.background);
    expect(await lookup).toBeUndefined();
    expect(await gone).toBeUndefined();
    expect(geoHealth().paused).toBe(true);
    expect(lookupReport(dropped)).toEqual({ asked: false, troubled: false });
    expect(lookupReport(cancelled)).toEqual({ asked: false, troubled: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('circuit breaker', () => {
  it('pauses background lookups after two failures in a row, but never user lookups', async () => {
    fetchMock.mockImplementation(hang);
    const a = reverseGeocode(1, 1, bg);
    const b = reverseGeocode(2, 2, bg);
    const c = searchPlaces('Queued', undefined, bg);
    const dropped = expect(c).rejects.toMatchObject({ name: 'GeoPausedError' });
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.background);
    expect(geoHealth()).toMatchObject({ paused: false, troubles: 1 });
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.background);
    expect(geoHealth()).toMatchObject({ paused: true, troubles: 2 });
    expect(await a).toBeUndefined();
    expect(await b).toBeUndefined();
    await dropped; // the queued one gave up without asking
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // New background lookups are refused straight away…
    await expect(searchPlaces('Later', undefined, bg)).rejects.toMatchObject({ name: 'GeoPausedError' });
    expect(await reverseGeocode(3, 3, bg)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // …user lookups still go out (and their failures don't count).
    const mine = searchPlaces('Mine');
    const check = expect(mine).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.user);
    await check;
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Background work resumes after the pause.
    await vi.advanceTimersByTimeAsync(BREAKER_PAUSE_MS);
    expect(geoHealth().paused).toBe(false);
    fetchMock.mockResolvedValue(json([]));
    const later = searchPlaces('Later', undefined, bg);
    await vi.advanceTimersByTimeAsync(0);
    expect(await later).toEqual([]);
  });

  it('counts network errors and resumes when the device comes back online', async () => {
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    void reverseGeocode(1, 1, bg);
    void reverseGeocode(2, 2, bg);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS);
    expect(geoHealth().paused).toBe(true);
    win.dispatchEvent(new Event('online'));
    expect(geoHealth().paused).toBe(false);
  });

  it('closes again on any answer', async () => {
    fetchMock.mockImplementation(hang);
    void reverseGeocode(1, 1, bg);
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS.background);
    fetchMock.mockResolvedValue(json([]));
    await searchPlaces('Fine');
    fetchMock.mockImplementation(hang);
    void reverseGeocode(2, 2, bg);
    await vi.advanceTimersByTimeAsync(NOMINATIM_GAP_MS + LOOKUP_TIMEOUT_MS.background);
    // One failure since the last answer: not paused.
    expect(geoHealth()).toMatchObject({ paused: false, troubles: 2 });
  });
});

describe('addressDetails', () => {
  it('picks the most specific settlement and normalises the country code', () => {
    expect(addressDetails({ city: 'London', town: 'x', country: 'United Kingdom', country_code: 'gb' })).toEqual({
      city: 'London',
      country: 'United Kingdom',
      countryCode: 'GB',
    });
    expect(addressDetails({ hamlet: 'Little Snoring', county: 'Norfolk' }).city).toBe('Little Snoring');
    expect(addressDetails({ suburb: 'Shibuya', county: 'Tokyo' }).city).toBe('Shibuya');
    expect(addressDetails({ country_code: 'gbr' }).countryCode).toBeUndefined();
    expect(addressDetails(undefined)).toEqual({});
  });
});
