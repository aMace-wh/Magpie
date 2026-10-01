import { hostOf } from './classify';
import { countryName, normalizeCountryCode } from './location';
import type { Item, ItemType, StatusFilter } from './types';

export interface ItemFilter {
  query: string;
  type: ItemType | 'all';
  status: StatusFilter;
}

/** True when the search box or the kind chips narrow the list (the default status tab doesn't count). */
export function isFiltering(f: ItemFilter): boolean {
  return f.query.trim() !== '' || f.type !== 'all';
}

function countryNames(code?: string): string[] {
  const c = normalizeCountryCode(code);
  // The device's language plus English, so "Japan" works on a German phone too.
  return c ? [countryName(c), countryName(c, 'en')] : [];
}

// Live queries hand out fresh copies on every write, so the search text is cached per save and version (every
// write bumps updatedAt), not per object. Unsaved items (share previews have no timestamps) go by object.
const byVersion = new Map<string, { at: number; text: string }>();
const byObject = new WeakMap<Item, string>();

function haystack(i: Item): string {
  const saved = i.updatedAt > 0;
  const hit = saved ? byVersion.get(i.id) : undefined;
  if (hit?.at === i.updatedAt) return hit.text;
  if (!saved) {
    const h = byObject.get(i);
    if (h !== undefined) return h;
  }
  const p = i.place;
  const text = [
    i.title,
    i.note,
    i.description,
    i.sharedText,
    i.review,
    i.siteName,
    i.source,
    hostOf(i.url),
    p?.name,
    p?.address,
    p?.city,
    p?.country,
    ...countryNames(p?.countryCode),
    i.from?.name,
    ...i.tags.map((t) => `#${t} ${t}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (saved) byVersion.set(i.id, { at: i.updatedAt, text });
  else byObject.set(i, text);
  return text;
}

export function filterItems(items: Item[], f: ItemFilter): Item[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    if (f.type !== 'all' && i.type !== f.type) return false;
    if (f.status !== 'any' && i.status !== f.status) return false;
    if (!words.length) return true;
    const h = haystack(i);
    return words.every((w) => h.includes(w));
  });
}

export function typeCounts(items: Item[]): [ItemType, number][] {
  const m = new Map<ItemType, number>();
  for (const i of items) m.set(i.type, (m.get(i.type) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Cards the library grid renders straight away; the rest follow in idle time. */
export const FIRST_CARDS = 30;

/**
 * How many of `next` the grid should render now, given the ids of the cards it already shows: as many as
 * possible while mounting at most `step` new ones (but always the first `first`). An edited save keeps every
 * card; a new filter or search starts again from the top and fills in from there.
 */
export function cardsToRender(next: readonly Pick<Item, 'id'>[], shown: ReadonlySet<string>, first = FIRST_CARDS, step = first): number {
  let fresh = 0;
  for (let n = 0; n < next.length; n++) {
    if (!shown.has(next[n].id) && ++fresh > step && n >= first) return n;
  }
  return next.length;
}
