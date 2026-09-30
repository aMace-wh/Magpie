import { hostOf } from './classify';
import type { Item, ItemType, StatusFilter } from './types';

export interface ItemFilter {
  query: string;
  type: ItemType | 'all';
  status: StatusFilter;
}

function haystack(i: Item): string {
  return [i.title, i.note, i.description, i.review, i.siteName, i.source, hostOf(i.url), i.place?.address, ...i.tags.map((t) => `#${t} ${t}`)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
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
