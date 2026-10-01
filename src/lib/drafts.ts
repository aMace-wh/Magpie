import { db, dbHealth } from './db';
import { withTimeout } from './dbHealth';
import { enrichItem, type EnrichOptions } from './enrich';
import type { ItemType, Place, When } from './types';

/**
 * Saves that haven't been confirmed yet: in flight, or failed because storage wasn't answering. A failed write can
 * still land later (held up behind another tab, or a connection that comes back), so each is remembered with its
 * id. Saving the same draft again reuses the id (no copy), reloading Magpie brings the draft back, and a draft
 * that landed after all gets its preview and is let go. Kept in sessionStorage, so they survive a reload of this tab.
 * Saves only ever add (see saveItem), so a reused id can't write over a save that's already in the library.
 */

/** Something the user chose (possibly "nothing"), as opposed to what Magpie guessed. `null` = untouched. */
export type Choice<T> = { value: T | undefined } | null;

/** What the save sheet holds. */
export interface DraftFields {
  text: string;
  /** Text other apps handed over, kept as the original post. */
  handed: string[];
  type: ItemType | null;
  title: string | null;
  tags: string[] | null;
  note: string | null;
  when: Choice<When>;
  place: Choice<Place>;
  collectionIds: string[];
}

export interface UnsavedDraft extends DraftFields {
  /** The id it's saved under, every time. */
  id: string;
  /** How to fetch its preview once it's in. */
  enrich: EnrichOptions;
  at: number;
}

const KEY = 'magpie:unsaved-drafts';
const MAX_DRAFTS = 5;
/** A draft this old is let go. */
const MAX_AGE_MS = 86400000;
const CHECK_TIMEOUT_MS = 3000;

let drafts: UnsavedDraft[] | undefined;
/** Ids being saved right now: their save fetches the preview itself. */
const saving = new Set<string>();
/** Ids known to be in the library (saved, or found there), so a slower attempt that fails doesn't say otherwise. */
const confirmed = new Set<string>();

function load(): UnsavedDraft[] {
  if (drafts) return drafts;
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as unknown;
    drafts = Array.isArray(raw) ? raw.filter((d): d is UnsavedDraft => !!d && typeof d.id === 'string' && typeof d.text === 'string') : [];
  } catch {
    drafts = [];
  }
  const now = Date.now();
  drafts = drafts.filter((d) => now - d.at < MAX_AGE_MS);
  return drafts;
}

function store(list: UnsavedDraft[]): void {
  drafts = list.slice(-MAX_DRAFTS);
  try {
    if (drafts.length) sessionStorage.setItem(KEY, JSON.stringify(drafts));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Private mode or full: this page's memory is enough.
  }
}

/** Remembers a draft (replacing an older one with the same id) before trying to save it. */
export function rememberDraft(draft: UnsavedDraft): void {
  store([...load().filter((d) => d.id !== draft.id), draft]);
  watch();
}

export function forgetDraft(id: string): void {
  if (load().some((d) => d.id === id)) store(load().filter((d) => d.id !== id));
}

/** The draft is in the library: lets it go. */
export function confirmDraft(id: string): void {
  confirmed.add(id);
  forgetDraft(id);
}

/** Whether this draft made it into the library (in this page), by any attempt. */
export function isConfirmed(id: string): boolean {
  return confirmed.has(id);
}

export function findDraft(id: string): UnsavedDraft | undefined {
  return load().find((d) => d.id === id);
}

/** The latest unconfirmed draft with this text, so sharing the same thing again reuses its id. */
export function draftFor(text: string): UnsavedDraft | undefined {
  const t = text.trim();
  return t ? load().findLast((d) => d.text.trim() === t) : undefined;
}

/** Marks a draft as being saved (its save fetches the preview) or not. */
export function markSaving(id: string, on: boolean): void {
  if (on) saving.add(id);
  else saving.delete(id);
}

/**
 * Looks for drafts whose save landed after all, fetches their previews and lets them go. Runs when storage starts
 * working again, and on start-up after a reload. Resolves to the ids found.
 */
export async function settleDrafts(): Promise<string[]> {
  const found: string[] = [];
  for (const draft of [...load()]) {
    if (saving.has(draft.id)) continue;
    let item;
    try {
      item = await withTimeout(db.items.get(draft.id), CHECK_TIMEOUT_MS, 'Checking a draft');
    } catch {
      return found; // storage still isn't answering: next time
    }
    if (!item || saving.has(draft.id) || !findDraft(draft.id)) continue;
    confirmDraft(draft.id);
    found.push(draft.id);
    void enrichItem(draft.id, draft.enrich).catch(() => {});
  }
  return found;
}

let watching = false;

/** Settles drafts each time storage becomes ready (after a block, a stall or a reopen). */
function watch(): void {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  let ready = dbHealth.getSnapshot().status === 'ready';
  if (ready) void settleDrafts();
  dbHealth.subscribe(() => {
    const now = dbHealth.getSnapshot().status === 'ready';
    if (now && !ready && load().length) void settleDrafts();
    ready = now;
  });
}

// Drafts left from before a reload: watch for theirs.
if (typeof sessionStorage !== 'undefined' && load().length) watch();

/** Forgets every unsaved draft (deleting everything in Settings). */
export function clearDrafts(): void {
  store([]);
}

/** Forgets everything. For tests. */
export function resetDrafts(): void {
  drafts = undefined;
  saving.clear();
  confirmed.clear();
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored.
  }
}
