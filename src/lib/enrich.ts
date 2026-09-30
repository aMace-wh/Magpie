import { classify, parsePlaceFromUrl } from './classify';
import { db, uniqueTags } from './db';
import { fetchPreview } from './metadata';
import { getSettings } from './settings';
import type { Item } from './types';

export interface EnrichOptions {
  /** The title was generated, not typed — a real one from the page may replace it. */
  replaceTitle: boolean;
  /** The type was guessed, not picked — a better guess may replace it. */
  reclassify: boolean;
  /** Replace the image / description / site name even if already set. */
  overwrite?: boolean;
}

/** Fetches a link preview for a saved item and fills in whatever the user hasn't set. */
export async function enrichItem(id: string, opts: EnrichOptions): Promise<void> {
  if (!getSettings().previews) return;
  const before = await db.items.get(id);
  if (!before?.url || !/^https?:/i.test(before.url)) return;

  const preview = await fetchPreview(before.url);
  const item = await db.items.get(id);
  if (!item) return;

  const changes: Partial<Item> = {};
  const fill = opts.overwrite ? () => true : (current: unknown) => !current;
  if (preview.image && fill(item.image)) changes.image = preview.image;
  if (preview.description && fill(item.description)) changes.description = preview.description;
  if (preview.siteName && fill(item.siteName)) changes.siteName = preview.siteName;
  // Only replace the title if the user hasn't edited it in the meantime.
  if (preview.title && opts.replaceTitle && item.title === before.title) changes.title = preview.title;
  if (!item.place && preview.finalUrl) {
    const { place } = parsePlaceFromUrl(preview.finalUrl);
    if (place) changes.place = place;
  }

  if (opts.reclassify && item.type === before.type && (preview.title || preview.description)) {
    const better = classify({
      title: preview.title ?? item.title,
      text: [preview.description, item.note].filter(Boolean).join('\n'),
      url: preview.finalUrl ?? item.url,
    });
    if (better.type !== item.type && (item.type === 'link' || item.type === 'video' || item.type === 'note')) {
      changes.type = better.type;
    }
    const tags = uniqueTags([...item.tags, ...better.tags]).slice(0, Math.max(item.tags.length, 6));
    if (tags.length !== item.tags.length) changes.tags = tags;
    if (!item.place && better.place) changes.place = better.place;
  }

  if (Object.keys(changes).length) await db.items.update(id, { ...changes, updatedAt: Date.now() });
}
