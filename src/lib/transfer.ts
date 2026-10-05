import { isTrackingParam, normalizeUrl, safeUrl, SOURCE_ID_RE } from './classify';
import { buildItem, db, uniqueTags } from './db';
import { uid } from './id';
import { mergePlaceDetails } from './location';
import { getDeviceId, isWhenEnd, isWhenString, normalizePayload, shortHash, type SharedCollection, type SharedItemV2, type SharedPayloadV2 } from './share';
import { COLLECTION_COLORS, EDITED_FIELDS, ITEM_TYPES, TYPE_INFO, type Collection, type Item, type ItemType, type Place, type SharedFrom, type When } from './types';

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

/** A platform id like "youtube"; anything else (e.g. "__proto__") is dropped. */
function safeSource(raw: unknown): string | undefined {
  return typeof raw === 'string' && SOURCE_ID_RE.test(raw) ? raw : undefined;
}

const KEY_RE = /^[a-z0-9]{1,13}$/;

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
  if (typeof f.key === 'string' && KEY_RE.test(f.key)) from.key = f.key;
  const shared = f.shared as { sig?: unknown; tags?: unknown } | undefined;
  if (shared && typeof shared === 'object' && shared.sig && typeof shared.sig === 'object') {
    const sig: Record<string, string> = {};
    for (const k of MERGED) {
      const v = (shared.sig as Record<string, unknown>)[k];
      if (typeof v === 'string' && KEY_RE.test(v)) sig[k] = v;
    }
    from.shared = { sig, tags: safeTags(shared.tags) };
  }
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
    .filter(([k]) => !isTrackingParam(u, k))
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
  /** The sender's key for a save without a link (SharedItemV2.k). */
  saveKey?: string;
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
  assign('source', safeSource(s.s));
  assign('place', safePlace(s.p));
  assign('when', safeWhen(s.w));
  assign('sharedText', safeText(s.x, 5000));
  const url = urlKey(data.url);
  return {
    key: String(index),
    index,
    data,
    url,
    match: titleKey(title, type),
    saveKey: !url && typeof s.k === 'string' && KEY_RE.test(s.k) ? s.k : undefined,
    collectionKeys: Array.isArray(s.c) ? s.c.filter((k): k is string => typeof k === 'string') : [],
  };
}

interface Library {
  byUrl: Map<string, Item>;
  /** Saves imported from a friend, by the sender's key for a save without a link. */
  byKey: Map<string, Item[]>;
  /** Items imported earlier from this same share. */
  shareByUrl: Map<string, Item>;
  shareByTitle: Map<string, Item[]>;
}

function indexLibrary(items: Item[], shareId: string): Library {
  const lib: Library = { byUrl: new Map(), byKey: new Map(), shareByUrl: new Map(), shareByTitle: new Map() };
  for (const item of items) remember(lib, item, shareId);
  return lib;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The item's link keys: its link, and the short link it was saved as when that was replaced by where it leads. */
function linkKeys(item: Item): string[] {
  const keys = [urlKey(item.url)];
  // A bare link as the original post is the one that was pasted ("vm.tiktok.com/…" before it was resolved).
  const pasted = item.sharedText?.trim();
  if (pasted && /^https?:\/\/\S+$/i.test(pasted)) keys.push(urlKey(pasted));
  return [...new Set(keys.filter((k): k is string => !!k))];
}

function remember(lib: Library, item: Item, shareId: string) {
  const keys = linkKeys(item);
  for (const u of keys) if (!lib.byUrl.has(u)) lib.byUrl.set(u, item);
  if (item.from?.key) push(lib.byKey, item.from.key, item);
  if (item.from?.shareId !== shareId) return;
  for (const u of keys) if (!lib.shareByUrl.has(u)) lib.shareByUrl.set(u, item);
  push(lib.shareByTitle, titleKey(item.title, item.type), item);
}

/**
 * update: an earlier import from this share, to refresh · have: already in your library ·
 * new: a new save · dup: same link as incoming[of], which this import adds or updates (one save, linked twice).
 */
type Resolution = { status: 'update'; item: Item } | { status: 'have'; item: Item } | { status: 'new' } | { status: 'dup'; of: number };

/**
 * The earlier import (from this share) that each incoming save updates: same link first, then the sender's key for
 * a save without a link, then same title + type — but only when one of the two has no link, since two different
 * links are two different saves whatever they're called ("Instagram", "Film on Letterboxd"…). Each earlier save is
 * matched at most once.
 */
function matchEarlier(lib: Library, incoming: Incoming[], shareId: string): (Item | undefined)[] {
  const claimed = new Set<string>();
  const claim = (item: Item | undefined) => {
    if (!item || claimed.has(item.id)) return undefined;
    claimed.add(item.id);
    return item;
  };
  const out = incoming.map((inc) => claim(inc.url ? lib.shareByUrl.get(inc.url) : undefined));
  incoming.forEach((inc, i) => {
    if (out[i] || !inc.saveKey) return;
    out[i] = claim(lib.byKey.get(inc.saveKey)?.find((it) => it.from?.shareId === shareId && !claimed.has(it.id)));
  });
  incoming.forEach((inc, i) => {
    // A link you already have is linked, not merged into a same-titled save (that would duplicate the link).
    if (out[i] || (inc.url && lib.byUrl.has(inc.url))) return;
    out[i] = claim(lib.shareByTitle.get(inc.match)?.find((it) => !claimed.has(it.id) && !(inc.url && urlKey(it.url))));
  });
  return out;
}

/**
 * What happens to each save in the share (always resolved over the whole share, so the preview and a partial
 * import agree). A link that appears twice becomes one save. A save without a link that the same friend sent
 * before in another share (their collection, then their library…) is recognised by its key.
 */
function resolveAll(lib: Library, incoming: Incoming[], shareId: string, sender: string | undefined): Resolution[] {
  const earlier = matchEarlier(lib, incoming, shareId);
  // Links this import will hold, so a later copy of the same link doesn't add a second save.
  const seen = new Map<string, Resolution>();
  const sameSender = (it: Item) => (it.from?.name ?? '') === (sender ?? '');
  return incoming.map((inc, i) => {
    const prev = earlier[i];
    const have = inc.url ? lib.byUrl.get(inc.url) : inc.saveKey ? lib.byKey.get(inc.saveKey)?.find(sameSender) : undefined;
    const again = inc.url ? seen.get(inc.url) : undefined;
    const r: Resolution = prev ? { status: 'update', item: prev } : have ? { status: 'have', item: have } : (again ?? { status: 'new' });
    if (inc.url && !seen.has(inc.url)) seen.set(inc.url, r.status === 'have' ? r : { status: 'dup', of: i });
    return r;
  });
}

/** Shared fields a later import can refresh. */
const MERGED = ['title', 'url', 'image', 'description', 'siteName', 'source', 'place', 'when', 'sharedText'] as const;

const fingerprint = (v: unknown) => shortHash(JSON.stringify(v ?? null));

/** What the share says now, to compare with next time (SharedFrom.shared). */
function sharedState(inc: Incoming): NonNullable<SharedFrom['shared']> {
  const sig: Record<string, string> = {};
  for (const k of MERGED) sig[k] = fingerprint(inc.data[k]);
  return { sig, tags: inc.data.tags };
}

/**
 * Applies what the sender changed since the last import to an earlier import. A field they didn't change keeps
 * your version (you may have renamed it, moved the date or added place details); tags they added are added, tags
 * you removed stay removed. Never touches status, rating, review or note; never clears a field.
 */
function mergeShared(item: Item, inc: Incoming): Item {
  const next: Item = { ...item };
  const d = inc.data;
  const last = item.from?.shared;
  const now = sharedState(inc);
  for (const k of MERGED) {
    const v = d[k];
    if (v === undefined || (last && last.sig[k] === now.sig[k])) continue;
    if (k === 'place') {
      const p = v as Place;
      // Same spot: keep the details you have (e.g. city and country filled in later), add any you're missing.
      next.place = item.place && item.place.lat === p.lat && item.place.lng === p.lng ? mergePlaceDetails(item.place, p) : p;
    } else {
      (next as unknown as Record<string, unknown>)[k] = v;
    }
  }
  const added = last ? d.tags.filter((t) => !last.tags.includes(t)) : d.tags;
  next.tags = uniqueTags([...item.tags, ...added]);
  next.from = { ...(item.from ?? { at: Date.now() }), shared: now };
  if (inc.saveKey && !next.from.key) next.from.key = inc.saveKey;
  return next;
}

const SHARED_FIELDS = [...MERGED, 'tags', 'collectionIds'] as const;

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

/** shareId prefix of a library share's collection: the fingerprint of the sender's collection id (SharedCollectionRef.id). */
const PRINT = 'cf:';

/** The shareId a collection in the share is filed under (`key`: a library collection's key; undefined: the collection share itself). */
function collectionShareId(data: SharedPayloadV2, key: string | undefined): string {
  if (key === undefined) return data.shareId;
  const print = key === LOOSE_KEY ? undefined : data.collections?.find((c) => c.key === key)?.id;
  // Filed by the sender's own collection, so it's the same one whether it came in their library or on its own.
  return print ? `${PRINT}${print}` : `${data.shareId}:${key}`;
}

/**
 * The collection imported from `shareId` before. A collection shared on its own ("c:<id>") and the same collection
 * in the sender's library ("cf:<fingerprint of id>") are one collection, whichever came first.
 */
async function findSharedCollection(shareId: string): Promise<Collection | undefined> {
  const ids = shareId.startsWith('c:') ? [shareId, `${PRINT}${shortHash(shareId.slice(2))}`] : [shareId];
  const found = (await db.collections.where('from.shareId').anyOf(ids).toArray()).filter((c) => c.kind === 'manual');
  const match = found.find((c) => c.from?.shareId === shareId) ?? found[0];
  if (match || !shareId.startsWith(PRINT)) return match;
  const print = shareId.slice(PRINT.length);
  const singles = await db.collections.where('from.shareId').startsWith('c:').toArray();
  return singles.find((c) => c.kind === 'manual' && shortHash(c.from!.shareId!.slice(2)) === print);
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
      const shareId = collectionShareId(data, key);
      const existing = await findSharedCollection(shareId);
      let id: string;
      if (existing) {
        id = existing.id;
        // Keep the full id of a collection shared on its own over the library's fingerprint of it.
        const filed = existing.from?.shareId?.startsWith('c:') && shareId.startsWith(PRINT) ? existing.from.shareId : shareId;
        await db.collections.update(id, { from: { ...existing.from, ...fromFor(filed), at: existing.from?.at ?? now }, updatedAt: now });
      } else {
        id = uid();
        createdNow.add(id);
        await db.collections.add({ id, ...sharedCollectionName(data, key, sender), kind: 'manual', from: fromFor(shareId), createdAt: now, updatedAt: now });
      }
      targets.set(k, id);
      result.collectionIds.push(id);
      return id;
    };

    const knownKeys = new Set((data.collections ?? []).map((c) => c.key));
    const keysOf = (inc: Incoming): (string | undefined)[] => {
      if (data.kind === 'item') return [];
      if (data.kind === 'collection') return [undefined];
      const keys = inc.collectionKeys.filter((k) => knownKeys.has(k));
      return keys.length ? keys : [LOOSE_KEY];
    };

    // Find or create every target collection up front, so the per-save loop below never awaits:
    // an await per save inside a Dexie transaction makes big imports commit early.
    const needed = new Set<string | undefined>();
    for (const inc of incoming) for (const k of keysOf(inc)) needed.add(k);
    // An explicitly empty selection imports nothing; an empty collection share still creates the collection.
    if (data.kind === 'collection' && !incoming.length && !selected) needed.add(undefined);
    for (const k of needed) await ensureCollection(k);
    const collectionsFor = (inc: Incoming): string[] => keysOf(inc).map((k) => targets.get(k ?? '')!);

    const resolutions = resolveAll(lib, all, data.shareId, sender);
    const added: Item[] = [];
    // The save each processed row (by index in the share) became, for later copies of the same link.
    const saveOf = new Map<number, Item>();
    const changedItems = new Map<string, Item>();
    for (const inc of incoming) {
      const cols = collectionsFor(inc);
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
        const from: SharedFrom = { ...fromFor(data.shareId), shared: sharedState(inc) };
        if (inc.saveKey) from.key = inc.saveKey;
        const item = buildItem({ ...inc.data, collectionIds: cols, from }, now - inc.index); // keeps the sender's order
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
      const edited = changed(current, next);
      // Also kept when only the record of what was shared changed, so the next import compares with it.
      if (edited || JSON.stringify(current.from) !== JSON.stringify(next.from)) {
        changedItems.set(r.item.id, { ...next, updatedAt: edited ? now : current.updatedAt });
      }
      if (edited && r.status === 'update') result.updated++;
      else result.skipped++;
    }
    if (added.length) await db.items.bulkAdd(added);
    if (changedItems.size) await db.items.bulkPut([...changedItems.values()]);
  });

  if (data.kind === 'collection' || result.collectionIds.length === 1) result.collectionId = result.collectionIds[0];
  return result;
}

export type ImportRowStatus = 'new' | 'update' | 'have';

export interface ImportPreview {
  /** Per item in payload.items: new save, update (an earlier import your friend has changed since), or already in your library. */
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
  const preview: ImportPreview = { rows: [], sameAs: {}, counts: { new: 0, update: 0, have: 0 }, existingByKey: {}, own: await isOwnShare(data.shareId) };
  if (data.kind === 'collection') preview.existing = await findSharedCollection(data.shareId);
  if (data.kind === 'library') {
    for (const key of [...(data.collections ?? []).map((c) => c.key), LOOSE_KEY]) {
      const c = await findSharedCollection(collectionShareId(data, key));
      if (c) preview.existingByKey[key] = c;
    }
  }
  // Would the save go into a collection this import has to make (a new one, or one you deleted)?
  const known = new Set((data.collections ?? []).map((c) => c.key));
  const makesCollection = (inc: Incoming) => {
    if (data.kind === 'collection') return !preview.existing;
    if (data.kind !== 'library') return false;
    const keys = inc.collectionKeys.filter((k) => known.has(k));
    return (keys.length ? keys : [LOOSE_KEY]).some((k) => !preview.existingByKey[k]);
  };
  const incoming = data.items.map((s, i) => toIncoming(s, i, sender));
  let existingItem: Item | undefined;
  preview.rows = resolveAll(lib, incoming, data.shareId, sender).map((r, i): ImportRowStatus => {
    if (r.status === 'dup') preview.sameAs[String(i)] = String(r.of);
    let status: ImportRowStatus = r.status === 'dup' ? 'have' : r.status;
    if (r.status === 'update' || r.status === 'have') existingItem ??= r.item;
    // Nothing changed on your friend's side since you added it: it's simply saved.
    if (r.status === 'update' && !changed(r.item, mergeShared(r.item, incoming[i])) && !makesCollection(incoming[i])) status = 'have';
    preview.counts[status]++;
    return status;
  });
  if (data.kind === 'item') preview.existingItem = existingItem;
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
        source: safeSource(i.source),
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
      const author = safeText(i.author, 100);
      const from = safeFrom(i.from, now);
      if (when) item.when = when;
      if (sharedText) item.sharedText = sharedText;
      if (author) item.author = author;
      if (from) item.from = from;
      // What the analysis already did, and what the user set by hand, so a restore doesn't redo (or undo) it.
      if (Number.isInteger(i.analyzed) && i.analyzed! > 0 && i.analyzed! < 1000) item.analyzed = i.analyzed;
      const edited = Array.isArray(i.edited) ? EDITED_FIELDS.filter((f) => i.edited!.includes(f)) : [];
      if (edited.length) item.edited = edited;
      if (i.locatePending === true && !item.place) item.locatePending = true;
      return item;
    });
  await db.transaction('rw', db.items, db.collections, async () => {
    await db.collections.bulkPut(collections);
    await db.items.bulkPut(items);
  });
  return { items: items.length, collections: collections.length };
}
