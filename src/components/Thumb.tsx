import { useEffect, useState, type SyntheticEvent } from 'react';
import { hostOf, sourceLabel } from '../lib/classify';
import { thumbExpiresAt, thumbFailed, thumbShown, useThumb } from '../lib/thumbs';
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
  event: 'linear-gradient(135deg,#a855f7,#e11d48)',
};

export function tintFor(item: Pick<Item, 'type'>): string | undefined {
  return TINTS[item.type];
}

/** A copy shown at more than this many screen pixels per pixel of it looks soft. */
const SOFT = 2;

function looksSoft(img: HTMLImageElement): boolean {
  const scale = Math.max(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight) * (window.devicePixelRatio || 1);
  return img.naturalWidth > 0 && scale > SOFT;
}

/**
 * A save's picture. Tells thumbs.ts how it went, so a failed link falls back to the copy on this device. Given the
 * `link`, a copy that would look soft (the big picture on a save's page) is swapped for the link once that loads.
 */
export function ThumbImage({ id, src, link }: { id: string; src: string; link?: string }) {
  const [want, setWant] = useState<string>();
  const [sharp, setSharp] = useState<string>();
  useEffect(() => {
    if (!want) return;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => setSharp(want);
    img.src = want;
    return () => {
      img.onload = null;
    };
  }, [want]);
  const shown = sharp && sharp === link && src !== link ? sharp : src;
  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    thumbShown(id, shown);
    const expired = (thumbExpiresAt(link) ?? Infinity) <= Date.now();
    if (shown === src && link && src !== link && want !== link && !expired && looksSoft(e.currentTarget)) setWant(link);
  };
  return (
    <img
      src={shown}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      onError={() => (shown === src ? thumbFailed(id, src) : setSharp(undefined))}
    />
  );
}

/** An item's image, or a tinted emoji tile when there isn't one (or it fails to load). */
export function Thumb({ item, label = true }: { item: Item; label?: boolean }) {
  const { src, link, waiting } = useThumb(item);
  if (src) return <ThumbImage id={item.id} src={src} link={link} />;
  // A moment while the copy on this device is looked up: the empty tile, as while an image loads.
  if (waiting) return null;
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
  const { src, waiting } = useThumb(item);
  return (
    <div className="thumb-sm">
      {src ? <ThumbImage id={item.id} src={src} /> : !waiting && <span aria-hidden>{TYPE_INFO[item.type].emoji}</span>}
    </div>
  );
}
