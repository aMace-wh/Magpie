import type { Place } from './types';

export interface GeoResult extends Place {
  name: string;
}

/**
 * 'user': someone is waiting on the answer (the default). 'background': enrichment and backfill — waits
 * behind user lookups, gives up sooner and backs off when the service can't be reached.
 */
export type GeoPriority = 'user' | 'background';

export interface GeoOptions {
  signal?: AbortSignal;
  /** Default 'user' — or 'background' when `signal` came from backgroundSignal(). */
  priority?: GeoPriority;
}

const NOMINATIM = 'https://nominatim.openstreetmap.org';
/** Nominatim's usage policy: at most one request per second. A little slack on top. */
export const NOMINATIM_GAP_MS = 1100;
/**
 * How long one lookup may take. A user lookup waits at most NOMINATIM_GAP_MS for its turn (a background one in
 * flight makes way), so its spinner stops within about 11 s. Nobody waits on a background one: it gives up sooner.
 */
export const LOOKUP_TIMEOUT_MS: Readonly<Record<GeoPriority, number>> = { user: 10000, background: 6000 };
/** Background lookups pause after this many timeouts / network errors in a row… */
export const BREAKER_FAILURES = 2;
/** …for this long, or until the device comes back online. User lookups are never paused. */
export const BREAKER_PAUSE_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

// ---------------------------------------------------------------------------
// Politeness queue + cache, shared by every Nominatim call in the app. One request at a time, each at
// least NOMINATIM_GAP_MS after the last. Queued user lookups always go before queued background ones, and a
// background request still going when the gap is up makes way (it's tried again after), so a user lookup
// waits at most NOMINATIM_GAP_MS for its turn.

interface Job {
  key: string;
  priority: GeoPriority;
  load: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>;
  /** Cancels the request once every caller has given up on it. */
  ctrl: AbortController;
  /** Callers still waiting (one without a signal never leaves). */
  waiters: number;
  started: boolean;
  /** The request in flight, which a user lookup can cut short (`preempted`) to go first. */
  attempt?: AbortController;
  preempted: boolean;
  /** Someone joined while it was in flight: it isn't cut short. */
  userJoined: boolean;
  /** Callers' signals, for lookupReport(). */
  signals: AbortSignal[];
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const lanes: Record<GeoPriority, Job[]> = { user: [], background: [] };
/** Queued or in flight, by cache key: identical lookups share one request. */
const jobs = new Map<string, Job>();
const cache = new Map<string, unknown>();
let lastStart = Number.NEGATIVE_INFINITY;
let current: Job | undefined;
let pumping = false;
/** Bumped by resetGeoState, so a runner from before the reset stops. */
let generation = 0;
/** Open holdBackgroundLookups() calls. */
let holds = 0;
let idleWaiters: (() => void)[] = [];
// Circuit breaker for background lookups.
let failuresInARow = 0;
let pausedUntil = 0;
let troubles = 0;
let listening = false;
let preemptTimer: ReturnType<typeof setTimeout> | undefined;

/** Clears the request queue, cache and back-off. For tests. */
export function resetGeoState(): void {
  generation++;
  lanes.user = [];
  lanes.background = [];
  jobs.clear();
  cache.clear();
  lastStart = Number.NEGATIVE_INFINITY;
  current = undefined;
  pumping = false;
  holds = 0;
  idleWaiters = [];
  failuresInARow = 0;
  pausedUntil = 0;
  troubles = 0;
  listening = false;
  clearTimeout(preemptTimer);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function abortError(): Error {
  const e = new Error('The lookup was cancelled.');
  e.name = 'AbortError';
  return e;
}

function pausedError(): Error {
  const e = new Error('Place lookups are paused for a bit — the connection seems poor.');
  e.name = 'GeoPausedError';
  return e;
}

// Timeouts, network errors and an overloaded service: reasons for background work to back off.
const TROUBLE = new WeakSet<object>();
function trouble(message: string): Error {
  const e = new Error(message);
  TROUBLE.add(e);
  return e;
}
const isTrouble = (e: unknown) => typeof e === 'object' && e !== null && TROUBLE.has(e);

const backgroundSignals = new WeakSet<AbortSignal>();

/**
 * A signal that marks the lookups made with it as background work — for code that only passes a signal
 * on (resolvePlaceDetails). Aborts along with `parent`.
 */
export function backgroundSignal(parent?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  if (parent?.aborted) ctrl.abort();
  else parent?.addEventListener('abort', () => ctrl.abort(), { once: true });
  backgroundSignals.add(ctrl.signal);
  return ctrl.signal;
}

export interface LookupReport {
  /** A request went out and got an answer, or failed by itself (not cancelled or paused); or the answer was cached. */
  asked: boolean;
  /** …and it timed out, couldn't reach the service, or the service was busy. */
  troubled: boolean;
}

const reports = new WeakMap<AbortSignal, LookupReport>();

/**
 * What became of the lookups made with `signal` (one per job, e.g. from backgroundSignal()): whether they were
 * actually asked, rather than dropped because lookups were paused or cancelled.
 */
export function lookupReport(signal: AbortSignal): LookupReport {
  return reports.get(signal) ?? { asked: false, troubled: false };
}

function report(signals: Iterable<AbortSignal>, troubled: boolean): void {
  for (const s of signals) reports.set(s, { asked: true, troubled: troubled || lookupReport(s).troubled });
}

const priorityOf = (opts: GeoOptions): GeoPriority =>
  opts.priority ?? (opts.signal && backgroundSignals.has(opts.signal) ? 'background' : 'user');

const paused = () => Date.now() < pausedUntil;

/** Any answer — or the device coming back online — closes the breaker. */
function healthy(): void {
  failuresInARow = 0;
  pausedUntil = 0;
}

function failed(priority: GeoPriority): void {
  troubles++;
  if (priority !== 'background' || ++failuresInARow < BREAKER_FAILURES) return;
  pausedUntil = Date.now() + BREAKER_PAUSE_MS;
  if (!listening && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    listening = true;
    window.addEventListener('online', healthy);
  }
  // Queued background lookups give up now, not one timeout at a time.
  for (const job of lanes.background.splice(0)) {
    settle(job);
    job.reject(pausedError());
  }
}

const userIdle = () => holds === 0 && lanes.user.length === 0 && current?.priority !== 'user';

function checkIdle(): void {
  if (!idleWaiters.length || !userIdle()) return;
  const waiting = idleWaiters;
  idleWaiters = [];
  for (const wake of waiting) wake();
}

export interface GeoHealth {
  /** Background lookups are paused after repeated timeouts / network errors (user lookups never are). */
  paused: boolean;
  /** Timeouts, network errors and "service busy" replies so far — compare before and after a lookup. */
  troubles: number;
  /** A user lookup is waiting or running, or background lookups are on hold. */
  userBusy: boolean;
}

export function geoHealth(): GeoHealth {
  return { paused: paused(), troubles, userBusy: !userIdle() };
}

/** Resolves once no user lookup is waiting or running and nothing holds background lookups. */
export function whenUserIdle(): Promise<void> {
  if (userIdle()) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/**
 * Keeps background lookups from starting (user lookups still run) until the returned release is called —
 * e.g. while a place picker is open. Releasing twice is harmless.
 */
export function holdBackgroundLookups(): () => void {
  holds++;
  const gen = generation;
  let held = true;
  return () => {
    if (!held || gen !== generation) return;
    held = false;
    holds--;
    checkIdle();
    void pump();
  };
}

function settle(job: Job): void {
  if (jobs.get(job.key) === job) jobs.delete(job.key);
}

function unqueue(job: Job): void {
  const lane = lanes[job.priority];
  const i = lane.indexOf(job);
  if (i >= 0) lane.splice(i, 1);
}

function newJob(key: string, priority: GeoPriority, load: Job['load']): Job {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const job: Job = {
    key,
    priority,
    load,
    ctrl: new AbortController(),
    waiters: 0,
    started: false,
    preempted: false,
    userJoined: false,
    signals: [],
    promise,
    resolve,
    reject,
  };
  jobs.set(key, job);
  lanes[priority].push(job);
  return job;
}

/** One caller's interest in a job; its own signal cancels just that caller. */
function join(job: Job, signal?: AbortSignal): Promise<unknown> {
  job.waiters++;
  if (!signal) return job.promise;
  job.signals.push(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
      leave(job);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void job.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function leave(job: Job): void {
  if (--job.waiters > 0) return;
  // Nobody wants it any more: cancel the request, or drop it from the queue without using up a slot.
  job.ctrl.abort();
  if (job.started) return;
  unqueue(job);
  settle(job);
  job.reject(abortError());
  checkIdle();
}

const nextJob = (): Job | undefined => lanes.user[0] ?? (holds > 0 ? undefined : lanes.background[0]);

async function run(job: Job): Promise<void> {
  unqueue(job);
  job.started = true;
  current = job;
  lastStart = Date.now();
  // This request only: a user lookup may cut it short, and the job then goes back in the queue.
  const attempt = new AbortController();
  const stop = () => attempt.abort();
  job.ctrl.signal.addEventListener('abort', stop, { once: true });
  job.attempt = attempt;
  try {
    const value = await job.load(attempt.signal, LOOKUP_TIMEOUT_MS[job.priority]);
    healthy();
    remember(job.key, value);
    report(job.signals, false);
    settle(job);
    job.resolve(value);
  } catch (e) {
    if (job.preempted && !job.ctrl.signal.aborted) {
      // Made way for a user lookup: first in its lane again, to go once that's done.
      job.preempted = false;
      job.started = false;
      lanes[job.priority].unshift(job);
      return;
    }
    const troubled = isTrouble(e);
    if (troubled) failed(job.priority);
    if (!job.ctrl.signal.aborted && (e as Error | null)?.name !== 'AbortError') report(job.signals, troubled);
    settle(job);
    job.reject(e);
  } finally {
    job.ctrl.signal.removeEventListener('abort', stop);
    job.attempt = undefined;
    if (current === job) current = undefined;
    checkIdle();
  }
}

/**
 * A user lookup is waiting behind a background request in flight: once the gap since that request started is up,
 * cut it short so the user's goes next. Nobody waits on the background one; it's tried again afterwards.
 */
function preempt(): void {
  clearTimeout(preemptTimer);
  const job = current;
  if (!job || job.priority !== 'background' || job.userJoined || !lanes.user.length) return;
  const wait = lastStart + NOMINATIM_GAP_MS - Date.now();
  if (wait > 0) {
    preemptTimer = setTimeout(preempt, wait);
    return;
  }
  job.preempted = true;
  job.attempt?.abort();
}

/** The single runner: user lane first, the gap between requests always kept. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  const gen = generation;
  try {
    for (let job = nextJob(); job; job = nextJob()) {
      const wait = lastStart + NOMINATIM_GAP_MS - Date.now();
      if (wait > 0) {
        // Then look again: a user lookup may have come in meanwhile.
        await sleep(wait);
      } else {
        await run(job);
      }
      if (gen !== generation) return;
    }
  } finally {
    if (gen === generation) pumping = false;
  }
}

function remember(key: string, value: unknown): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Cached, de-duplicated, queued lookup. Failures are not cached. */
function cached<T>(key: string, load: Job['load'], opts: GeoOptions): Promise<T> {
  const { signal } = opts;
  if (cache.has(key)) {
    const hit = cache.get(key) as T;
    remember(key, hit);
    if (signal) report([signal], false);
    return Promise.resolve(hit);
  }
  if (signal?.aborted) return Promise.reject(abortError());
  const priority = priorityOf(opts);
  let job = jobs.get(key);
  if (job && priority === 'user' && job.priority === 'background') {
    if (job.started) {
      // In flight already: let it finish rather than cut it short.
      job.userJoined = true;
    } else {
      // Someone is waiting on it now: move it up.
      unqueue(job);
      job.priority = 'user';
      lanes.user.push(job);
    }
  } else if (!job) {
    if (priority === 'background' && paused()) return Promise.reject(pausedError());
    job = newJob(key, priority, load);
  }
  const p = join(job, signal) as Promise<T>;
  if (priority === 'user') preempt();
  void pump();
  return p;
}

function language(): string {
  try {
    return (typeof navigator !== 'undefined' && navigator.language) || 'en';
  } catch {
    return 'en';
  }
}

/** fetch with a timeout, also cancellable by the signal. */
async function getJson(url: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal.aborted) throw abortError();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'accept-language': language() },
    });
    if (!res.ok) {
      const message = `Place search failed (${res.status})`;
      // Rate-limited or the service is struggling: worth backing off.
      throw res.status === 429 || res.status >= 500 ? trouble(message) : new Error(message);
    }
    try {
      return await res.json();
    } catch (e) {
      // A captive portal or proxy page instead of JSON (a timeout is reported as such below).
      if (ctrl.signal.aborted) throw e;
      throw new Error('Place search returned something unexpected — try again.');
    }
  } catch (e) {
    if (signal.aborted) throw abortError();
    if (ctrl.signal.aborted) throw trouble('Place search took too long — try again.');
    if (e instanceof TypeError) throw trouble('Couldn’t reach place search — check your connection.');
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
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
 * Throws a friendly Error when the service can't be reached. Pass
 * `{ priority: 'background' }` for lookups nobody is waiting on.
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
    async (signal, timeoutMs) => {
      const rows = await getJson(`${NOMINATIM}/search?${params}`, signal, timeoutMs);
      if (!Array.isArray(rows)) return [];
      return rows
        .filter(isRow)
        .map(toResult)
        .filter((r): r is GeoResult => !!r);
    },
    opts,
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
      async (signal, timeoutMs) => {
        const row = await getJson(`${NOMINATIM}/reverse?${params}`, signal, timeoutMs);
        if (!isRow(row) || row.error) return undefined;
        const details = addressDetails(row.address);
        const out: Partial<Place> = { ...details };
        const name = venueName(row, details.city);
        if (name) out.name = name;
        const address = text(row.display_name);
        if (address) out.address = address;
        return Object.keys(out).length ? out : undefined;
      },
      opts,
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
