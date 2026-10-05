import { classify, safeUrl } from './classify';
import { db } from './db';
import { enrichItem, locateSaved, type EnrichOptions } from './enrich';
import { backgroundSignal, geoHealth, lookupReport, whenUserIdle } from './geo';
import { mergePlaceDetails, needsDetails, resolvePlaceDetails } from './location';
import { previewsLimitedUntil } from './metadata';
import { getSettings } from './settings';
import { brokenImageIds, clearBrokenImage } from './thumbs';
import type { Item } from './types';
import { analyzeSave, ANALYSIS_VERSION, reanalysisChanges, storedPreview, wantsLookup } from './understand';
import { whenIdle, whenWarm, type IdleDeadlineLike } from './warmup';

/**
 * Fills in city / country for older saves whose location is just coordinates, a few per
 * session and politely (the geo queue spaces lookups ~1 s apart). Runs in the background:
 * behind the user's own lookups, and not at all while the geo service keeps timing out.
 */

const TRIED_KEY = 'magpie:place-details-tried';
/** A spot that couldn't be resolved is retried after this long, so it can't hold up newer ones forever. */
const RETRY_MS = 86400000;

let running: Promise<number> | undefined;
// Tried this session (whatever the outcome), so a second run doesn't ask again.
const triedNow = new Set<string>();

function loadTried(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(TRIED_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function saveTried(tried: Record<string, number>, now: number): void {
  try {
    const fresh = Object.entries(tried).filter(([, at]) => typeof at === 'number' && now - at < RETRY_MS);
    localStorage.setItem(TRIED_KEY, JSON.stringify(Object.fromEntries(fresh)));
  } catch {
    /* private mode — this session's memory is enough */
  }
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const canRun = () => getSettings().previews && !offline() && !geoHealth().paused;

/** Clears the per-session memory. For tests. */
export function resetBackfillState(): void {
  triedNow.clear();
  running = undefined;
  reanalyzing = undefined;
  retrying = undefined;
  memory.clear();
}

/**
 * Looks up missing place details for up to `limit` saves (oldest first), one at a time.
 * Never overwrites what's there and skips a save whose location changed meanwhile.
 * Does nothing when link previews are off, the device is offline or background lookups are
 * paused; waits while the user is looking up a place, and stops at the first timeout or
 * network error. A second call while one is running gets the same run. Resolves to the
 * number of saves updated.
 */
export function backfillPlaceDetails({ limit = 20 }: { limit?: number } = {}): Promise<number> {
  if (running) return running;
  const current: Promise<number> = run(limit).finally(() => {
    if (running === current) running = undefined;
  });
  running = current;
  return current;
}

async function run(limit: number): Promise<number> {
  // The user's own lookups go first.
  await whenUserIdle();
  if (!canRun()) return 0;
  const now = Date.now();
  const tried = loadTried();
  const recent = (at: unknown) => typeof at === 'number' && now - at < RETRY_MS;
  const due = (await db.items.orderBy('createdAt').toArray()).filter(
    (item) => needsDetails(item.place) && !triedNow.has(item.id) && !recent(tried[item.id]),
  );

  let updated = 0;
  for (const item of due.slice(0, Math.max(0, limit))) {
    await whenUserIdle();
    if (!canRun()) break;
    const place = item.place!;
    triedNow.add(item.id);
    // Marked and saved before asking, so a lookup that never answers (or an app closed
    // mid-run) isn't repeated on every launch.
    tried[item.id] = Date.now();
    saveTried(tried, Date.now());
    const signal = backgroundSignal();
    let full = place;
    try {
      // A place save's title already names the venue; don't take a neighbour's name.
      full = await resolvePlaceDetails(place, { name: item.type !== 'place', signal });
    } catch {
      /* lookups fail quietly */
    }
    const wrote =
      full !== place &&
      (await db.transaction('rw', db.items, async () => {
        const current = (await db.items.get(item.id))?.place;
        // Only if the location hasn't been changed in the meantime.
        if (!current || current.lat !== place.lat || current.lng !== place.lng) return false;
        const merged = mergePlaceDetails(current, full);
        if (merged === current) return false;
        await db.items.update(item.id, { place: merged, updatedAt: Date.now() });
        return true;
      }));
    if (wrote) updated++;
    // What became of this save's own lookup (others may have failed meanwhile and paused lookups).
    const { asked, troubled } = lookupReport(signal);
    // Nothing found although it was asked (or timed out): give it a rest. Never asked (offline, paused,
    // cancelled): try again next time.
    const rest = full === place && asked && !offline();
    if (!rest) {
      delete tried[item.id];
      saveTried(tried, Date.now());
    }
    // A timeout or network error: the next lookups wouldn't fare better.
    if (troubled) break;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Looking again at older saves

let reanalyzing: Promise<number> | undefined;

/**
 * Writes a slice's changes in one go, skipping saves edited since they were read (looked at again next time).
 * Resolves to how many saves' content changed, and the saves written.
 */
async function applyChanges(batch: { item: Item; changes: Partial<Item> }[]): Promise<{ changed: number; written: Set<string> }> {
  const written = new Set<string>();
  if (!batch.length) return { changed: 0, written };
  const changed = await db.transaction('rw', db.items, async () => {
    let n = 0;
    const now = Date.now();
    for (const { item, changes } of batch) {
      const current = await db.items.get(item.id);
      if (!current || current.updatedAt !== item.updatedAt) continue;
      // Only the bookkeeping: no new version, so cards and caches stay as they are.
      const content = Object.keys(changes).some((k) => k !== 'analyzed' && k !== 'locatePending');
      await db.items.update(item.id, content ? { ...changes, updatedAt: now } : changes);
      written.add(item.id);
      if (content) n++;
    }
    return n;
  });
  return { changed, written };
}

const nextIdle = () => new Promise<IdleDeadlineLike>((resolve) => whenIdle(resolve, { timeout: 5000 }));

/**
 * Looks again, once, at saves analysed by an older version of the text analysis (understand.ts), newest first:
 * a caption title over an account name, a better kind over a generic one, the posting date dropped, tags, the
 * author and the description without its likes / date wrapper. Offline, a few saves per idle moment, and only
 * what looks automatic, never what the user set (Item.edited). Saves with a place worth looking up are listed
 * (Item.locatePending), and up to `locate` of those are looked up per run (politely, in the background). A second
 * call while one runs gets the same run. Resolves to the number of saves changed.
 */
export function reanalyzeSaves({ locate = 5 }: { locate?: number } = {}): Promise<number> {
  if (reanalyzing) return reanalyzing;
  const current: Promise<number> = reanalyze(locate).finally(() => {
    if (reanalyzing === current) reanalyzing = undefined;
  });
  reanalyzing = current;
  return current;
}

async function reanalyze(locateLimit: number): Promise<number> {
  const items = await db.items.toArray();
  const newest = (a: Item, b: Item) => b.createdAt - a.createdAt;
  const due = items.filter((i) => (i.analyzed ?? 0) < ANALYSIS_VERSION).sort(newest);
  // Places still to look up, from earlier runs and this one.
  const pending = new Set(items.filter((i) => i.locatePending && !i.place).map((i) => i.id));
  let changed = 0;
  for (let i = 0; i < due.length; ) {
    const deadline = await nextIdle();
    const batch: { item: Item; changes: Partial<Item> }[] = [];
    const lookups: string[] = [];
    // At least one save per idle moment, more while there's time.
    do {
      const item = due[i++];
      // Settled in one go; a place to look up is listed, and a few are looked up per launch (below).
      let changes: Partial<Item> = { analyzed: ANALYSIS_VERSION };
      try {
        const a = analyzeSave(item, storedPreview(item));
        changes = { ...reanalysisChanges(item, a), analyzed: ANALYSIS_VERSION };
        if (wantsLookup(item, a, changes.type ?? item.type)) {
          changes.locatePending = true;
          lookups.push(item.id);
        }
      } catch {
        // A save the analysis can't read is left as it is, and not tried on every launch.
      }
      batch.push({ item, changes });
    } while (i < due.length && deadline.timeRemaining() > 6);
    const done = await applyChanges(batch);
    changed += done.changed;
    for (const id of lookups) if (done.written.has(id)) pending.add(id);
  }

  const createdAt = new Map(items.map((i) => [i.id, i.createdAt]));
  const order = [...pending].sort((a, b) => (createdAt.get(b) ?? 0) - (createdAt.get(a) ?? 0));
  for (const id of order.slice(0, Math.max(0, locateLimit))) {
    await whenUserIdle();
    if (!canRun()) break;
    const r = await locateSaved(id).catch(() => ({ located: false, troubled: true }));
    if (r.located) changed++;
    // A timeout or network error: the next lookups wouldn't fare better.
    if (r.troubled) break;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Previews that never came, and pictures that stopped working

const TRIES_KEY = 'magpie:preview-tries';
const BUDGET_KEY = 'magpie:preview-budget';
/** A save's preview is asked for again after this long, doubling with each try… */
const RETRY_PREVIEW_MS = 12 * 3600_000;
/** …up to this many tries. */
const MAX_TRIES = 8;
/** Background preview fetches a day at most: the preview service's free allowance is about 50. */
const DAILY_BUDGET = 20;

let retrying: Promise<number> | undefined;
// When localStorage isn't available, this session remembers.
const memory = new Map<string, string>();

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key) ?? memory.get(key);
    const v = raw ? (JSON.parse(raw) as unknown) : undefined;
    return v && typeof v === 'object' ? (v as T) : fallback;
  } catch {
    const raw = memory.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try {
    localStorage.setItem(key, raw);
  } catch {
    /* private mode: this session's memory is enough */
  }
}

type Tries = Record<string, { at: number; n: number }>;

const today = () => new Date().toDateString();

function spend(): boolean {
  const b = readJson<{ day?: string; n?: number }>(BUDGET_KEY, {});
  const n = b.day === today() ? (b.n ?? 0) : 0;
  if (n >= DAILY_BUDGET) return false;
  writeJson(BUDGET_KEY, { day: today(), n: n + 1 });
  return true;
}

/** A link save with nothing from its preview at all: no picture, description or site name. */
const bare = (i: Item) => !!safeUrl(i.url)?.startsWith('http') && !i.image && !i.description?.trim() && !i.siteName;

const RETRY_OPTIONS: Omit<EnrichOptions, 'replaceTitle'> = { reclassify: true, priority: 'background' };
const PICTURE_OPTIONS: EnrichOptions = { replaceTitle: false, reclassify: false, overwrite: true, dates: false, locate: false, priority: 'background' };

const canFetch = () => getSettings().previews && !offline() && !previewsLimitedUntil();

/**
 * Asks again for the previews of up to `missing` link saves that never got one (the service timed out, was out
 * of requests or hit a wall), each at most every 12 hours and less often after that, and for fresh pictures for
 * up to `pictures` saves whose picture stopped loading (brokenImageIds). Newest first, one at a time, at most
 * 20 a day in all, and none once the preview service says its daily allowance is used up. Does nothing offline
 * or with link previews off. Resolves to the number of previews that came back.
 */
export function retryPreviews({ missing = 5, pictures = 5 }: { missing?: number; pictures?: number } = {}): Promise<number> {
  if (retrying) return retrying;
  const current: Promise<number> = retry(missing, pictures).finally(() => {
    if (retrying === current) retrying = undefined;
  });
  retrying = current;
  return current;
}

async function retry(missing: number, pictures: number): Promise<number> {
  if (!canFetch()) return 0;
  const now = Date.now();
  const tries = readJson<Tries>(TRIES_KEY, {});
  const due = (id: string) => {
    const t = tries[id];
    return !t || (t.n < MAX_TRIES && now - t.at >= RETRY_PREVIEW_MS * 2 ** (t.n - 1));
  };
  const items = await db.items.toArray();
  const byId = new Map(items.map((i) => [i.id, i]));
  const jobs: { item: Item; picture: boolean }[] = items
    .filter((i) => bare(i) && due(i.id))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.max(0, missing))
    .map((item) => ({ item, picture: false }));
  let broken = 0;
  for (const id of brokenImageIds()) {
    if (broken >= pictures) break;
    const item = byId.get(id);
    // Gone, or nothing to ask about.
    if (!item || !safeUrl(item.url)?.startsWith('http')) {
      clearBrokenImage(id);
      continue;
    }
    if (!due(id) || jobs.some((j) => j.item.id === id)) continue;
    jobs.push({ item, picture: true });
    broken++;
  }

  let got = 0;
  for (const { item, picture } of jobs) {
    if (!canFetch() || !spend()) break;
    // Marked before asking, so a fetch that never ends (or an app closed meanwhile) isn't repeated on every launch.
    tries[item.id] = { at: Date.now(), n: (tries[item.id]?.n ?? 0) + 1 };
    writeJson(TRIES_KEY, pruneTries(tries));
    // An automatic title is what the link alone gives ("Instagram reel", "example.com"): a real one may replace it.
    // A date or place is only looked for when the save has none (and enrichItem leaves what the user cleared alone).
    const opts = picture
      ? PICTURE_OPTIONS
      : { ...RETRY_OPTIONS, replaceTitle: item.title === classify({ url: item.url }).title, dates: !item.when, locate: !item.place };
    const fetched = await enrichItem(item.id, opts).catch(() => false);
    if (fetched) {
      got++;
      delete tries[item.id];
      writeJson(TRIES_KEY, pruneTries(tries));
      if (picture) clearBrokenImage(item.id);
    }
  }
  return got;
}

/** Drops entries that have used up their tries long ago, so the list can't grow forever. */
function pruneTries(tries: Tries): Tries {
  const old = Date.now() - 30 * 86400000;
  for (const [id, t] of Object.entries(tries)) if (!t || typeof t.at !== 'number' || t.at < old) delete tries[id];
  return tries;
}

// ---------------------------------------------------------------------------

/**
 * The background work after start-up, one pass after another: older saves looked at again (and a few located),
 * missing place details, then previews that never came and pictures that stopped working. Never throws.
 */
export async function backgroundWork(): Promise<void> {
  // The analysis compiles its patterns in the start-up warm-up's idle slices: not all at once here.
  await Promise.race([whenWarm(), new Promise((resolve) => setTimeout(resolve, 30_000))]);
  await reanalyzeSaves().catch(() => 0);
  await backfillPlaceDetails().catch(() => 0);
  await retryPreviews().catch(() => 0);
}
