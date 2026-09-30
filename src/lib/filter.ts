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

// Items from a live query are replaced when they change, so caching per object is safe.
const cache = new WeakMap<Item, string>();

function haystack(i: Item): string {
  let h = cache.get(i);
  if (h !== undefined) return h;
  const p = i.place;
  h = [
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
  cache.set(i, h);
  return h;
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
