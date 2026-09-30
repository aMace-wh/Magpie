const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : undefined;

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.round((ts - now) / 1000);
  const abs = Math.abs(s);
  if (!rtf) return new Date(ts).toLocaleDateString();
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  if (abs < 86400 * 30) return rtf.format(Math.round(s / (86400 * 7)), 'week');
  if (abs < 86400 * 365) return rtf.format(Math.round(s / (86400 * 30)), 'month');
  return rtf.format(Math.round(s / (86400 * 365)), 'year');
}

export function monthLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
