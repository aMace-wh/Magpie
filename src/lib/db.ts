import Dexie, { type EntityTable } from 'dexie';
import { classify, itemFieldsFrom, normalizeTag, type SharedInput } from './classify';
import { isAlreadySaved, isStorageFailure, isTimeout, monitorDb, saveWithRetry, type DbStatus } from './dbHealth';
import { uid } from './id';
import { EDITED_FIELDS, type Collection, type Item } from './types';
import { findWhen } from './when';

/** A small copy of a save's picture kept on this device (thumbs.ts). Never part of a backup or a share. */
export interface ThumbRow {
  /** The save's id: one copy per save. */
  id: string;
  /** The image it's a copy of (the save's `image` when it was made). */
  src: string;
  blob: Blob;
  /** When it was made; the oldest go first when there are too many. */
  at: number;
}

export const db = new Dexie('magpie') as Dexie & {
  items: EntityTable<Item, 'id'>;
  collections: EntityTable<Collection, 'id'>;
  thumbs: EntityTable<ThumbRow, 'id'>;
};

db.version(1).stores({
  items: 'id, type, status, createdAt, updatedAt, doneAt, *tags, *collectionIds',
  collections: 'id, createdAt, name',
});
// v2: events (`when`), place countries and friend shares. New fields are optional, so no data migration.
db.version(2).stores({
  items: 'id, type, status, createdAt, updatedAt, doneAt, *tags, *collectionIds, when.start, place.countryCode',
  collections: 'id, createdAt, name, from.shareId',
});
// v3: local copies of thumbnails, since some image links (Instagram, Facebook…) stop working after a few days.
db.version(3).stores({ thumbs: 'id, at, [id+src]' });

/** How the database is doing (opening, slow, blocked, lost…), for the status banner and Diagnostics. */
export const dbHealth = monitorDb(db, {
  probe: () => db.items.limit(1).primaryKeys(),
  doc: typeof document === 'undefined' ? undefined : document,
});

/** Closes and reopens the database once (concurrent calls share the attempt). */
export const recoverDb = (reason?: string): Promise<void> => dbHealth.recover(reason);

const STUCK = new Set<DbStatus>(['stuck', 'lost', 'error']);

// ---------------------------------------------------------------------------
// Items

export type NewItem = Partial<Omit<Item, 'id' | 'createdAt' | 'updatedAt'>> & Pick<Item, 'title' | 'type'>;

export function buildItem(data: NewItem, now = Date.now()): Item {
  return {
    status: 'todo',
    ...data,
    tags: uniqueTags(data.tags ?? []),
    collectionIds: [...new Set(data.collectionIds ?? [])],
    id: uid(),
    createdAt: now,
    updatedAt: now,
  };
}

export async function addItem(data: NewItem): Promise<Item> {
  const item = buildItem(data);
  await db.items.add(item);
  return item;
}

/**
 * Saves a new item made with buildItem without ever waiting forever: a write that hangs (or fails because storage
 * broke) reopens the database and is retried once, without saving it twice, all within 9 s. Rejects when
 * storage still doesn't work. It only ever adds: saving again under the same id after a failure can't make a copy
 * (even if the first write was only held up and lands later), and can't write over the save that's there either.
 * That rejects with a ConstraintError (isAlreadySaved).
 */
export async function saveItem(item: Item): Promise<Item> {
  try {
    await saveWithRetry(item, {
      write: (i) => db.items.add(i),
      get: (id) => db.items.get(id),
      // Each attempt is built afresh, so an earlier one's save has another createdAt.
      isSame: (stored, i) => stored.createdAt === i.createdAt,
      recover: recoverDb,
      // Already known to be stuck: reopen first instead of waiting on it again.
      recoverFirst: STUCK.has(dbHealth.getSnapshot().status),
      onRetry: (e) => dbHealth.noteRetry('saving', e),
    });
  } catch (e) {
    if (isTimeout(e)) dbHealth.reportTimeout('saving');
    else if (isStorageFailure(e)) dbHealth.reportError('saving', e);
    else if (isAlreadySaved(e)) dbHealth.reportOk('already saved');
    throw e;
  }
  dbHealth.reportOk('saved');
  return item;
}

/**
 * Classifies raw shared/pasted content and saves it in one go, keeping the original text.
 * A clear event date in it (or any date, for an event) is saved too.
 */
export async function saveShared(input: SharedInput, extra: Partial<NewItem> = {}): Promise<Item> {
  const c = classify(input);
  const fields = itemFieldsFrom(c);
  const type = extra.type ?? fields.type;
  const m = findWhen(c.sharedText ?? [c.title, c.note].filter(Boolean).join('\n'));
  const when = m && (m.confidence === 'high' || type === 'event') ? m.when : undefined;
  return addItem({ ...fields, ...(when && { when }), ...extra, tags: [...c.tags, ...(extra.tags ?? [])] });
}

/**
 * Saves the user's own changes. A title, kind, date, place or tags they change by hand is remembered (Item.edited),
 * so the automatic analysis leaves it as it is from then on.
 */
export async function updateItem(id: string, changes: Partial<Omit<Item, 'id' | 'createdAt'>>): Promise<void> {
  const patch: Partial<Item> = { ...changes, updatedAt: Date.now() };
  if (changes.tags) patch.tags = uniqueTags(changes.tags);
  if (!EDITED_FIELDS.some((k) => k in changes)) {
    await db.items.update(id, patch);
    return;
  }
  await db.items.update(id, (item) => {
    const fields = item as unknown as Record<string, unknown>;
    const edited = EDITED_FIELDS.filter((k) => k in patch && JSON.stringify(item[k]) !== JSON.stringify(patch[k]));
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete fields[k];
      else fields[k] = v;
    }
    if (edited.length) item.edited = [...new Set([...(item.edited ?? []), ...edited])];
    // A place set or cleared by hand: nothing left to look up.
    if (edited.includes('place')) delete item.locatePending;
  });
}

export async function markDone(id: string, rating?: number, review?: string): Promise<void> {
  await updateItem(id, { status: 'done', doneAt: Date.now(), rating, review: review?.trim() || undefined });
}

export async function markTodo(id: string): Promise<void> {
  await updateItem(id, { status: 'todo', doneAt: undefined, rating: undefined, review: undefined });
}

/** A deleted save's thumbnail is kept this long, so "Undo" brings its picture back too. */
export const THUMB_GRACE_MS = 15000;

export async function deleteItem(id: string): Promise<void> {
  await db.items.delete(id);
  setTimeout(() => void dropThumbs([id]), THUMB_GRACE_MS);
}

type DeletedListener = (ids: string[] | 'all') => void;
const deletedListeners = new Set<DeletedListener>();

/** Called once deleted saves' thumbnails are gone too ('all' after clearAll). Returns an unsubscribe function. */
export function onItemsDeleted(listener: DeletedListener): () => void {
  deletedListeners.add(listener);
  return () => deletedListeners.delete(listener);
}

/** Drops the thumbnails of saves that are still deleted. Never fails: a later tidy-up (thumbs.ts) gets any left. */
async function dropThumbs(ids: string[]): Promise<void> {
  try {
    const gone = (await db.items.bulkGet(ids)).flatMap((item, i) => (item ? [] : [ids[i]]));
    if (!gone.length) return;
    await db.thumbs.bulkDelete(gone);
    deletedListeners.forEach((l) => l(gone));
  } catch {
    /* storage trouble: left for the tidy-up */
  }
}

export async function toggleItemInCollection(itemId: string, collectionId: string): Promise<void> {
  await db.transaction('rw', db.items, async () => {
    const item = await db.items.get(itemId);
    if (!item) return;
    const has = item.collectionIds.includes(collectionId);
    await db.items.update(itemId, {
      collectionIds: has ? item.collectionIds.filter((c) => c !== collectionId) : [...item.collectionIds, collectionId],
      updatedAt: Date.now(),
    });
  });
}

// ---------------------------------------------------------------------------
// Collections

export type NewCollection = Omit<Collection, 'id' | 'createdAt' | 'updatedAt'>;

export async function addCollection(data: NewCollection): Promise<Collection> {
  const now = Date.now();
  const col: Collection = { ...data, id: uid(), createdAt: now, updatedAt: now };
  await db.collections.add(col);
  return col;
}

export async function updateCollection(id: string, changes: Partial<NewCollection>): Promise<void> {
  await db.collections.update(id, { ...changes, updatedAt: Date.now() });
}

/** Deletes a collection. The saves inside it are kept. */
export async function deleteCollection(id: string): Promise<void> {
  await db.transaction('rw', db.items, db.collections, async () => {
    await db.items
      .where('collectionIds')
      .equals(id)
      .modify((item) => {
        item.collectionIds = item.collectionIds.filter((c) => c !== id);
      });
    await db.collections.delete(id);
  });
}

// ---------------------------------------------------------------------------

export function uniqueTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  const counts = new Map<string, number>();
  await db.items.each((item) => {
    for (const t of item.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  });
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function clearAll(): Promise<void> {
  await db.transaction('rw', db.items, db.collections, db.thumbs, async () => {
    await db.items.clear();
    await db.collections.clear();
    await db.thumbs.clear();
  });
  deletedListeners.forEach((l) => l('all'));
}
