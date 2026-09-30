import type { Place } from './types';

export interface GeoResult extends Place {
  name: string;
}

export interface GeoOptions {
  signal?: AbortSignal;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';
/** Nominatim's usage policy: at most one request per second. A little slack on top. */
export const NOMINATIM_GAP_MS = 1100;
const TIMEOUT_MS = 12000;
const CACHE_MAX = 300;

// ---------------------------------------------------------------------------
// Politeness queue + cache, shared by every Nominatim call in the app.

let chain: Promise<unknown> = Promise.resolve();
let lastStart = Number.NEGATIVE_INFINITY;
const cache = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

/** Clears the request queue and cache. For tests. */
export function resetGeoState(): void {
  chain = Promise.resolve();
  lastStart = Number.NEGATIVE_INFINITY;
  cache.clear();
  inflight.clear();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortError(): Error {
  const e = new Error('The lookup was cancelled.');
  e.name = 'AbortError';
  return e;
}

/** Runs tasks one at a time, each starting at least NOMINATIM_GAP_MS after the previous one. */
function enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = lastStart + NOMINATIM_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    // Cancelled while queued: skip without using up a slot.
    if (signal?.aborted) throw abortError();
    lastStart = Date.now();
    return task();
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

function remember(key: string, value: unknown): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Cached, de-duplicated, queued lookup. Failures are not cached. */
function cached<T>(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (cache.has(key)) {
    const hit = cache.get(key) as T;
    remember(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const p = enqueue(load, signal).then(
    (value) => {
      inflight.delete(key);
      remember(key, value);
      return value;
    },
    (err: unknown) => {
      inflight.delete(key);
      throw err;
    },
  );
  inflight.set(key, p);
  return p;
}

function language(): string {
  try {
    return (typeof navigator !== 'undefined' && navigator.language) || 'en';
  } catch {
    return 'en';
  }
}

/** fetch with a timeout, also cancellable by the caller's signal. */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'accept-language': language() },
    });
    if (!res.ok) throw new Error(`Place search failed (${res.status})`);
    try {
      return await res.json();
    } catch (e) {
      // A captive portal or proxy page instead of JSON (a timeout is reported as such below).
      if (ctrl.signal.aborted) throw e;
      throw new Error('Place search returned something unexpected — try again.');
    }
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (ctrl.signal.aborted) throw new Error('Place search took too long — try again.');
    if (e instanceof TypeError) throw new Error('Couldn’t reach place search — check your connection.');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Response parsing

type NominatimAddress = Record<string, string | undefined>;

interface NominatimRow {
  lat?: string | number;
  lon?: string | number;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  addresstype?: string;
  address?: NominatimAddress;
  namedetails?: Record<string, string | undefined>;
  error?: string;
}

const CITY_KEYS = ['city', 'town', 'village', 'hamlet', 'municipality', 'suburb', 'county'];
// Address parts that name the venue itself, when the row has no `name`.
const VENUE_KEYS = [
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'historic',
  'attraction',
  'craft',
  'office',
  'club',
  'building',
  'man_made',
  'natural',
  'aeroway',
  'railway',
];
// Kinds of result whose `name` is a street or area, not a venue.
const NOT_VENUE = new Set(['road', 'house', 'house_number', 'postcode', 'highway', 'boundary', 'place']);

const text = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t || undefined;
};

const isRow = (row: unknown): row is NominatimRow => !!row && typeof row === 'object' && !Array.isArray(row);

function coords(row: NominatimRow): { lat: number; lng: number } | undefined {
  if (!isRow(row)) return undefined;
  const lat = Number(row.lat);
  const lng = Number(row.lon);
  if (row.lat === undefined || row.lon === undefined) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

/** City, country and country code from a Nominatim `address` block. */
export function addressDetails(address: NominatimAddress | undefined): Pick<Place, 'city' | 'country' | 'countryCode'> {
  const out: Pick<Place, 'city' | 'country' | 'countryCode'> = {};
  if (!address || typeof address !== 'object') return out;
  for (const k of CITY_KEYS) {
    const v = text(address[k]);
    if (v) {
      out.city = v;
      break;
    }
  }
  const country = text(address.country);
  if (country) out.country = country;
  const code = text(address.country_code)?.toUpperCase();
  if (code && /^[A-Z]{2}$/.test(code)) out.countryCode = code;
  return out;
}

function venueName(row: NominatimRow, city?: string): string | undefined {
  const kind = row.addresstype ?? row.type;
  const named = text(row.name) ?? text(row.namedetails?.name);
  let name: string | undefined;
  if (named && !(row.category === 'highway' || (kind && NOT_VENUE.has(kind)))) name = named;
  if (!name && row.address) {
    for (const k of VENUE_KEYS) {
      const v = text(row.address[k]);
      if (v && !/^(yes|no)$/i.test(v)) {
        name = v;
        break;
      }
    }
  }
  // "Lisbon" as the name of a place in Lisbon adds nothing.
  if (name && city && name.toLowerCase() === city.toLowerCase()) return undefined;
  return name;
}

/** First meaningful part of a display name, skipping bare house numbers ("24, Rua Augusta, …"). */
function firstPart(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.find((p) => !/^[\d\s/-]+[a-z]?$/i.test(p)) ?? parts[0];
}

function toResult(row: NominatimRow): GeoResult | undefined {
  const at = coords(row);
  if (!at) return undefined;
  const address = text(row.display_name);
  const details = addressDetails(row.address);
  const name = text(row.name) ?? text(row.namedetails?.name) ?? firstPart(address) ?? `${at.lat.toFixed(5)}, ${at.lng.toFixed(5)}`;
  const result: GeoResult = { ...at, name, ...details };
  if (address) result.address = address;
  return result;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Place search via OpenStreetMap Nominatim. Their usage policy allows light,
 * user-initiated searches (no autocomplete), so this only runs on submit.
 * Throws a friendly Error when the service can't be reached.
 */
export async function searchPlaces(query: string, near?: Place, opts: GeoOptions = {}): Promise<GeoResult[]> {
  const q = query.replace(/\s+/g, ' ').trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '6', addressdetails: '1' });
  let area = '';
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
    const d = 0.5;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    area = `${near.lat.toFixed(1)},${near.lng.toFixed(1)}`;
  }
  const lang = language();
  const key = `search|${lang}|${q.toLowerCase()}|${area}`;
  return cached(
    key,
    async () => {
      const rows = await getJson(`${NOMINATIM}/search?${params}`, opts.signal);
      if (!Array.isArray(rows)) return [];
      return rows
        .filter(isRow)
        .map(toResult)
        .filter((r): r is GeoResult => !!r);
    },
    opts.signal,
  );
}

/**
 * What's at these coordinates: venue name, address, city and country.
 * Resolves undefined when offline, rate-limited or nothing is there — never throws.
 */
export async function reverseGeocode(lat: number, lng: number, opts: GeoOptions = {}): Promise<Partial<Place> | undefined> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  const la = lat.toFixed(5);
  const lo = lng.toFixed(5);
  const params = new URLSearchParams({ format: 'jsonv2', lat: la, lon: lo, zoom: '18', addressdetails: '1', namedetails: '1' });
  const key = `reverse|${language()}|${la},${lo}`;
  try {
    return await cached(
      key,
      async () => {
        const row = await getJson(`${NOMINATIM}/reverse?${params}`, opts.signal);
        if (!isRow(row) || row.error) return undefined;
        const details = addressDetails(row.address);
        const out: Partial<Place> = { ...details };
        const name = venueName(row, details.city);
        if (name) out.name = name;
        const address = text(row.display_name);
        if (address) out.address = address;
        return Object.keys(out).length ? out : undefined;
      },
      opts.signal,
    );
  } catch {
    return undefined;
  }
}

export function currentPosition(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Location is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

/** Opens the coordinates in Google Maps (or the Maps app on phones). */
export function mapsLink(place: Place): string {
  return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
}

export function directionsLink(place: Place): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
}
