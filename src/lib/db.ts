import Dexie, { type EntityTable } from 'dexie';
import { classify, normalizeTag, type SharedInput } from './classify';
import { uid } from './id';
import type { Collection, Item } from './types';

export const db = new Dexie('magpie') as Dexie & {
  items: EntityTable<Item, 'id'>;
  collections: EntityTable<Collection, 'id'>;
};

db.version(1).stores({
  items: 'id, type, status, createdAt, updatedAt, doneAt, *tags, *collectionIds',
  collections: 'id, createdAt, name',
});

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

/** Classifies raw shared/pasted content and saves it in one go. */
export async function saveShared(input: SharedInput, extra: Partial<NewItem> = {}): Promise<Item> {
  const c = classify(input);
  return addItem({ ...c, ...extra, tags: [...c.tags, ...(extra.tags ?? [])] });
}

export async function updateItem(id: string, changes: Partial<Omit<Item, 'id' | 'createdAt'>>): Promise<void> {
  const patch: Partial<Item> = { ...changes, updatedAt: Date.now() };
  if (changes.tags) patch.tags = uniqueTags(changes.tags);
  await db.items.update(id, patch);
}

export async function markDone(id: string, rating?: number, review?: string): Promise<void> {
  await updateItem(id, { status: 'done', doneAt: Date.now(), rating, review: review?.trim() || undefined });
}

export async function markTodo(id: string): Promise<void> {
  await updateItem(id, { status: 'todo', doneAt: undefined, rating: undefined, review: undefined });
}

export async function deleteItem(id: string): Promise<void> {
  await db.items.delete(id);
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
  await db.transaction('rw', db.items, db.collections, async () => {
    await db.items.clear();
    await db.collections.clear();
  });
}
