import { describe, expect, it } from 'vitest';
import {
  calendarEventFromItem,
  downloadIcs,
  escapeIcsText,
  foldIcsLine,
  googleCalendarUrl,
  icsFileName,
  toIcs,
  type CalendarEvent,
} from './calendar';

const NOW = new Date(Date.UTC(2026, 8, 30, 9, 5, 7));
const utf8 = (s: string) => new TextEncoder().encode(s).length;
/** Undo RFC 5545 line folding. */
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');
const lines = (ics: string) => unfold(ics).split('\r\n');
const prop = (ics: string, name: string) => lines(ics).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

const gig: CalendarEvent = { id: 'gig1', title: 'Jazz night', when: { start: '2026-10-12T19:30' }, location: 'Ronnie Scott’s, London' };

describe('toIcs', () => {
  it('builds a valid calendar wrapper with CRLF line endings', () => {
    const ics = toIcs([gig], { now: NOW });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Magpie//EN\r\nCALSCALE:GREGORIAN\r\n')).toBe(true);
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(lines(ics).filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('writes UID, a UTC DTSTAMP and floating local times', () => {
    const ics = toIcs([gig], { now: NOW });
    expect(prop(ics, 'UID')).toBe('UID:gig1@magpie');
    expect(prop(ics, 'DTSTAMP')).toBe('DTSTAMP:20260930T090507Z');
    expect(prop(ics, 'DTSTART')).toBe('DTSTART:20261012T193000');
    // No end: two hours.
    expect(prop(ics, 'DTEND')).toBe('DTEND:20261012T213000');
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:Jazz night');
    expect(prop(ics, 'LOCATION')).toBe('LOCATION:Ronnie Scott’s\\, London');
  });

  it('uses the given end, and rolls a late start past midnight', () => {
    const withEnd = toIcs([{ ...gig, when: { start: '2026-10-12T19:30', end: '2026-10-13T01:00' } }], { now: NOW });
    expect(prop(withEnd, 'DTEND')).toBe('DTEND:20261013T010000');
    const late = toIcs([{ ...gig, when: { start: '2026-12-31T23:30' } }], { now: NOW });
    expect(prop(late, 'DTEND')).toBe('DTEND:20270101T013000');
  });

  it('writes all-day events as DATE values with an exclusive end', () => {
    const single = toIcs([{ id: 'a', title: 'Market', when: { start: '2026-10-03' } }], { now: NOW });
    expect(prop(single, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261003');
    expect(prop(single, 'DTEND')).toBe('DTEND;VALUE=DATE:20261004');
    const range = toIcs([{ id: 'b', title: 'Festival', when: { start: '2026-12-30', end: '2026-12-31' } }], { now: NOW });
    expect(prop(range, 'DTSTART')).toBe('DTSTART;VALUE=DATE:20261230');
    expect(prop(range, 'DTEND')).toBe('DTEND;VALUE=DATE:20270101');
  });

  it('escapes TEXT values', () => {
    expect(escapeIcsText('Food, Wine; Fun\\Stuff\r\nLine 2\nLine 3')).toBe('Food\\, Wine\\; Fun\\\\Stuff\\nLine 2\\nLine 3');
    expect(escapeIcsText('bell\u0007 and tab\tok')).toBe('bell and tab\tok');
    const ics = toIcs([{ id: 'x', title: 'A, B; C', when: { start: '2026-10-03' }, description: 'Line 1\nLine 2' }], { now: NOW });
    expect(prop(ics, 'SUMMARY')).toBe('SUMMARY:A\\, B\\; C');
    expect(prop(ics, 'DESCRIPTION')).toBe('DESCRIPTION:Line 1\\nLine 2');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const description = `Café crawl ☕️🥐 — ${'ünïcödé ✨ '.repeat(20)}end`;
    const ics = toIcs([{ id: 'long', title: 'Long one', when: { start: '2026-10-03' }, description }], { now: NOW });
    const physical = ics.split('\r\n').filter(Boolean);
    for (const line of physical) {
      expect(utf8(line)).toBeLessThanOrEqual(75);
      // No lone surrogate halves, i.e. no character was cut in two.
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(physical.some((l) => l.startsWith(' '))).toBe(true);
    expect(prop(ics, 'DESCRIPTION')).toBe(`DESCRIPTION:${escapeIcsText(description)}`);
  });

  it('foldIcsLine leaves short lines alone and continues with a space', () => {
    expect(foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short');
    const folded = foldIcsLine(`X:${'a'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts[0]).toHaveLength(75);
    expect(parts.slice(1).every((p) => p.startsWith(' ') && p.length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(`X:${'a'.repeat(200)}`);
    // A 4-byte emoji that would straddle the limit moves to the next line whole.
    const emoji = foldIcsLine(`X:${'a'.repeat(72)}😀b`);
    expect(emoji.split('\r\n')[0]).toBe(`X:${'a'.repeat(72)}`);
  });

  it('adds only http(s) links, and puts the link in the description too', () => {
    const ics = toIcs([{ ...gig, url: 'https://example.com/jazz?a=1,2', description: 'Bring cash' }], { now: NOW });
    expect(prop(ics, 'URL')).toBe('URL:https://example.com/jazz?a=1,2');
    expect(prop(ics, 'DESCRIPTION')).toBe('DESCRIPTION:Bring cash\\n\\nhttps://example.com/jazz?a=1\\,2');
    const bad = toIcs([{ ...gig, url: 'javascript:alert(1)' }], { now: NOW });
    expect(prop(bad, 'URL')).toBeUndefined();
    expect(bad).not.toContain('javascript');
  });

  it('skips events with an invalid date and names the calendar', () => {
    const ics = toIcs([{ id: 'bad', title: 'Nope', when: { start: 'soon' } }, gig], { now: NOW, name: 'Magpie, events' });
    expect(lines(ics).filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(prop(ics, 'X-WR-CALNAME')).toBe('X-WR-CALNAME:Magpie\\, events');
    expect(ics).not.toContain('bad@magpie');
  });
});

describe('googleCalendarUrl', () => {
  it('links an all-day period with an exclusive end', () => {
    const url = googleCalendarUrl({ id: 'f', title: 'Food & Drink Festival', when: { start: '2026-10-12', end: '2026-10-14' }, location: 'Hyde Park, London' });
    expect(url.startsWith('https://calendar.google.com/calendar/render?action=TEMPLATE&')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('text')).toBe('Food & Drink Festival');
    expect(q.get('dates')).toBe('20261012/20261015');
    expect(q.get('location')).toBe('Hyde Park, London');
    expect(q.has('details')).toBe(false);
    expect(url).toContain('text=Food%20%26%20Drink%20Festival');
  });

  it('links a timed event as floating local times', () => {
    const url = googleCalendarUrl({ ...gig, url: 'https://example.com/jazz', description: 'Bring cash' });
    const q = new URL(url).searchParams;
    expect(q.get('dates')).toBe('20261012T193000/20261012T213000');
    expect(q.get('details')).toBe('Bring cash\n\nhttps://example.com/jazz');
    expect(q.get('location')).toBe('Ronnie Scott’s, London');
  });

  it('leaves the dates out when the When is invalid', () => {
    expect(new URL(googleCalendarUrl({ id: 'z', title: '', when: { start: 'nope' } })).searchParams.has('dates')).toBe(false);
  });
});

describe('helpers', () => {
  it('icsFileName makes safe names', () => {
    expect(icsFileName('Jazz at the Barbican!')).toBe('jazz-at-the-barbican.ics');
    expect(icsFileName('Café  crawl / Soho')).toBe('cafe-crawl-soho.ics');
    expect(icsFileName('音楽')).toBe('event.ics');
    expect(icsFileName('trip.ics')).toBe('trip.ics');
  });

  it('downloadIcs does nothing outside a browser', () => {
    expect(downloadIcs('x', toIcs([gig], { now: NOW }))).toBe(false);
  });

  it('calendarEventFromItem builds an event from a saved item', () => {
    const ev = calendarEventFromItem({
      id: 'i1',
      title: 'Pottery class',
      when: { start: '2026-10-12T18:00', source: 'Mon 12 Oct 6pm' },
      place: { lat: 51.5, lng: -0.1, name: 'Clay Studio', address: '1 High St, London', country: 'United Kingdom', countryCode: 'GB' },
      url: 'https://example.com/pottery',
      note: 'Wear old clothes',
    });
    expect(ev).toEqual({
      id: 'i1',
      title: 'Pottery class',
      when: { start: '2026-10-12T18:00', source: 'Mon 12 Oct 6pm' },
      location: 'Clay Studio, 1 High St, London',
      url: 'https://example.com/pottery',
      description: 'Wear old clothes',
    });
    expect(calendarEventFromItem({ id: 'i2', title: 'No date' })).toBeUndefined();
    expect(calendarEventFromItem({ id: 'i3', title: 'Pin', when: { start: '2026-10-12' }, place: { lat: 51.5, lng: -0.12345678 } })?.location).toBe(
      '51.50000,-0.12346',
    );
  });
});
