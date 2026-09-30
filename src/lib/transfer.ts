import { normalizeUrl, safeUrl } from './classify';
import { buildItem, db, uniqueTags } from './db';
import { uid } from './id';
import { getDeviceId, isWhenEnd, isWhenString, normalizePayload, type SharedCollection, type SharedItemV2, type SharedPayloadV2 } from './share';
import { COLLECTION_COLORS, ITEM_TYPES, TYPE_INFO, type Collection, type Item, type ItemType, type Place, type SharedFrom, type When } from './types';

function safeLink(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.startsWith('geo:')) return normalizeUrl(raw);
  return safeUrl(raw);
}

function safeText(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const s = raw.slice(0, max);
  // Don't leave half an emoji at the end.
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

function safeType(raw: unknown): ItemType {
  return ITEM_TYPES.includes(raw as ItemType) ? (raw as ItemType) : 'link';
}

/** ISO 3166-1 alpha-2, upper case ("pt" → "PT", "UK" → "GB"). */
function safeCountryCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const c = raw.trim().toUpperCase();
  if (c === 'UK') return 'GB';
  return /^[A-Z]{2}$/.test(c) ? c : undefined;
}

/** A finite coordinate. Checked as a number (not re-parsed from text: tiny values print as "1e-7"). */
function coord(raw: unknown, max: number): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= max ? n : undefined;
}

function safePlace(raw: unknown): Place | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const lat = coord(p.lat, 90);
  const lng = coord(p.lng, 180);
  if (lat === undefined || lng === undefined) return undefined;
  const place: Place = { lat, lng };
  const address = safeText(p.address, 300);
  const name = safeText(p.name, 200);
  const city = safeText(p.city, 100);
  const country = safeText(p.country, 100);
  const countryCode = safeCountryCode(p.countryCode);
  if (address) place.address = address;
  if (name) place.name = name;
  if (city) place.city = city;
  if (country) place.country = country;
  if (countryCode) place.countryCode = countryCode;
  return place;
}

/** Dates must be real "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm" strings; an end before the start is dropped. */
function safeWhen(raw: unknown): When | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as Record<string, unknown>;
  if (!isWhenString(w.start)) return undefined;
  const when: When = { start: w.start };
  if (isWhenEnd(w.start, w.end)) when.end = w.end;
  const source = safeText(w.source, 120);
  if (source) when.source = source;
  return when;
}

function safeFrom(raw: unknown, now: number): SharedFrom | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  const from: SharedFrom = { at: num(f.at, now) };
  const name = safeText(typeof f.name === 'string' ? f.name.trim() : undefined, 60);
  const shareId = typeof f.shareId === 'string' && /^[A-Za-z0-9:_.-]{1,200}$/.test(f.shareId) ? f.shareId : undefined;
  if (name) from.name = name;
  if (shareId) from.shareId = shareId;
  return from;
}

function safeColor(raw: unknown): string {
  return typeof raw === 'string' && /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : COLLECTION_COLORS[0];
}

function safeTags(raw: unknown): string[] {
  return Array.isArray(raw) ? uniqueTags(raw.filter((t): t is string => typeof t === 'string')).slice(0, 30) : [];
}

function safeRating(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(5, Math.max(1, Math.round(raw))) : undefined;
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

// ---------------------------------------------------------------------------
// Matching

const TRACKING_PARAMS = /^(?:utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igsh|igshid|si|feature|mibextid|ref_src|ref_url|_branch_match_id|share_source|xmt)$/i;

/** A comparison key for links: ignores http/https, "www.", trailing slashes, fragments and tracking params. */
export function urlKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol === 'geo:') return raw.trim().toLowerCase();
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const host = u.hostname.toLowerCase().replace(/^(?:www\.|m\.|mobile\.)/, '');
  const params = [...u.searchParams]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  // Keep hash routes ("#/…", "#!…"), which some sites use as real paths.
  const hash = /^#!?\//.test(u.hash) ? u.hash : '';
  return `${host}${u.port ? `:${u.port}` : ''}${u.pathname.replace(/\/+$/, '')}${query}${hash}`;
}

const titleKey = (title: string, type: ItemType) => `${type}|${title.trim().toLowerCase().replace(/\s+/g, ' ')}`;

interface Incoming {
  /** Key used by ImportOptions.itemIds: the item's index in payload.items, as a string. */
  key: string;
  index: number;
  data: Pick<Item, 'type' | 'title' | 'tags'> &
    Partial<Pick<Item, 'url' | 'note' | 'description' | 'image' | 'siteName' | 'source' | 'place' | 'when' | 'sharedText'>>;
  url?: string;
  match: string;
  collectionKeys: string[];
}

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/** The sender's own note / rating / review (only in shares where they opted in), as a note for the new item. */
function friendNote(s: SharedItemV2, type: ItemType, sender: string | undefined): string | undefined {
  const parts: string[] = [];
  const note = safeText(s.d, 5000);
  if (note) parts.push(note);
  const rating = safeRating(s.r);
  const review = safeText(s.rv, 5000);
  const done = s.st === 'done';
  if (done || rating || review) {
    const who = sender ?? 'Your friend';
    const head = [done ? TYPE_INFO[type].done : '', rating ? stars(rating) : ''].filter(Boolean).join(' · ');
    const quote = review ? `“${review.trim()}”` : '';
    parts.push(head ? `${who}: ${head}${quote ? `\n${quote}` : ''}` : `${who} says: ${quote}`);
  }
  return parts.length ? parts.join('\n\n').slice(0, 20000) : undefined;
}

function toIncoming(s: SharedItemV2, index: number, sender: string | undefined): Incoming {
  const type = safeType(s.t);
  const title = safeText(typeof s.n === 'string' ? s.n.trim() : undefined, 300) ?? 'Untitled';
  const data: Incoming['data'] = { type, title, tags: safeTags(s.g) };
  const assign = <K extends keyof Incoming['data']>(k: K, v: Incoming['data'][K] | undefined) => {
    if (v !== undefined) data[k] = v;
  };
  assign('url', safeLink(s.u));
  assign('note', friendNote(s, type, sender));
  assign('description', safeText(s.ds, 2000));
  assign('image', safeUrl(s.i));
  assign('siteName', safeText(s.sn, 100));
  assign('source', safeText(s.s, 40));
  assign('place', safePlace(s.p));
  assign('when', safeWhen(s.w));
  assign('sharedText', safeText(s.x, 5000));
  return {
    key: String(index),
    index,
    data,
    url: urlKey(data.url),
    match: titleKey(title, type),
    collectionKeys: Array.isArray(s.c) ? s.c.filter((k): k is string => typeof k === 'string') : [],
  };
}

interface Library {
  byUrl: Map<string, Item>;
  /** Items imported earlier from this same share. */
  shareByUrl: Map<string, Item>;
  shareByTitle: Map<string, Item[]>;
}

function indexLibrary(items: Item[], shareId: string): Library {
  const lib: Library = { byUrl: new Map(), shareByUrl: new Map(), shareByTitle: new Map() };
  for (const item of items) remember(lib, item, shareId);
  return lib;
}

function remember(lib: Library, item: Item, shareId: string) {
  const u = urlKey(item.url);
  if (u && !lib.byUrl.has(u)) lib.byUrl.set(u, item);
  if (item.from?.shareId !== shareId) return;
  if (u && !lib.shareByUrl.has(u)) lib.shareByUrl.set(u, item);
  const t = titleKey(item.title, item.type);
  const same = lib.shareByTitle.get(t);
  if (same) same.push(item);
  else lib.shareByTitle.set(t, [item]);
}

/**
 * update: an earlier import from this share, to refresh · have: the link is already in your library ·
 * new: a new save · dup: same link as incoming[of], which this import adds or updates (one save, linked twice).
 */
type Resolution = { status: 'update'; item: Item } | { status: 'have'; item: Item } | { status: 'new' } | { status: 'dup'; of: number };

/**
 * The earlier import (from this share) that each incoming save updates: same link first, then same title + type —
 * but only when one of the two has no link, since two different links are two different saves whatever
 * they're called ("Instagram", "Film on Letterboxd"…). Each earlier save is matched at most once.
 */
function matchEarlier(lib: Library, incoming: Incoming[]): (Item | undefined)[] {
  const claimed = new Set<string>();
  const claim = (item: Item | undefined) => {
    if (!item || claimed.has(item.id)) return undefined;
    claimed.add(item.id);
    return item;
  };
  const out = incoming.map((inc) => claim(inc.url ? lib.shareByUrl.get(inc.url) : undefined));
  incoming.forEach((inc, i) => {
    // A link you already have is linked, not merged into a same-titled save (that would duplicate the link).
    if (out[i] || (inc.url && lib.byUrl.has(inc.url))) return;
    out[i] = claim(lib.shareByTitle.get(inc.match)?.find((it) => !claimed.has(it.id) && !(inc.url && urlKey(it.url))));
  });
  return out;
}

/**
 * What happens to each save in the share (always resolved over the whole share, so the preview and a partial
 * import agree). A link that appears twice becomes one save.
 */
function resolveAll(lib: Library, incoming: Incoming[]): Resolution[] {
  const earlier = matchEarlier(lib, incoming);
  // Links this import will hold, so a later copy of the same link doesn't add a second save.
  const seen = new Map<string, Resolution>();
  return incoming.map((inc, i) => {
    const prev = earlier[i];
    const have = inc.url ? lib.byUrl.get(inc.url) : undefined;
    const again = inc.url ? seen.get(inc.url) : undefined;
    const r: Resolution = prev ? { status: 'update', item: prev } : have ? { status: 'have', item: have } : (again ?? { status: 'new' });
    if (inc.url && !seen.has(inc.url)) seen.set(inc.url, r.status === 'have' ? r : { status: 'dup', of: i });
    return r;
  });
}

/** Applies the sender's shared fields to an earlier import. Never touches status, rating, review or note; never clears a field. */
function mergeShared(item: Item, inc: Incoming): Item {
  const next: Item = { ...item };
  const d = inc.data;
  next.title = d.title;
  if (d.url) next.url = d.url;
  if (d.image) next.image = d.image;
  if (d.description) next.description = d.description;
  if (d.siteName) next.siteName = d.siteName;
  if (d.source) next.source = d.source;
  if (d.place) next.place = d.place;
  if (d.when) next.when = d.when;
  if (d.sharedText) next.sharedText = d.sharedText;
  next.tags = uniqueTags([...item.tags, ...d.tags]);
  return next;
}

const SHARED_FIELDS = ['title', 'url', 'image', 'description', 'siteName', 'source', 'place', 'when', 'sharedText', 'tags', 'collectionIds'] as const;

function changed(a: Item, b: Item): boolean {
  return SHARED_FIELDS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

// ---------------------------------------------------------------------------
// Friend shares

export interface ImportOptions {
  /** Import only these items — keys are indexes into payload.items, as strings ("0", "1", …). Default: all. */
  itemIds?: string[];
}

export interface ImportResult {
  added: number;
  updated: number;
  /** Already in your library (linked to the shared collection) or unchanged. */
  skipped: number;
  /** The collection that received the share (collection shares; library shares that touched exactly one collection). */
  collectionId?: string;
  /** Every collection created or merged into. */
  collectionIds: string[];
  /** Item shares: the new, updated or already-saved item. */
  itemId?: string;
}

/** Key of the collection that holds a library share's saves that aren't in any of the sender's collections. */
const LOOSE_KEY = '_';

function sharedCollectionName(p: SharedPayloadV2, key: string | undefined, sender: string | undefined): { name: string; emoji: string; color: string } {
  if (key === undefined) return { name: safeText(p.name, 80) ?? 'Shared collection', emoji: safeText(p.emoji, 8) ?? '📌', color: safeColor(p.color) };
  if (key === LOOSE_KEY) return { name: sender ? `${sender}'s saves` : 'Shared saves', emoji: '🎁', color: COLLECTION_COLORS[1] };
  const ref = p.collections?.find((c) => c.key === key);
  return { name: safeText(ref?.name, 80) ?? 'Collection', emoji: safeText(ref?.emoji, 8) ?? '📌', color: safeColor(ref?.color) };
}

async function findSharedCollection(shareId: string): Promise<Collection | undefined> {
  const found = await db.collections.where('from.shareId').equals(shareId).toArray();
  return found.find((c) => c.kind === 'manual');
}

/**
 * Adds a friend's share to the library.
 * - item: one new save (or updates the one imported from this share before).
 * - collection: creates a collection, or merges into the one imported from this share before.
 * - library: one collection per shared collection (+ "<Sender>'s saves" for the rest), merged the same way.
 * Links already in the library are never duplicated — the existing save is linked instead.
 * Your own status, rating, review and notes are never changed, and nothing is ever deleted.
 */
export async function importShare(payload: SharedPayloadV2 | SharedCollection, opts: ImportOptions = {}): Promise<ImportResult> {
  const data = normalizePayload(payload);
  const now = Date.now();
  const sender = safeText(data.from?.trim(), 60);
  const selected = opts.itemIds ? new Set(opts.itemIds) : undefined;
  const all = data.items.map((s, i) => toIncoming(s, i, sender));
  const incoming = all.filter((inc) => !selected || selected.has(inc.key));
  const result: ImportResult = { added: 0, updated: 0, skipped: 0, collectionIds: [] };
  const fromFor = (shareId: string): SharedFrom => (sender ? { name: sender, shareId, at: now } : { shareId, at: now });

  await db.transaction('rw', db.items, db.collections, async () => {
    const lib = indexLibrary(await db.items.toArray(), data.shareId);

    // Which collection(s) each incoming save goes to (collection key → local collection id).
    const targets = new Map<string, string>();
    const createdNow = new Set<string>();
    const ensureCollection = async (key: string | undefined): Promise<string> => {
      const k = key ?? '';
      const known = targets.get(k);
      if (known) return known;
      const shareId = key === undefined ? data.shareId : `${data.shareId}:${key}`;
      const existing = await findSharedCollection(shareId);
      let id: string;
      if (existing) {
        id = existing.id;
        await db.collections.update(id, { from: { ...existing.from, ...fromFor(shareId), at: existing.from?.at ?? now }, updatedAt: now });
      } else {
        id = uid();
        createdNow.add(id);
        await db.collections.add({ id, ...sharedCollectionName(data, key, sender), kind: 'manual', from: fromFor(shareId), createdAt: now, updatedAt: now });
      }
      targets.set(k, id);
      result.collectionIds.push(id);
      return id;
    };

    const collectionsFor = async (inc: Incoming): Promise<string[]> => {
      if (data.kind === 'item') return [];
      if (data.kind === 'collection') return [await ensureCollection(undefined)];
      const known = new Set((data.collections ?? []).map((c) => c.key));
      const keys = inc.collectionKeys.filter((k) => known.has(k));
      const ids: string[] = [];
      for (const k of keys.length ? keys : [LOOSE_KEY]) ids.push(await ensureCollection(k));
      return ids;
    };

    // An explicitly empty selection imports nothing; an empty collection share still creates the collection.
    if (data.kind === 'collection' && !incoming.length && !selected) await ensureCollection(undefined);

    const resolutions = resolveAll(lib, all);
    const added: Item[] = [];
    // The save each processed row (by index in the share) became, for later copies of the same link.
    const saveOf = new Map<number, Item>();
    const changedItems = new Map<string, Item>();
    for (const inc of incoming) {
      const cols = await collectionsFor(inc);
      let r = resolutions[inc.index];
      let row = inc.index;
      if (r.status === 'dup') {
        // Same link twice in one share → one save, in every collection it was listed in.
        const firstRow = r.of;
        const first = saveOf.get(firstRow);
        if (first && added.includes(first)) {
          first.collectionIds = [...new Set([...first.collectionIds, ...cols])];
          result.skipped++;
          continue;
        }
        if (first) {
          // The first copy updated an earlier save: link that one.
          r = { status: 'have', item: first };
        } else {
          // The first copy wasn't picked: this one takes its place.
          r = { status: 'new' };
          row = firstRow;
        }
      }
      if (r.status === 'new') {
        const item = buildItem({ ...inc.data, collectionIds: cols, from: fromFor(data.shareId) }, now - inc.index); // keeps the sender's order
        added.push(item);
        saveOf.set(row, item);
        result.added++;
        if (data.kind === 'item') result.itemId = item.id;
        continue;
      }
      if (r.status === 'update') saveOf.set(row, r.item);
      const current = changedItems.get(r.item.id) ?? r.item;
      let next = r.status === 'update' ? mergeShared(current, inc) : { ...current };
      // Link to the shared collection(s). Saves imported from this share before are only linked into collections
      // made by this import, so one you took out of the shared list doesn't come back. Saves you already had
      // are always linked: the friend may have just added them (the preview lets you untick them).
      const link = cols.filter((c) => !next.collectionIds.includes(c) && (r.status === 'have' || createdNow.has(c)));
      if (link.length) next = { ...next, collectionIds: [...next.collectionIds, ...link] };
      if (data.kind === 'item') result.itemId = r.item.id;
      if (changed(current, next)) {
        changedItems.set(r.item.id, { ...next, updatedAt: now });
        if (r.status === 'update') result.updated++;
        else result.skipped++;
      } else {
        result.skipped++;
      }
    }
    if (added.length) await db.items.bulkAdd(added);
    if (changedItems.size) await db.items.bulkPut([...changedItems.values()]);
  });

  if (data.kind === 'collection' || result.collectionIds.length === 1) result.collectionId = result.collectionIds[0];
  return result;
}

export type ImportRowStatus = 'new' | 'update' | 'have';

export interface ImportPreview {
  /** Per item in payload.items: new save, update of an earlier import, or already in your library. */
  rows: ImportRowStatus[];
  /** Row key → key of an earlier row with the same link. Such rows show as "have": one save, linked twice. */
  sameAs: Record<string, string>;
  counts: Record<ImportRowStatus, number>;
  /** Collection share: the collection imported from this share before (it will be updated). */
  existing?: Collection;
  /** Library share: collections imported from this share before, by collection key. */
  existingByKey: Record<string, Collection>;
  /** Item share: the save it matches. */
  existingItem?: Item;
  /** The share came from this device / library. */
  own: boolean;
}

/** What importShare would do, without changing anything — for the import preview. */
export async function planImport(payload: SharedPayloadV2): Promise<ImportPreview> {
  const data = normalizePayload(payload);
  const sender = safeText(data.from?.trim(), 60);
  const lib = indexLibrary(await db.items.toArray(), data.shareId);
  const counts: Record<ImportRowStatus, number> = { new: 0, update: 0, have: 0 };
  let existingItem: Item | undefined;
  const sameAs: Record<string, string> = {};
  const rows = resolveAll(lib, data.items.map((s, i) => toIncoming(s, i, sender))).map((r, i): ImportRowStatus => {
    if (r.status === 'dup') sameAs[String(i)] = String(r.of);
    const status = r.status === 'dup' ? 'have' : r.status;
    if (r.status === 'update' || r.status === 'have') existingItem ??= r.item;
    counts[status]++;
    return status;
  });
  const preview: ImportPreview = { rows, sameAs, counts, existingByKey: {}, own: await isOwnShare(data.shareId) };
  if (data.kind === 'item') preview.existingItem = existingItem;
  if (data.kind === 'collection') preview.existing = await findSharedCollection(data.shareId);
  if (data.kind === 'library') {
    for (const key of [...(data.collections ?? []).map((c) => c.key), LOOSE_KEY]) {
      const c = await findSharedCollection(`${data.shareId}:${key}`);
      if (c) preview.existingByKey[key] = c;
    }
  }
  return preview;
}

/**
 * What importing just the `selected` rows (keys as ImportOptions.itemIds) would do, per status. A repeated link
 * whose first copy isn't selected counts as new, as importShare adds it.
 */
export function countSelection(preview: ImportPreview | undefined, total: number, selected: ReadonlySet<string>): Record<ImportRowStatus, number> {
  const counts: Record<ImportRowStatus, number> = { new: 0, update: 0, have: 0 };
  const standIn = new Set<string>();
  for (let i = 0; i < total; i++) {
    const key = String(i);
    if (!selected.has(key)) continue;
    let status = preview?.rows[i] ?? 'new';
    const first = preview?.sameAs[key];
    // The first selected copy stands in for an unselected first row; later copies are linked to it.
    if (first !== undefined && !selected.has(first) && !standIn.has(first)) {
      standIn.add(first);
      status = 'new';
    }
    counts[status]++;
  }
  return counts;
}

/** Is this share something you sent yourself (your library, or one of your own collections / saves)? */
export async function isOwnShare(shareId: string): Promise<boolean> {
  const [kind, ...rest] = shareId.split(':');
  const id = rest.join(':');
  if (!id) return false;
  if (kind === 'l') return id === getDeviceId();
  if (kind === 'c') {
    const c = await db.collections.get(id);
    return !!c && !c.from;
  }
  if (kind === 'i') {
    const i = await db.items.get(id);
    return !!i && !i.from;
  }
  return false;
}

/** v1 entry point, kept for older callers: imports a shared collection and returns it. */
export async function importSharedCollection(data: SharedCollection | SharedPayloadV2): Promise<Collection> {
  const payload = normalizePayload(data);
  if (payload.kind !== 'collection') throw new Error('That share isn’t a collection.');
  const res = await importShare(payload);
  const col = res.collectionId ? await db.collections.get(res.collectionId) : undefined;
  if (!col) throw new Error("Couldn't add the collection.");
  return col;
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

/** Merges a backup into the current library. Items/collections with the same id are overwritten. */
export async function importBackup(raw: unknown): Promise<{ items: number; collections: number }> {
  const data = raw as Partial<Backup>;
  if (!data || data.app !== 'magpie' || !Array.isArray(data.items) || !Array.isArray(data.collections)) {
    throw new Error("That file isn't a Magpie backup.");
  }
  const now = Date.now();
  const collections: Collection[] = data.collections
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => {
      const col: Collection = {
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
      };
      const from = safeFrom(c.from, now);
      if (from) col.from = from;
      return col;
    });
  const items: Item[] = data.items
    .filter((i) => i && typeof i.id === 'string')
    .map((i) => {
      const item: Item = {
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
        rating: safeRating(i.rating),
        review: safeText(i.review, 20000),
        doneAt: i.status === 'done' ? num(i.doneAt, now) : undefined,
        place: safePlace(i.place),
        createdAt: num(i.createdAt, now),
        updatedAt: num(i.updatedAt, now),
      };
      const when = safeWhen(i.when);
      const sharedText = safeText(i.sharedText, 5000);
      const from = safeFrom(i.from, now);
      if (when) item.when = when;
      if (sharedText) item.sharedText = sharedText;
      if (from) item.from = from;
      return item;
    });
  await db.transaction('rw', db.items, db.collections, async () => {
    await db.collections.bulkPut(collections);
    await db.items.bulkPut(items);
  });
  return { items: items.length, collections: collections.length };
}
