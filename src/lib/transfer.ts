import { normalizeUrl, parseLatLng, safeUrl } from './classify';
import { buildItem, db, uniqueTags } from './db';
import { uid } from './id';
import type { SharedCollection } from './share';
import { COLLECTION_COLORS, ITEM_TYPES, type Collection, type Item, type ItemType, type Place } from './types';

function safeLink(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.startsWith('geo:')) return normalizeUrl(raw);
  return safeUrl(raw);
}

function safeText(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.slice(0, max) : undefined;
}

function safeType(raw: unknown): ItemType {
  return ITEM_TYPES.includes(raw as ItemType) ? (raw as ItemType) : 'link';
}

function safePlace(raw: unknown): Place | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const ll = parseLatLng(`${p.lat},${p.lng}`);
  return ll ? { ...ll, address: safeText(p.address, 300) } : undefined;
}

function safeColor(raw: unknown): string {
  return typeof raw === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : COLLECTION_COLORS[0];
}

function safeTags(raw: unknown): string[] {
  return Array.isArray(raw) ? uniqueTags(raw.filter((t): t is string => typeof t === 'string')).slice(0, 30) : [];
}

// ---------------------------------------------------------------------------
// Shared collections (links from friends)

export async function importSharedCollection(data: SharedCollection): Promise<Collection> {
  const now = Date.now();
  const collection: Collection = {
    id: uid(),
    name: safeText(data.name, 80) ?? 'Shared collection',
    emoji: safeText(data.emoji, 8) ?? '📌',
    color: safeColor(data.color),
    kind: 'manual',
    createdAt: now,
    updatedAt: now,
  };
  const items = data.items.slice(0, 1000).map((s, i) =>
    buildItem(
      {
        type: safeType(s.t),
        title: safeText(s.n, 300) ?? 'Untitled',
        url: safeLink(s.u),
        note: safeText(s.d, 5000),
        image: safeUrl(s.i),
        tags: safeTags(s.g),
        place: safePlace(s.p),
        source: safeText(s.s, 40),
        collectionIds: [collection.id],
      },
      now - i, // keep the sender's order
    ),
  );
  await db.transaction('rw', db.items, db.collections, async () => {
    await db.collections.add(collection);
    await db.items.bulkAdd(items);
  });
  return collection;
}

// ---------------------------------------------------------------------------
// Full backups

export interface Backup {
  app: 'magpie';
  version: 1;
  exportedAt: string;
  items: Item[];
  collections: Collection[];
}

export async function exportBackup(): Promise<Backup> {
  const [items, collections] = await Promise.all([db.items.toArray(), db.collections.toArray()]);
  return { app: 'magpie', version: 1, exportedAt: new Date().toISOString(), items, collections };
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

/** Merges a backup into the current library. Items/collections with the same id are overwritten. */
export async function importBackup(raw: unknown): Promise<{ items: number; collections: number }> {
  const data = raw as Partial<Backup>;
  if (!data || data.app !== 'magpie' || !Array.isArray(data.items) || !Array.isArray(data.collections)) {
    throw new Error("That file isn't a Magpie backup.");
  }
  const now = Date.now();
  const collections: Collection[] = data.collections
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({
      id: c.id,
      name: safeText(c.name, 80) ?? 'Collection',
      emoji: safeText(c.emoji, 8) ?? '📌',
      color: safeColor(c.color),
      kind: c.kind === 'smart' ? 'smart' : 'manual',
      rules:
        c.kind === 'smart' && c.rules
          ? {
              tags: safeTags(c.rules.tags),
              match: c.rules.match === 'all' ? 'all' : 'any',
              types: Array.isArray(c.rules.types) ? c.rules.types.filter((t) => ITEM_TYPES.includes(t)) : [],
              status: c.rules.status === 'todo' || c.rules.status === 'done' ? c.rules.status : 'any',
            }
          : undefined,
      createdAt: num(c.createdAt, now),
      updatedAt: num(c.updatedAt, now),
    }));
  const items: Item[] = data.items
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => ({
      id: i.id,
      type: safeType(i.type),
      title: safeText(i.title, 300) ?? 'Untitled',
      url: safeLink(i.url),
      note: safeText(i.note, 20000),
      description: safeText(i.description, 2000),
      image: safeUrl(i.image),
      siteName: safeText(i.siteName, 100),
      source: safeText(i.source, 40),
      tags: safeTags(i.tags),
      collectionIds: Array.isArray(i.collectionIds) ? i.collectionIds.filter((c): c is string => typeof c === 'string') : [],
      status: i.status === 'done' ? 'done' : 'todo',
      rating: typeof i.rating === 'number' ? Math.min(5, Math.max(1, Math.round(i.rating))) : undefined,
      review: safeText(i.review, 20000),
      doneAt: i.status === 'done' ? num(i.doneAt, now) : undefined,
      place: safePlace(i.place),
      createdAt: num(i.createdAt, now),
      updatedAt: num(i.updatedAt, now),
    }));
  await db.transaction('rw', db.items, db.collections, async () => {
    await db.collections.bulkPut(collections);
    await db.items.bulkPut(items);
  });
  return { items: items.length, collections: collections.length };
}
