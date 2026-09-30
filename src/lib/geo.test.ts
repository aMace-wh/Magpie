import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addressDetails, NOMINATIM_GAP_MS, resetGeoState, reverseGeocode, searchPlaces } from './geo';

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
    await vi.advanceTimersByTimeAsync(12000);
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
