import { CalendarDays } from 'lucide-react';
import type { When } from '../lib/types';
import { daysUntil, formatWhen, isAllDay, normalizeWhen, relativeWhen, whenStatus } from '../lib/when';
import './When.css';

interface Props {
  when: When;
  now?: Date;
  variant?: 'card' | 'inline';
}

/** Compact date pill for cards and lists: green while it's on, highlighted when it's within a week, faint once over. */
export function WhenBadge({ when, now, variant = 'card' }: Props) {
  const w = normalizeWhen(when);
  if (!w) return null;
  const at = now ?? new Date();
  const status = whenStatus(w, at);
  const label = formatWhen(w, at);
  const tone = status === 'ongoing' ? 'on' : status === 'past' ? 'past' : daysUntil(w, at) <= 7 ? 'soon' : 'later';

  let text = label;
  if (status === 'ongoing') {
    const multiDay = isAllDay(w.start) && !!w.end && w.end.slice(0, 10) !== w.start;
    // Ranges say when they end ("On now · until 5 Jan"); a timed event is simply on now; an all-day date is today.
    if (multiDay) text = `On now · ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
    else text = isAllDay(w.start) ? 'Today' : 'On now';
  }
  const relative = relativeWhen(w, at);

  return (
    <span className={`when-badge ${variant} is-${tone}`} title={relative ? `${label} (${relative})` : label}>
      <CalendarDays size={variant === 'card' ? 12 : 14} aria-hidden />
      <span className="when-badge-text">{text}</span>
      {relative && status !== 'ongoing' && <span className="sr-only">, {relative}</span>}
    </span>
  );
}
