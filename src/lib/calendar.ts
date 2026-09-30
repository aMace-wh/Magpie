import { safeUrl } from './classify';
import type { Item, Place, When } from './types';
import { addDaysIso, addMinutesIso, isAllDay, normalizeWhen } from './when';

/**
 * "Add to calendar": RFC 5545 .ics files (Apple / Outlook / most apps) and Google Calendar links.
 * Times are floating local times, so an event at 19:30 stays at 19:30 in whatever calendar it lands in.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  when: When;
  location?: string;
  url?: string;
  description?: string;
}

interface EventSpan {
  allDay: boolean;
  start: string;
  /** Exclusive end: the day after the last day for all-day events. */
  end: string;
}

function eventSpan(w: When): EventSpan {
  if (isAllDay(w.start)) {
    const last = w.end ? w.end.slice(0, 10) : w.start;
    return { allDay: true, start: w.start, end: addDaysIso(last, 1) };
  }
  let end: string;
  if (!w.end) end = addMinutesIso(w.start, 120); // no end given: assume two hours
  else if (isAllDay(w.end)) end = `${addDaysIso(w.end, 1)}T00:00`;
  else end = w.end;
  return { allDay: false, start: w.start, end };
}

const basicDate = (iso: string) => iso.slice(0, 10).replace(/-/g, '');
const basicDateTime = (iso: string) => `${basicDate(iso)}T${iso.slice(11, 13)}${iso.slice(14, 16)}00`;
const pad = (n: number) => String(n).padStart(2, '0');

function utcStamp(d: Date): string {
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines; other control characters are dropped. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function utf8Length(cp: number): number {
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** Folds a content line to at most 75 octets per physical line, never splitting a character. */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = utf8Length(ch.codePointAt(0)!);
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

function details(event: CalendarEvent): string {
  const description = event.description?.trim() ?? '';
  const url = safeUrl(event.url);
  // Most calendar apps ignore the URL property, so the link goes in the description too.
  return url && !description.includes(url) ? [description, url].filter(Boolean).join('\n\n') : description;
}

/**
 * An .ics calendar with one VEVENT per event (events with an invalid `when` are skipped).
 * All-day events use DATE values with an exclusive end; timed ones are floating local times
 * lasting until `when.end`, or two hours when there is no end.
 */
export function toIcs(events: CalendarEvent[], opts: { now?: Date; name?: string } = {}): string {
  const stamp = utcStamp(opts.now ?? new Date());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Magpie//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (opts.name?.trim()) lines.push(`X-WR-CALNAME:${escapeIcsText(opts.name.trim())}`);
  for (const event of events) {
    const when = normalizeWhen(event.when);
    if (!when) continue;
    const span = eventSpan(when);
    lines.push('BEGIN:VEVENT', `UID:${escapeIcsText(`${event.id}@magpie`)}`, `DTSTAMP:${stamp}`);
    if (span.allDay) lines.push(`DTSTART;VALUE=DATE:${basicDate(span.start)}`, `DTEND;VALUE=DATE:${basicDate(span.end)}`);
    else lines.push(`DTSTART:${basicDateTime(span.start)}`, `DTEND:${basicDateTime(span.end)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.title?.trim() || 'Untitled')}`);
    const location = event.location?.trim();
    if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
    const url = safeUrl(event.url);
    if (url) lines.push(`URL:${url}`);
    const text = details(event);
    if (text) lines.push(`DESCRIPTION:${escapeIcsText(text)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

/** A Google Calendar "create event" link, pre-filled with the title, dates, details and location. */
export function googleCalendarUrl(event: CalendarEvent): string {
  const params = ['action=TEMPLATE', `text=${encodeURIComponent(event.title?.trim() || 'Untitled')}`];
  const when = normalizeWhen(event.when);
  if (when) {
    const span = eventSpan(when);
    params.push(
      `dates=${span.allDay ? `${basicDate(span.start)}/${basicDate(span.end)}` : `${basicDateTime(span.start)}/${basicDateTime(span.end)}`}`,
    );
  }
  const text = details(event);
  if (text) params.push(`details=${encodeURIComponent(text)}`);
  const location = event.location?.trim();
  if (location) params.push(`location=${encodeURIComponent(location)}`);
  return `https://calendar.google.com/calendar/render?${params.join('&')}`;
}

/** A tidy file name for an event, e.g. "Jazz at the Barbican!" → "jazz-at-the-barbican.ics". */
export function icsFileName(name: string): string {
  const base = name
    .replace(/\.ics$/i, '')
    .normalize('NFKD')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '')
    .toLowerCase();
  return `${base || 'event'}.ics`;
}

/** Saves an .ics file in the browser. Returns false where that isn't possible (e.g. no DOM). */
export function downloadIcs(filename: string, ics: string): boolean {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }
  try {
    const href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = href;
    a.download = icsFileName(filename);
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return true;
  } catch {
    return false;
  }
}

function placeText(place: Place | undefined): string | undefined {
  if (!place) return undefined;
  const area = place.address?.trim() || [place.city, place.country].filter((s) => s?.trim()).join(', ');
  const name = place.name?.trim();
  const parts = name && area && !area.toLowerCase().startsWith(name.toLowerCase()) ? [name, area] : [area || name];
  const text = parts.filter(Boolean).join(', ');
  if (text) return text;
  // Calendar apps understand bare coordinates.
  return Number.isFinite(place.lat) && Number.isFinite(place.lng) ? `${place.lat.toFixed(5)},${place.lng.toFixed(5)}` : undefined;
}

/** The calendar event for a saved item, or undefined when it has no (valid) date. */
export function calendarEventFromItem(
  item: Pick<Item, 'id' | 'title' | 'when' | 'place' | 'url' | 'note' | 'description'>,
): CalendarEvent | undefined {
  const when = normalizeWhen(item.when);
  if (!when) return undefined;
  return {
    id: item.id,
    title: item.title,
    when,
    location: placeText(item.place),
    url: safeUrl(item.url),
    description: item.note?.trim() || item.description?.trim() || undefined,
  };
}
