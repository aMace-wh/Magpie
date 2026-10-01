import { db } from './db';
import { backgroundSignal, geoHealth, lookupReport, whenUserIdle } from './geo';
import { mergePlaceDetails, needsDetails, resolvePlaceDetails } from './location';
import { getSettings } from './settings';

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
