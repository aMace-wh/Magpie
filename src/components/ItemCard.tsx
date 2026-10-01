import { Check, MapPin } from 'lucide-react';
import { memo, startTransition, useEffect, useMemo, useState } from 'react';
import { hostOf, sourceLabel } from '../lib/classify';
import { cardsToRender } from '../lib/filter';
import { countryName, flagEmoji, isAreaPlace, placeCity, placeCountryCode } from '../lib/location';
import { navigate } from '../lib/router';
import { TYPE_INFO, type Item, type Place } from '../lib/types';
import { whenIdle } from '../lib/warmup';
import { Ago } from './Ago';
import { OriginalSnippet } from './OriginalPreview';
import { SourceIcon } from './SourceIcon';
import { Stars } from './Stars';
import { Thumb } from './Thumb';
import { WhenBadge } from './WhenBadge';

/** "🇵🇹" + "Lisbon" for a card: the city, a region's own name, or the country. Undefined when none is known. */
function placeShort(place?: Place): { flag: string; label: string } | undefined {
  if (!place) return undefined;
  const code = placeCountryCode(place);
  const area = !place.city && isAreaPlace(place) ? place.name?.trim() : undefined;
  const label = placeCity(place) || area || place.country?.trim() || (code ? countryName(code) : '');
  return label ? { flag: flagEmoji(code, '📍'), label } : undefined;
}

interface CardProps {
  item: Item;
}

/**
 * Same save, same version: nothing on the card has changed (every write bumps updatedAt), so a library write
 * doesn't redraw every card. Unsaved items have no version and go by object. What depends on the time (the date
 * pill, "2 minutes ago") follows the clock by itself.
 */
const sameCard = (a: CardProps, b: CardProps) =>
  a.item === b.item || (a.item.updatedAt > 0 && a.item.id === b.item.id && a.item.updatedAt === b.item.updatedAt);

export const ItemCard = memo(function ItemCard({ item }: CardProps) {
  const info = TYPE_INFO[item.type];
  const from = sourceLabel(item.source) ?? item.siteName ?? hostOf(item.url);
  const spot = useMemo(() => placeShort(item.place), [item.place]);
  const friend = item.from ? item.from.name?.trim() || 'a friend' : undefined;
  return (
    <button className="card" onClick={() => navigate(`/item/${item.id}`)}>
      <div className="thumb">
        <Thumb item={item} />
        {(item.status === 'done' || friend) && (
          <span className="card-badges">
            {item.status === 'done' && (
              // Next to a "from" pill there's only room for the tick.
              <span className={`card-badge done${friend ? ' compact' : ''}`} title={info.done}>
                <Check size={12} strokeWidth={3} aria-hidden />
                {friend ? <span className="sr-only">{info.done}</span> : info.done}
              </span>
            )}
            {friend && (
              <span className="card-badge from" title={`Shared by ${friend}`}>
                <span>from {friend}</span>
              </span>
            )}
          </span>
        )}
      </div>
      <div className="card-body">
        <h3 className="card-title">{item.title}</h3>
        {item.when && <WhenBadge when={item.when} />}
        <OriginalSnippet item={item} lines={2} />
        <div className="card-meta">
          {spot ? (
            <>
              <span className="card-flag" aria-hidden>
                {spot.flag}
              </span>
              <span>{spot.label}</span>
            </>
          ) : (
            <>
              {item.source ? <SourceIcon source={item.source} size={14} /> : <span aria-hidden>{info.emoji}</span>}
              {item.place && item.type !== 'place' && <MapPin size={12} aria-hidden />}
              <span>{from || info.label}</span>
            </>
          )}
          {/* Gives way first on a narrow card, so the city stays readable. */}
          <span className="card-ago">
            <span aria-hidden>·</span> <Ago at={item.createdAt} />
          </span>
        </div>
        {item.status === 'done' && item.rating ? <Stars value={item.rating} size={12} /> : null}
      </div>
    </button>
  );
}, sameCard);

// Cards added per idle moment after the first ones.
const CARD_CHUNK = 20;
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * How many of `items` to render: the first cards straight away, the rest a chunk per idle moment. A changed
 * save keeps the cards already shown; a new filter or search starts from the top again.
 */
function useRenderedCount(items: Item[]): number {
  const [state, setState] = useState(() => ({ items, count: cardsToRender(items, NO_IDS) }));
  let { count } = state;
  if (state.items !== items) {
    count = cardsToRender(items, new Set(state.items.slice(0, state.count).map((i) => i.id)));
    setState({ items, count });
  }

  useEffect(() => {
    if (count >= items.length) return;
    // A transition, so a tap or a keystroke can interrupt it.
    return whenIdle(
      () => startTransition(() => setState((s) => (s.items === items ? { items, count: Math.min(items.length, s.count + CARD_CHUNK) } : s))),
      { timeout: 1000 },
    );
  }, [items, count]);

  return count;
}

export function ItemGrid({ items }: { items: Item[] }) {
  const count = useRenderedCount(items);
  return (
    <div className="grid">
      {(count < items.length ? items.slice(0, count) : items).map((item) => (
        <ItemCard key={item.id} item={item} />
      ))}
    </div>
  );
}
