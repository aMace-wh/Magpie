import { CalendarDays } from 'lucide-react';
import { useClock } from '../lib/clock';
import type { When } from '../lib/types';
import { whenBadge } from '../lib/when';
import './When.css';

interface Props {
  when: When;
  now?: Date;
  variant?: 'card' | 'inline';
}

/**
 * Compact date pill for cards and lists: green while it's on, highlighted when it's within a week, faint once over.
 * Keeps up with the time ("Tomorrow" becomes "Today") even on a card that isn't otherwise redrawn.
 */
export function WhenBadge({ when, now, variant = 'card' }: Props) {
  // As one string, so a clock tick only redraws the pill when what it shows changes.
  const view = useClock((t) => {
    const v = whenBadge(when, now ?? new Date(t));
    return v ? [v.tone, v.text, v.title, v.spoken].join('\n') : '';
  });
  if (!view) return null;
  const [tone, text, title, spoken] = view.split('\n');

  return (
    // "when-badge--card", not "card": that's the save card's own class.
    <span className={`when-badge when-badge--${variant} is-${tone}`} title={title}>
      <CalendarDays size={variant === 'card' ? 12 : 14} aria-hidden />
      <span className="when-badge-text">{text}</span>
      {spoken && <span className="sr-only">, {spoken}</span>}
    </span>
  );
}
