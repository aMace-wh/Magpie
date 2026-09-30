import { useState } from 'react';
import { hostOf, sourceLabel } from '../lib/classify';
import { TYPE_INFO, type Item } from '../lib/types';

const TINTS: Record<string, string> = {
  recipe: 'linear-gradient(135deg,#f97316,#e11d48)',
  place: 'linear-gradient(135deg,#0ea5a4,#16a34a)',
  video: 'linear-gradient(135deg,#e11d48,#a855f7)',
  workout: 'linear-gradient(135deg,#0284c7,#0ea5a4)',
  product: 'linear-gradient(135deg,#ca8a04,#f97316)',
  article: 'linear-gradient(135deg,#475569,#0284c7)',
  book: 'linear-gradient(135deg,#a855f7,#6d5dfc)',
  music: 'linear-gradient(135deg,#16a34a,#0ea5a4)',
};

export function tintFor(item: Pick<Item, 'type'>): string | undefined {
  return TINTS[item.type];
}

/** An item's image, or a tinted emoji tile when there isn't one (or it fails to load). */
export function Thumb({ item, label = true }: { item: Item; label?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (item.image && !failed) {
    return <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  const caption = label ? sourceLabel(item.source) ?? item.siteName ?? hostOf(item.url) : undefined;
  return (
    <div className="thumb-fallback" style={{ ['--tint' as string]: tintFor(item) }}>
      <span>{TYPE_INFO[item.type].emoji}</span>
      {caption && <small>{caption}</small>}
    </div>
  );
}

/** Small square version used in lists. */
export function ThumbSmall({ item }: { item: Item }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="thumb-sm">
      {item.image && !failed ? (
        <img src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden>{TYPE_INFO[item.type].emoji}</span>
      )}
    </div>
  );
}
