import { classify, parsePlaceFromUrl, safeUrl } from './classify';
import { db, uniqueTags } from './db';
import { searchPlaces, type GeoResult } from './geo';
import { extractLocationHints, guessCountry, mergePlaceDetails, needsDetails, resolvePlaceDetails } from './location';
import { fetchPreview, type LinkPreview } from './metadata';
import { getSettings } from './settings';
import type { Item, Place } from './types';
import { findWhen } from './when';

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

/** Where a short link really goes, when the preview followed it somewhere useful (not a login wall or a home page). */
export function resolvedShortLink(url: string | undefined, finalUrl: string | undefined): string | undefined {
  if (!isShortLink(url)) return undefined;
  const target = safeUrl(finalUrl);
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

/** The text with its date phrase(s) blanked out, so "📍 Lisbon — Sat 10 Oct" doesn't become a place called "Lisbon, Sat 10 Oct". */
function withoutDates(text: string, now = new Date()): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const m = findWhen(out, now);
    if (!m) break;
    // Take a joining word or dash in front of it along ("Lisbon on 12 Oct", "Lisbon · Sat 12 Oct").
    const lead = /(?:[ \t]+(?:on|from|until|till|til|this|next)|[ \t]*[,·•|–—-])[ \t]*$/i.exec(out.slice(0, m.index));
    const start = lead ? lead.index : m.index;
    out = `${out.slice(0, start)}\n${out.slice(m.index + m.length)}`;
  }
  return out;
}

/** Likely place mentions in shared text, best first (offline). */
export function locationHints(text: string, max = 5): string[] {
  if (!text.trim()) return [];
  return extractLocationHints(withoutDates(text)).slice(0, max);
}

const MARKER_RE = /(?:\u{1F4CD}|\u{1F4CC})\uFE0F?|\b(?:location|address|venue|where|located at|find us at)[ \t]*[:\uFF1A]/giu;
const hintKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Hints written right after an explicit marker: "📍 Kyoto", "Location: Borough Market, London". */
function markedHints(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    const line = text.slice(m.index).split('\n')[0];
    const value = hintKey(line.slice(m[0].length));
    const first = extractLocationHints(line)[0];
    // Only when the value itself is the place, not something mentioned later on the line.
    if (first && value.startsWith(hintKey(first.split(',')[0]))) out.push(first);
  }
  return out;
}

/** Looks like a venue name ("Dishoom Covent Garden", "Tasca do Chico"), not a sentence or a listicle. */
export function looksLikeVenue(title: string | undefined): boolean {
  const t = title?.trim();
  if (!t || t.length > 60 || /[!?#@:|•…\n]|https?:/i.test(t)) return false;
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

/** A conservative guess at where a place / event save is. Wrong locations are worse than none. */
async function autoLocate(item: Item, preview: LinkPreview): Promise<Place | undefined> {
  const text = withoutDates([item.title, item.sharedText, item.note, preview.description].filter(Boolean).join('\n'));
  const first = extractLocationHints(text)[0];
  if (!first) return undefined;
  let query: string | undefined;
  if (markedHints(text).some((h) => hintKey(h) === hintKey(first))) query = first;
  else if (item.type === 'place' && preview.title && looksLikeVenue(preview.title)) {
    query = hintKey(preview.title).includes(hintKey(first)) ? preview.title : `${preview.title}, ${first}`;
  }
  // Only when we can check the answer is in the right country.
  const expected = countryHint(first, text);
  if (!query || !expected) return undefined;
  try {
    const top = (await searchPlaces(query))[0];
    const fits = top && pickResult([top], expected, true);
    return fits ? placeFromResult(fits) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------

/** What the preview adds to the save, without touching anything the user has set. */
function planChanges(before: Item, item: Item, preview: LinkPreview, opts: EnrichOptions): Partial<Item> {
  const changes: Partial<Item> = {};
  const locate = opts.locate !== false;
  const fill = opts.overwrite ? () => true : (current: unknown) => !current;
  if (preview.image && fill(item.image)) changes.image = preview.image;
  if (preview.description && fill(item.description)) changes.description = preview.description;
  if (preview.siteName && fill(item.siteName)) changes.siteName = preview.siteName;
  // Only replace the title if the user hasn't edited it in the meantime.
  if (preview.title && opts.replaceTitle && item.title === before.title) changes.title = preview.title;

  // Short links carry no video ID or coordinates: keep where they lead instead, so embeds and maps work.
  const resolved = item.url === before.url ? resolvedShortLink(item.url, preview.finalUrl) : undefined;
  if (resolved && item.url) {
    changes.url = resolved;
    if (!item.sharedText?.trim()) changes.sharedText = item.url;
    const oldSource = classify({ url: item.url }).source;
    const newSource = classify({ url: resolved }).source;
    if (item.source === oldSource && newSource !== item.source) changes.source = newSource;
  }

  const finalUrl = safeUrl(preview.finalUrl);
  if (locate && !item.place && finalUrl) {
    const { place, name } = parsePlaceFromUrl(finalUrl);
    // "/maps/place/<name>/@…" names the venue; a "/maps/search/<query>" doesn't.
    if (place) changes.place = name && /\/maps\/place\//.test(finalUrl) ? { ...place, name } : place;
  }

  if (opts.reclassify && item.type === before.type && (preview.title || preview.description)) {
    const better = classify({
      // The raw title keeps the caption's hashtags, which are good evidence and tags.
      title: preview.rawTitle ?? preview.title ?? item.title,
      text: [preview.description, item.note].filter(Boolean).join('\n'),
      url: changes.url ?? (isWall(finalUrl) ? undefined : finalUrl) ?? item.url,
    });
    const generic = item.type === 'link' || item.type === 'video' || item.type === 'note';
    if (better.confidence !== 'low' && better.type !== item.type && generic) changes.type = better.type;
    const tags = uniqueTags([...item.tags, ...better.tags]).slice(0, Math.max(item.tags.length, 6));
    if (tags.length !== item.tags.length) changes.tags = tags;
    if (locate && !item.place && !changes.place && better.place) changes.place = better.place;
  }

  // An event date from the page or caption, unless the user has set (or cleared) one.
  if (opts.dates !== false && !before.when && !item.when) {
    const type = changes.type ?? item.type;
    const text = [preview.rawTitle ?? preview.title, preview.description, item.sharedText, item.note].filter(Boolean).join('\n');
    const m = findWhen(text);
    if (m && (m.confidence === 'high' || type === 'event')) changes.when = m.when;
  }
  return changes;
}

/** Re-reads the item and applies `patch(current)` in one transaction. Resolves true when something was written. */
async function guardedUpdate(id: string, patch: (current: Item) => Partial<Item> | undefined): Promise<boolean> {
  return db.transaction('rw', db.items, async () => {
    const current = await db.items.get(id);
    const changes = current && patch(current);
    if (!changes || !Object.keys(changes).length) return false;
    await db.items.update(id, { ...changes, updatedAt: Date.now() });
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
 * (false when offline, blocked, switched off or there's no link).
 */
export async function enrichItem(id: string, opts: EnrichOptions): Promise<boolean> {
  if (!getSettings().previews) return false;
  const before = await db.items.get(id);
  if (!before) return false;
  const link = safeUrl(before.url);
  const preview: LinkPreview = link ? await fetchPreview(link) : {};
  const fetched = gotPreview(preview);

  const item = await db.transaction('rw', db.items, async (): Promise<Item | undefined> => {
    const current = await db.items.get(id);
    if (!current) return undefined;
    const changes = link ? planChanges(before, current, preview, opts) : {};
    if (Object.keys(changes).length) await db.items.update(id, { ...changes, updatedAt: Date.now() });
    return { ...current, ...changes };
  });
  if (!item || !getSettings().previews) return fetched;

  let place = item.place;
  if (!place && opts.locate !== false && (item.type === 'place' || item.type === 'event')) {
    const found = await autoLocate(item, preview);
    if (found && (await guardedUpdate(id, (cur) => (cur.place ? undefined : { place: found })))) place = found;
  }

  if (place && needsDetails(place) && getSettings().previews) {
    const at = place;
    // For a place save the title already names the venue; a neighbour's name from the lookup would be wrong.
    const full = await resolvePlaceDetails(at, { name: item.type !== 'place' }).catch(() => at);
    if (full === at) return fetched;
    await guardedUpdate(id, (cur) => {
      // Only if the location hasn't been changed in the meantime.
      if (!cur.place || cur.place.lat !== at.lat || cur.place.lng !== at.lng) return undefined;
      const merged = mergePlaceDetails(cur.place, full);
      return merged === cur.place ? undefined : { place: merged };
    });
  }
  return fetched;
}
