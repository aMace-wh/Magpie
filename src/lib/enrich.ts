import { classify, parsePlaceFromUrl, safeUrl } from './classify';
import { db } from './db';
import { backgroundSignal, geoHealth, lookupReport, searchPlaces, type GeoPriority, type GeoResult } from './geo';
import { extractLocationHints, guessCountry, mergePlaceDetails, needsDetails, resolvePlaceDetails, type PlaceCandidate } from './location';
import { fetchPreview, type LinkPreview } from './metadata';
import { getSettings } from './settings';
import { keepThumb } from './thumbs';
import type { EditedField, Item, Place, When } from './types';
import { analyzeSave, ANALYSIS_VERSION, automaticTitle, mergeTags, shouldLocate, storedPreview, withoutDates, type SaveAnalysis } from './understand';

export interface EnrichOptions {
  /** The title was generated, not typed — a real one from the page may replace it. */
  replaceTitle: boolean;
  /** The type was guessed, not picked — a better guess may replace it. */
  reclassify: boolean;
  /** Replace the image / description / site name even if already set. */
  overwrite?: boolean;
  /** Look for an event date when the save has none. Default true; false once the user set or cleared the date. */
  dates?: boolean;
  /** Fill in a location from the link or text when the save has none. Default true; false once the user picked or cleared one. */
  locate?: boolean;
  /** Place lookups wait behind the user's own unless someone is waiting on this one ("Refresh preview"). Default 'background'. */
  priority?: GeoPriority;
  /** Cancels the preview fetch and place lookups, e.g. when the user leaves. Nothing is written after it fires. */
  signal?: AbortSignal;
  /** Resolve only once place details are in. Default true; false resolves after the preview and finishes the place quietly. */
  waitForPlace?: boolean;
  /** Told why no preview came back ('limited', 'timeout' or 'failed'), when none did. */
  onProblem?: (problem: NonNullable<LinkPreview['problem']>) => void;
}

/**
 * "Refresh preview" on a save: the link's own details only (title, image, description…). A date or place the user
 * set — or removed on purpose — is left as it is.
 */
export const REFRESH_OPTIONS: EnrichOptions = { replaceTitle: false, reclassify: false, overwrite: true, dates: false, locate: false };

// ---------------------------------------------------------------------------
// Short links

const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com', 'pin.it', 'redd.it', 'spotify.link', 'fb.watch', 'maps.app.goo.gl', 'amzn.to', 'amzn.eu', 'a.co', 'bit.ly', 't.co']);
const SHORT_PATHS: [host: string, path: RegExp][] = [
  ['tiktok.com', /^\/t\//],
  ['facebook.com', /^\/share\//],
  ['instagram.com', /^\/share\//],
  ['goo.gl', /^\/maps(?:\/|$)/],
];
// Where a redirect lands when the platform wants you to sign in or accept cookies first.
const WALL_HOST = /^(?:consent|accounts|login|auth|signin)\./i;
const WALL_PATH = /^\/(?:login|log-in|signin|sign-in|signup|accounts?|consent|auth|checkpoint)(?:[/?.]|$)/i;

function parse(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

const bareHost = (u: URL) => u.hostname.toLowerCase().replace(/^(?:www\.|m\.)/, '');

/** A sign-in or cookie-consent page rather than the thing itself. */
function isWall(url: string | undefined): boolean {
  const u = parse(url);
  return !!u && (WALL_HOST.test(u.hostname) || WALL_PATH.test(u.pathname));
}

/** A redirector link ("vm.tiktok.com/…", "maps.app.goo.gl/…") that has no ID or coordinates of its own. */
export function isShortLink(url: string | undefined): boolean {
  const u = parse(url);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  const host = bareHost(u);
  return SHORT_HOSTS.has(host) || SHORT_PATHS.some(([h, path]) => host === h && path.test(u.pathname));
}

/**
 * A login wall's "where to go after signing in" (Instagram: /accounts/login/?next=/p/CODE/) — only a path on
 * the same site, never another site.
 */
function behindWall(url: string | undefined): string | undefined {
  const u = parse(url);
  if (!u || !isWall(url)) return undefined;
  for (const key of ['next', 'continue', 'redirect', 'return_to']) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    let dest: URL;
    try {
      dest = new URL(v, u.origin);
    } catch {
      continue;
    }
    const sameSite = bareHost(dest) === bareHost(u) || bareHost(dest).endsWith(`.${bareHost(u)}`);
    if (sameSite && /^https?:$/.test(dest.protocol) && !isWall(dest.href)) return safeUrl(dest.href);
  }
  return undefined;
}

/** Where a short link really goes, when the preview followed it somewhere useful (not a login wall or a home page). */
export function resolvedShortLink(url: string | undefined, finalUrl: string | undefined): string | undefined {
  if (!isShortLink(url)) return undefined;
  const target = behindWall(finalUrl) ?? safeUrl(finalUrl);
  const from = parse(url);
  const to = parse(target);
  if (!target || !from || !to) return undefined;
  const key = (u: URL) => `${bareHost(u)}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  if (key(from) === key(to) || to.pathname.replace(/\/+$/, '') === '') return undefined;
  if (isShortLink(target) || isWall(target)) return undefined;
  return target;
}

// ---------------------------------------------------------------------------
// Location hints

/** Likely place mentions in shared text, best first (offline). */
export function locationHints(text: string, max = 5): string[] {
  if (!text.trim()) return [];
  return extractLocationHints(withoutDates(text)).slice(0, max);
}

const CJK_WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Looks like a venue name ("Dishoom Covent Garden", "Tasca do Chico"), not a sentence or a listicle. */
export function looksLikeVenue(title: string | undefined): boolean {
  const t = title?.trim();
  if (!t || t.length > 60 || /[!?#@:|•…\n]|https?:/i.test(t)) return false;
  // Latin words mixed with Chinese / Japanese / Korean ones read as a sentence ("Send畀佢 …"), not a name.
  if (CJK_WORDS.test(t) && /\p{Script=Latin}/u.test(t)) return false;
  if (/^(?:the\s+)?(?:(?:best|top|how|why|what|where|when|my|our|this|these)\b|\d)/i.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 6 || !/^\p{Lu}/u.test(words[0])) return false;
  return words.filter((w) => /^\p{Lu}/u.test(w)).length >= Math.ceil(words.length / 2);
}

/** Just the Place fields of a search result. */
export function placeFromResult(r: GeoResult): Place {
  const place: Place = { lat: r.lat, lng: r.lng };
  for (const k of ['name', 'address', 'city', 'country', 'countryCode'] as const) if (r[k]) place[k] = r[k];
  return place;
}

/** The country a hint (or, failing that, the rest of the text) names, e.g. "Kyoto" → "JP". Offline. */
export function countryHint(...texts: (string | undefined)[]): string | undefined {
  for (const t of texts) {
    const code = t ? guessCountry(t, { demonyms: false })?.code : undefined;
    if (code) return code;
  }
  return undefined;
}

/**
 * The first search result in the expected country. `strict` gives up when none is (or when
 * there's no expected country); otherwise it falls back to the first result.
 */
export function pickResult(results: GeoResult[], expected: string | undefined, strict = false): GeoResult | undefined {
  const match = expected ? results.find((r) => r.countryCode === expected) : undefined;
  return match ?? (strict ? undefined : results[0]);
}

/** A place for a whole city, region or country: the name the post used, in the country it must be in. */
export function areaPlace(c: PlaceCandidate, r: GeoResult): Place {
  const place: Place = { lat: r.lat, lng: r.lng, name: c.area === 'country' ? (r.country ?? c.query) : c.query };
  if (c.area === 'city') place.city = c.query;
  if (r.country) place.country = r.country;
  if (r.countryCode) place.countryCode = r.countryCode;
  return place;
}

interface Located {
  place?: Place;
  /** A search went out and was answered (or failed by itself), rather than being dropped (paused, offline, cancelled). */
  asked: boolean;
  /** …and it timed out or couldn't reach the service. */
  troubled: boolean;
}

/** The candidates name `code` more often than any other country. */
function clearly(candidates: PlaceCandidate[], code: string): boolean {
  const counts = new Map<string, number>();
  for (const c of candidates) if (c.countryCode) counts.set(c.countryCode, (counts.get(c.countryCode) ?? 0) + 1);
  const mine = counts.get(code) ?? 0;
  return [...counts].every(([k, n]) => k === code || n < mine);
}

const sameKey = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').includes(b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));

/**
 * Looks up where a save is, conservatively (a wrong location is worse than none): its best specific candidate (a
 * pinned venue or address, a known spot, or for a place save a venue-like page title), else the city, region or
 * country it names, kept as an area place so the save still files under its country. A result only counts in
 * the country the text points to. At most two searches.
 */
async function locate(item: Item, a: SaveAnalysis, preview: LinkPreview, priority: GeoPriority, parent?: AbortSignal): Promise<Located> {
  const candidates = a.candidates.filter((c) => c.countryCode);
  const top = candidates[0];
  if (!top) return { asked: false, troubled: false };
  // A city, region or country to fall back on, when the text can't be about another one: pinned, next to a pinned
  // spot, or the country it names clearly more than any other ("Hong Kong café in Manchester" names two).
  const area = candidates.find((c) => c.area && c.countryCode === top.countryCode && (c.marked || (top.marked && !top.area) || clearly(candidates, top.countryCode!)));
  const tries: { query: string; code: string; area?: PlaceCandidate }[] = [];
  // A page titled like a venue ("Dishoom Covent Garden"), not a caption: on a place save, that's what to find.
  const venue = item.type === 'place' && !a.caption && !(top.marked && !top.area) && looksLikeVenue(preview.title) ? preview.title : undefined;
  if (venue) {
    const near = area ?? top;
    tries.push({ query: sameKey(venue, near.query) ? venue : `${venue}, ${near.query}`, code: top.countryCode! });
  } else if (!top.area) tries.push({ query: top.query, code: top.countryCode! });
  if (area) tries.push({ query: area.query, code: area.countryCode!, area });

  // resolvePlaceDetails only passes a signal on, so for background work the signal carries the priority.
  const signal = priority === 'background' ? backgroundSignal(parent) : parent;
  let place: Place | undefined;
  for (const t of tries.slice(0, 2)) {
    if (signal?.aborted) break;
    let results: GeoResult[];
    try {
      results = await searchPlaces(t.query, undefined, { priority, signal });
    } catch {
      break;
    }
    if (t.area) {
      const r = results.find((x) => x.countryCode === t.code);
      if (r) place = areaPlace(t.area, r);
    } else {
      // Only the best match, and only in the right country.
      const r = pickResult(results.slice(0, 1), t.code, true);
      if (r) place = placeFromResult(r);
    }
    if (place) break;
  }
  const report = signal ? lookupReport(signal) : { asked: true, troubled: false };
  return { place, ...report };
}

// ---------------------------------------------------------------------------

const sameWhen = (a: When | undefined, b: When | undefined) => a?.start === b?.start && a?.end === b?.end;

interface Plan {
  changes: Partial<Item>;
  analysis: SaveAnalysis;
  /** A location should be looked up (the save has none and its text names one worth finding). */
  locate: boolean;
}

/** What the preview adds to the save, without touching anything the user has set. */
function planChanges(before: Item, item: Item, preview: LinkPreview, opts: EnrichOptions, link: boolean): Plan {
  const changes: Partial<Item> = {};
  const userSet = (f: EditedField) => !!item.edited?.includes(f);
  const locate = opts.locate !== false && !userSet('place');
  const fill = opts.overwrite ? () => true : (current: unknown) => !current;
  if (preview.image && fill(item.image)) changes.image = preview.image;
  if (preview.description && fill(item.description)) changes.description = preview.description;
  if (preview.siteName && fill(item.siteName)) changes.siteName = preview.siteName;

  // Short links carry no video ID or coordinates: keep where they lead instead, so embeds and maps work.
  const resolved = link && item.url === before.url ? resolvedShortLink(item.url, preview.finalUrl) : undefined;
  if (resolved && item.url) {
    changes.url = resolved;
    if (!item.sharedText?.trim()) changes.sharedText = item.url;
    const oldSource = classify({ url: item.url }).source;
    const newSource = classify({ url: resolved }).source;
    if (item.source === oldSource && newSource !== item.source) changes.source = newSource;
  }

  const finalUrl = safeUrl(preview.finalUrl);
  const url = changes.url ?? (isWall(finalUrl) ? undefined : finalUrl) ?? item.url;
  if (locate && !item.place) {
    // "/maps/place/<name>/@…" names the venue; a "/maps/search/<query>" doesn't.
    const fromFinal = finalUrl ? parsePlaceFromUrl(finalUrl) : {};
    if (fromFinal.place) changes.place = fromFinal.name && /\/maps\/place\//.test(finalUrl!) ? { ...fromFinal.place, name: fromFinal.name } : fromFinal.place;
    else if (changes.url) {
      const fromLink = parsePlaceFromUrl(changes.url).place;
      if (fromLink) changes.place = fromLink;
    }
  }

  // The title may change while it's automatic: what the save started with (the link's own, "Instagram reel"), an
  // account or platform name, or on an older post the account's display name. Never one the user typed.
  const generated = !userSet('title') && opts.replaceTitle && item.title === before.title;
  const a = analyzeSave(
    {
      url,
      source: changes.source ?? item.source,
      title: generated ? undefined : item.title,
      type: item.type,
      sharedText: changes.sharedText ?? item.sharedText,
      note: item.note,
      when: item.when,
      place: item.place,
      author: item.author,
      edited: item.edited,
    },
    preview,
  );
  const content = link && !!(preview.title || preview.description || preview.caption);

  if (link && a.title && a.title !== item.title && (generated || automaticTitle(item))) changes.title = a.title;

  // A generic kind (link, video, note) gives way to what the caption is about, with its tags.
  if (opts.reclassify && content) {
    if (item.type === before.type && a.type !== item.type) changes.type = a.type;
    const tags = userSet('tags') ? item.tags : mergeTags(item.tags, a.tags);
    if (tags.length !== item.tags.length) changes.tags = tags;
  }
  if (link && !item.author && a.author && (preview.author || content)) changes.author = a.author;

  // An event date from the caption, unless the user has set (or cleared) one. A date read from the post's "on
  // August 15, 2026" line (the day it went up) goes, and the caption's own date takes its place.
  if (link && !userSet('when')) {
    const type = changes.type ?? item.type;
    const date = opts.dates !== false && a.when && (a.whenConfidence === 'high' || type === 'event') ? a.when : undefined;
    if (a.dropWhen && sameWhen(before.when, item.when)) changes.when = date;
    else if (!before.when && !item.when && date) changes.when = date;
  }

  const wanted = locate && !item.place && !changes.place && shouldLocate(changes.type ?? item.type, a.candidates);
  // Looked at in full (kind and all): the start-up pass over older saves can skip it.
  if (opts.reclassify && content && item.analyzed !== ANALYSIS_VERSION) changes.analyzed = ANALYSIS_VERSION;
  // A place to look up: done now, or (if that's put off) by the start-up pass. Has one now: nothing to look up.
  if (wanted && !item.locatePending) changes.locatePending = true;
  else if (item.locatePending && (item.place || changes.place)) changes.locatePending = undefined;
  return { changes, analysis: a, locate: wanted };
}

/** Fields that are only bookkeeping: changing them alone gives no new version. */
const BOOKKEEPING = new Set<string>(['analyzed', 'locatePending']);

/** The changes with a new version, unless they're only bookkeeping (cards and caches then stay as they are). */
const versioned = (changes: Partial<Item>): Partial<Item> =>
  Object.keys(changes).some((k) => !BOOKKEEPING.has(k)) ? { ...changes, updatedAt: Date.now() } : changes;

/** Takes a save off the list of places to look up. */
const settled = (cur: Item): Partial<Item> | undefined => (cur.locatePending ? { locatePending: undefined } : undefined);

/** Re-reads the item and applies `patch(current)` in one transaction. Resolves true when something was written. */
async function guardedUpdate(id: string, patch: (current: Item) => Partial<Item> | undefined): Promise<boolean> {
  return db.transaction('rw', db.items, async () => {
    const current = await db.items.get(id);
    const changes = current && patch(current);
    if (!changes || !Object.keys(changes).length) return false;
    await db.items.update(id, versioned(changes));
    return true;
  });
}

/** The preview services answered with something (a YouTube thumbnail alone is worked out offline). */
function gotPreview(p: LinkPreview): boolean {
  return !!(p.title || p.description || p.finalUrl || p.siteName || p.author);
}

/**
 * Fills in a saved item from its link preview (title, image, type, tags, event date, where a short
 * link goes) and its location details — only what the user hasn't set. Needs link previews switched
 * on; any network failure just leaves the save as it was. Resolves true when a preview was fetched
 * (false when offline, blocked, switched off, cancelled or there's no link).
 */
export async function enrichItem(id: string, opts: EnrichOptions): Promise<boolean> {
  if (!getSettings().previews) return false;
  const before = await db.items.get(id);
  if (!before) return false;
  const link = safeUrl(before.url);
  // Someone waiting on it ("Refresh preview") may ask even while the preview service's allowance is used up.
  const preview: LinkPreview = link ? await fetchPreview(link, opts.signal, { force: opts.priority === 'user' }) : {};
  if (opts.signal?.aborted) return false;
  const fetched = gotPreview(preview);
  if (!fetched && preview.problem) opts.onProblem?.(preview.problem);

  // Network first, then one short transaction: never hold one open across a fetch (or the text analysis).
  const ahead = planChanges(before, before, preview, opts, !!link);
  const planned = await db.transaction('rw', db.items, async (): Promise<{ item: Item; plan: Plan } | undefined> => {
    const current = await db.items.get(id);
    if (!current) return undefined;
    // Changed while the preview loaded: planned again from what's there now.
    const plan = JSON.stringify(current) === JSON.stringify(before) ? ahead : planChanges(before, current, preview, opts, !!link);
    const { changes } = plan;
    // Remember when the platform won't show the post (so the save can say why it's bare), and forget it once it does.
    if (fetched && current.previewIssue) changes.previewIssue = undefined;
    else if (!fetched && preview.problem === 'unavailable' && !current.previewIssue) changes.previewIssue = 'unavailable';
    if (Object.keys(changes).length) await db.items.update(id, versioned(changes));
    return { item: { ...current, ...changes }, plan };
  });
  if (!planned) return fetched;
  const { item, plan } = planned;
  // Signed image links (Instagram, Facebook…) stop working within days: keep a small copy on this device.
  if (plan.changes.image) void keepThumb(id, plan.changes.image);
  if (!getSettings().previews) return fetched;

  const places = enrichPlace(id, item, plan, preview, opts);
  if (opts.waitForPlace === false) void places.catch(() => undefined);
  else await places;
  return fetched;
}

/**
 * A note was written or pasted on a save (the caption of a post the preview service couldn't read): looks in it
 * for an event date and a place, like for any other text, and fills them in when the save has none. Offline for
 * the date; the place is looked up like any other. Leaves what the user set or cleared alone. Never throws.
 */
export async function analyzeNote(id: string): Promise<void> {
  try {
    const item = await db.items.get(id);
    if (!item?.note?.trim()) return;
    const opts: EnrichOptions = { replaceTitle: false, reclassify: false, dates: true, locate: true, priority: 'user' };
    const plan = planChanges(item, item, {}, opts, true);
    const applied = await db.transaction('rw', db.items, async (): Promise<Item | undefined> => {
      const current = await db.items.get(id);
      // Changed while this was working out: the next edit analyses again.
      if (!current || current.note !== item.note) return undefined;
      if (Object.keys(plan.changes).length) await db.items.update(id, versioned(plan.changes));
      return { ...current, ...plan.changes };
    });
    if (applied && getSettings().previews) await enrichPlace(id, applied, plan, {}, opts);
  } catch {
    /* the note is saved; nothing more to do */
  }
}

/** Finds a location when the save has none and fills in its details, then writes both at once. */
async function enrichPlace(id: string, item: Item, plan: Plan, preview: LinkPreview, opts: EnrichOptions): Promise<void> {
  const priority = opts.priority ?? 'background';
  // The geo service keeps timing out: skip quietly. The startup backfill catches up later.
  if (priority === 'background' && geoHealth().paused) return;
  const { signal } = opts;

  let place = item.place;
  let done = false;
  if (plan.locate) {
    const found = await locate(item, plan.analysis, preview, priority, signal);
    place = found.place;
    // Looked up (found or not): not tried again. Dropped or troubled: the start-up pass tries again another time.
    done = found.asked && !found.troubled;
  }
  if (signal?.aborted) return;
  if (!place) {
    if (done) await guardedUpdate(id, settled);
    return;
  }

  const at = place;
  let full = at;
  if (needsDetails(at) && getSettings().previews) {
    // resolvePlaceDetails only passes a signal on, so for background work the signal carries the priority.
    const geoSignal = priority === 'background' ? backgroundSignal(signal) : signal;
    // For a place save the title already names the venue; a neighbour's name from the lookup would be wrong.
    full = await resolvePlaceDetails(at, { name: item.type !== 'place', signal: geoSignal }).catch(() => at);
  }
  if (signal?.aborted) return;
  // A place we found: only if the user hasn't set (or cleared) one meanwhile.
  if (plan.locate) await guardedUpdate(id, (cur) => (cur.place || cur.edited?.includes('place') ? settled(cur) : { place: full, locatePending: undefined }));
  else if (full !== at) {
    await guardedUpdate(id, (cur) => {
      // Only if the location hasn't been changed in the meantime.
      if (!cur.place || cur.place.lat !== at.lat || cur.place.lng !== at.lng) return undefined;
      const merged = mergePlaceDetails(cur.place, full);
      return merged === cur.place ? undefined : { place: merged };
    });
  }
}

/**
 * Looks up where a stored save is, from what's stored with it (backfill.ts), and takes it off the list of places to
 * look up (Item.locatePending) once that's settled. Never when the user set or cleared its place. Resolves whether a
 * search went out and whether it ran into trouble (a timeout or network error).
 */
export async function locateSaved(id: string, signal?: AbortSignal): Promise<{ asked: boolean; troubled: boolean; located: boolean }> {
  const item = await db.items.get(id);
  if (!item) return { asked: false, troubled: false, located: false };
  const preview = storedPreview(item);
  const analysis = item.place || item.edited?.includes('place') ? undefined : analyzeSave(item, preview);
  // The stored title is the user's (or the caption's), not a page title to search for.
  delete preview.title;
  if (!analysis || !shouldLocate(item.type, analysis.candidates)) {
    await guardedUpdate(id, settled);
    return { asked: false, troubled: false, located: false };
  }
  const found = await locate(item, analysis, preview, 'background', signal);
  if (signal?.aborted) return { ...found, located: false };
  let full = found.place;
  if (full && needsDetails(full)) {
    const at = full;
    full = await resolvePlaceDetails(at, { name: item.type !== 'place', signal: backgroundSignal(signal) }).catch(() => at);
  }
  let located = false;
  if (full || (found.asked && !found.troubled)) {
    await guardedUpdate(id, (cur) => {
      if (full && !cur.place && !cur.edited?.includes('place')) {
        located = true;
        return { place: full, locatePending: undefined };
      }
      return settled(cur);
    });
  }
  return { asked: found.asked, troubled: found.troubled, located };
}
