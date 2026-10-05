import { describe, expect, it } from 'vitest';
import {
  addDaysIso,
  addMinutesIso,
  compareWhen,
  daysUntil,
  extractWhen,
  findWhen,
  formatWhen,
  isAllDay,
  isValidWhenString,
  nextWeekRange,
  normalizeWhen,
  parseLocal,
  relativeWhen,
  toLocalIso,
  weekendRange,
  whenBadge,
  whenFromFields,
  whenFromTexts,
  whenStatus,
  whenToFields,
  type WhenFields,
} from './when';
import type { When } from './types';

// Wed 30 Sep 2026, 10:00 local time.
const NOW = new Date(2026, 8, 30, 10, 0);
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const x = (text: string, now = NOW) => extractWhen(text, now);
const f = (text: string, now = NOW) => findWhen(text, now);
/** start/end only, so expectations don't depend on the exact source phrase. */
const se = (text: string, now = NOW) => {
  const w = x(text, now);
  return w && { start: w.start, end: w.end };
};
const GB12 = 'en-GB-u-hc-h12';

describe('extractWhen: single dates', () => {
  it('reads day-month and month-day in all their spellings', () => {
    expect(se('12 Oct')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('Oct 12')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('October 12th')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('12th of October 2026')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('Saturday, October 10')).toEqual({ start: '2026-10-10', end: undefined });
    expect(se('Sept. 3rd, 2027')).toEqual({ start: '2027-09-03', end: undefined });
    expect(se('on the 1st of Dec')).toEqual({ start: '2026-12-01', end: undefined });
  });

  it('reads a weekday + date + time and keeps the phrase as the source', () => {
    expect(x('Sat 12 Oct 7:30pm')).toEqual({ start: '2026-10-12T19:30', source: 'Sat 12 Oct 7:30pm' });
    expect(x('Come along! Sat 12 Oct 7:30pm 🎷')?.source).toBe('Sat 12 Oct 7:30pm');
    expect(se('Sat 12 Oct 19:30')).toEqual({ start: '2026-10-12T19:30', end: undefined });
    expect(se('12 October 2026, 7.30 p.m.')).toEqual({ start: '2026-10-12T19:30', end: undefined });
  });

  it('reads ISO and numeric dates (day first unless impossible)', () => {
    expect(se('2026-10-12')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('Starts 2026-10-12T19:30')).toEqual({ start: '2026-10-12T19:30', end: undefined });
    expect(se('12/10/2026')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('12.10.2026')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('13/10/2026')).toEqual({ start: '2026-10-13', end: undefined });
    expect(se('10/13/2026')).toEqual({ start: '2026-10-13', end: undefined });
    expect(se('Gig 12/10/26 8pm')).toEqual({ start: '2026-10-12T20:00', end: undefined });
    // Without a year only after a weekday.
    expect(se('Wed 14/10 8pm')).toEqual({ start: '2026-10-14T20:00', end: undefined });
    expect(x('14/10')).toBeUndefined();
  });

  it('picks the next occurrence when the year is missing', () => {
    expect(se('3 Jan')).toEqual({ start: '2027-01-03', end: undefined });
    expect(se('30 Sep')).toEqual({ start: '2026-09-30', end: undefined });
    expect(se('29 Sep')).toEqual({ start: '2027-09-29', end: undefined });
    expect(se('29 Feb')).toEqual({ start: '2028-02-29', end: undefined });
    expect(x('31 Sep')).toBeUndefined();
  });

  it('keeps an explicit year even when it is in the past', () => {
    expect(se('12 Oct 2025')).toEqual({ start: '2025-10-12', end: undefined });
  });

  it('offers, rather than trusts, a date whose weekday does not match', () => {
    // 12 Oct 2026 is a Monday: probably an old post (it was a Saturday in 2024).
    const clash = findWhen('Sat 12 Oct 7:30pm');
    expect(clash?.when).toEqual({ start: '2026-10-12T19:30', source: 'Sat 12 Oct 7:30pm' });
    expect(clash?.confidence).toBe('low');
    expect(findWhen('Sat 10 Oct 7:30pm')?.confidence).toBe('high');
    expect(findWhen('Wed 14/10 8pm')?.confidence).toBe('high');
    expect(findWhen('Thu 14/10 8pm')?.confidence).toBe('low');
    expect(findWhen('until Sat 5 Jan')?.confidence).toBe('low');
    expect(findWhen('Sat 16 – Sun 18 October')?.confidence).toBe('low');
    expect(findWhen('Fri 16 – Sun 18 October')?.confidence).toBe('high');
    expect(findWhen('Mon 12 Oct – Fri 16 Oct')?.confidence).toBe('high');
    expect(findWhen('Sat 12 Oct – Fri 16 Oct')?.confidence).toBe('low');
    // A date that agrees with its weekday wins over one that doesn't.
    expect(se('Sat 12 Oct 7:30pm, or Tue 20 Oct')).toEqual({ start: '2026-10-20', end: undefined });
  });

  it('rejects impossible days instead of guessing the month', () => {
    expect(x('29 February 2027')).toBeUndefined();
    expect(x('30 Feb 2027')).toBeUndefined();
    expect(x('Feb 30, 2027')).toBeUndefined();
    expect(x('31 Sep 2026')).toBeUndefined();
    expect(x('Sat 30 Feb 2027 7pm')).toBeUndefined();
    expect(se('29 February 2028')).toEqual({ start: '2028-02-29', end: undefined });
  });

  it('handles month + year as the whole month', () => {
    expect(se('Nov 2026')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(se('Open studios all of February 2028')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
});

describe('extractWhen: relative days and weekdays', () => {
  it('understands today, tonight and tomorrow', () => {
    expect(se('today')).toEqual({ start: '2026-09-30', end: undefined });
    expect(se('tonight')).toEqual({ start: '2026-09-30', end: undefined });
    expect(se('Live tonight at 8')).toEqual({ start: '2026-09-30T20:00', end: undefined });
    expect(se('tonight 9:30pm')).toEqual({ start: '2026-09-30T21:30', end: undefined });
    expect(se('tomorrow')).toEqual({ start: '2026-10-01', end: undefined });
    expect(se('7pm tomorrow')).toEqual({ start: '2026-10-01T19:00', end: undefined });
  });

  it('resolves weekdays', () => {
    expect(se('Friday 7pm')).toEqual({ start: '2026-10-02T19:00', end: undefined });
    expect(se('this Saturday')).toEqual({ start: '2026-10-03', end: undefined });
    expect(se('next Friday')).toEqual({ start: '2026-10-09', end: undefined });
    expect(se('see you on Sunday!')).toEqual({ start: '2026-10-04', end: undefined });
    expect(se('Thursday night')).toEqual({ start: '2026-10-01', end: undefined });
    // A Wednesday 9am event seen on Wednesday at 10:00 is next week's.
    expect(se('Wednesday 9am')).toEqual({ start: '2026-10-07T09:00', end: undefined });
  });

  it('understands weekends', () => {
    expect(se('this weekend')).toEqual({ start: '2026-10-03', end: '2026-10-04' });
    expect(se('next weekend')).toEqual({ start: '2026-10-10', end: '2026-10-11' });
    expect(se('Pop-up market this weekend! 10am-4pm')).toEqual({ start: '2026-10-03', end: '2026-10-04' });
    // Seen on a Sunday: what's left of this weekend is today.
    expect(se('this weekend', at(2026, 10, 4, 9))).toEqual({ start: '2026-10-04', end: undefined });
  });

  it('prefers named dates over loose words', () => {
    expect(se('Made this today — next one is Sat 17 Oct')).toEqual({ start: '2026-10-17', end: undefined });
    expect(findWhen('Made this today')?.confidence).toBe('low');
    expect(findWhen('Sat 17 Oct')?.confidence).toBe('high');
  });
});

describe('extractWhen: periods', () => {
  it('reads day ranges, rolling a past range into next year', () => {
    expect(se('12–14 July')).toEqual({ start: '2027-07-12', end: '2027-07-14' });
    expect(se('12th - 14th July 2026')).toEqual({ start: '2026-07-12', end: '2026-07-14' });
    expect(se('July 12-14')).toEqual({ start: '2027-07-12', end: '2027-07-14' });
    expect(se('Fri 16 – Sun 18 October')).toEqual({ start: '2026-10-16', end: '2026-10-18' });
    expect(se('Sat 3 & Sun 4 Oct')).toEqual({ start: '2026-10-03', end: '2026-10-04' });
  });

  it('reads ranges across months and years', () => {
    expect(se('12 July - 3 August 2026')).toEqual({ start: '2026-07-12', end: '2026-08-03' });
    expect(se('Oct 3 – Oct 20')).toEqual({ start: '2026-10-03', end: '2026-10-20' });
    expect(se('30 Oct – 2 Nov')).toEqual({ start: '2026-10-30', end: '2026-11-02' });
    expect(se('30–2 Nov')).toEqual({ start: '2026-10-30', end: '2026-11-02' });
    expect(se('28 Dec – 3 Jan')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
    expect(se('20 Dec 2026 to 5 Jan 2027')).toEqual({ start: '2026-12-20', end: '2027-01-05' });
    expect(se('2026-10-12 to 2026-10-14')).toEqual({ start: '2026-10-12', end: '2026-10-14' });
    expect(se('October 2026 – March 2027')).toEqual({ start: '2026-10-01', end: '2027-03-31' });
  });

  it('keeps start and end times written between and after the two dates', () => {
    expect(x('Dec 31 10pm - Jan 1 2am')).toEqual({ start: '2026-12-31T22:00', end: '2027-01-01T02:00', source: 'Dec 31 10pm - Jan 1 2am' });
    expect(se('NYE: 31 Dec at 10pm until 1 Jan at 2am')).toEqual({ start: '2026-12-31T22:00', end: '2027-01-01T02:00' });
    expect(se('12 Oct 7pm – 14 Oct 5pm')).toEqual({ start: '2026-10-12T19:00', end: '2026-10-14T17:00' });
    expect(se('Fri 16 Oct 19:00 - Sun 18 Oct 17:30')).toEqual({ start: '2026-10-16T19:00', end: '2026-10-18T17:30' });
    // Start time only: from that time until the end of the last day.
    expect(se('Fri 16 Oct 7pm – Sun 18 Oct')).toEqual({ start: '2026-10-16T19:00', end: '2026-10-18' });
    expect(se('2026-10-12 19:00 to 2026-10-14 18:00')).toEqual({ start: '2026-10-12T19:00', end: '2026-10-14T18:00' });
    // "&" lists separate days, it doesn't make a timed range.
    expect(se('12 Oct 7pm & 14 Oct')).toEqual({ start: '2026-10-12T19:00', end: undefined });
    // Daily hours stay with their own day.
    expect(se('Sat 10 Oct 7-11pm, Sun 11 Oct 2-6pm')).toEqual({ start: '2026-10-10T19:00', end: '2026-10-10T23:00' });
  });

  it('keeps a range that is on right now in this year', () => {
    expect(se('25 Sep – 5 Oct')).toEqual({ start: '2026-09-25', end: '2026-10-05' });
  });

  it('reads "until" phrases as today → that date', () => {
    expect(x('until 5 Jan')).toEqual({ start: '2026-09-30', end: '2027-01-05', source: 'until 5 Jan' });
    expect(x('Exhibition runs until 5 January')).toEqual({ start: '2026-09-30', end: '2027-01-05', source: 'runs until 5 January' });
    expect(se('On through Jan 5')).toEqual({ start: '2026-09-30', end: '2027-01-05' });
    expect(se('Ends 5 Jan.')).toEqual({ start: '2026-09-30', end: '2027-01-05' });
    expect(se('Open until Sunday')).toEqual({ start: '2026-09-30', end: '2026-10-04' });
    expect(se('Last chance: ends this Sunday')).toEqual({ start: '2026-09-30', end: '2026-10-04' });
    expect(se('on until next Friday')).toEqual({ start: '2026-09-30', end: '2026-10-09' });
  });

  it('reads "from" phrases as a start date', () => {
    expect(x('from 1 Nov')).toEqual({ start: '2026-11-01', source: 'from 1 Nov' });
    expect(se('Opening 14 Nov 6pm')).toEqual({ start: '2026-11-14T18:00', end: undefined });
  });
});

describe('extractWhen: times', () => {
  it('reads time ranges and open ends', () => {
    expect(se('Sat 10 Oct 7pm–11pm')).toEqual({ start: '2026-10-10T19:00', end: '2026-10-10T23:00' });
    expect(se('Sat 10 Oct 7-11pm')).toEqual({ start: '2026-10-10T19:00', end: '2026-10-10T23:00' });
    expect(se('10 Oct 19:00 - 23:30')).toEqual({ start: '2026-10-10T19:00', end: '2026-10-10T23:30' });
    expect(se('10 Oct 10pm - 2am')).toEqual({ start: '2026-10-10T22:00', end: '2026-10-11T02:00' });
    expect(x('10 Oct 7pm till late')).toEqual({ start: '2026-10-10T19:00', source: '10 Oct 7pm till late' });
  });

  it('finds "doors" times next to or away from the date', () => {
    expect(se('Sat 10 Oct, doors 7pm')).toEqual({ start: '2026-10-10T19:00', end: undefined });
    expect(se('Oct 3 - 7pm')).toEqual({ start: '2026-10-03T19:00', end: undefined });
    expect(se('Doors 7pm · Sat 10 Oct')).toEqual({ start: '2026-10-10T19:00', end: undefined });
    expect(se('🎶 LIVE 🎶\nSaturday 10th October\n📍 The Old Mill\nDoors open at 7:30pm')).toEqual({
      start: '2026-10-10T19:30',
      end: undefined,
    });
  });

  it('copes with messy real-world posts', () => {
    expect(se('✨ SUPPER CLUB ✨ Fri 16th Oct — 7.30pm — £45pp — link in bio')).toEqual({ start: '2026-10-16T19:30', end: undefined });
    expect(se('Exhibition: 3 Oct – 20 Dec 2026 at the Tate. Tickets £12. Open daily 10am-6pm')).toEqual({
      start: '2026-10-03',
      end: '2026-12-20',
    });
    expect(se('Posted 01/09/2026 — gig Sat 17 Oct, 8pm')).toEqual({ start: '2026-10-17T20:00', end: undefined });
    expect(se('Tickets on sale 1 Oct! Show: 14 Nov')).toEqual({ start: '2026-11-14', end: undefined });
    expect(se('See https://example.com/events/2026-01-01/ for 12 Oct')).toEqual({ start: '2026-10-12', end: undefined });
  });

  it('combines several text fields', () => {
    expect(whenFromTexts(['Jazz night', null, undefined, 'Thu 8 Oct, 8pm'], NOW)?.start).toBe('2026-10-08T20:00');
    expect(whenFromTexts([null, ''], NOW)).toBeUndefined();
  });
});

describe('extractWhen: false positives', () => {
  const nothing = [
    '15 minute pasta',
    '5k run',
    '1/2 cup flour',
    '£12',
    '2 tbsp olive oil',
    'top 10 cafes in Lisbon',
    'open 24/7',
    '30 min full body',
    '3pm',
    'Doors 7pm',
    'Serves 4',
    'Call 020 7946 0958',
    'Call +1 (555) 123-4567',
    'only $12.99!',
    'Version 2.4.1 is out',
    'v1.12.26',
    '1-2 people',
    'iPhone 15',
    'you may 2x the sauce',
    'Open Mon-Fri 9am-5pm',
    'Every Friday 7pm',
    'closed on Monday',
    'I sat down with sun-dried tomatoes',
    'Posted on Friday',
    '',
  ];
  it.each(nothing)('returns undefined for %j', (text) => {
    expect(x(text)).toBeUndefined();
  });

  it('still reads a capitalised May', () => {
    expect(se('May 5')).toEqual({ start: '2027-05-05', end: undefined });
  });
});

describe('extractWhen: CJK dates and times', () => {
  it('reads 年月日, 月日 and 號, in fullwidth digits and Korean too', () => {
    expect(se('2027年3月14日')).toEqual({ start: '2027-03-14', end: undefined });
    expect(se('10月12日')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('10月12號')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('１０月１２日')).toEqual({ start: '2026-10-12', end: undefined });
    expect(se('10월 12일')).toEqual({ start: '2026-10-12', end: undefined });
    expect(f('10月12日')?.confidence).toBe('high');
    // A year and month alone is the whole month.
    expect(se('2026年11月')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
  });

  it('reads ranges within and across months', () => {
    expect(se('10月3-9日')).toEqual({ start: '2026-10-03', end: '2026-10-09' });
    expect(se('10月3日至9日')).toEqual({ start: '2026-10-03', end: '2026-10-09' });
    expect(se('10月3日至11月15日')).toEqual({ start: '2026-10-03', end: '2026-11-15' });
    expect(se('10月30日-11月2日')).toEqual({ start: '2026-10-30', end: '2026-11-02' });
    expect(se('12月28日～1月3日')).toEqual({ start: '2026-12-28', end: '2027-01-03' });
    expect(x('由10月3日至11月15日')).toEqual({ start: '2026-10-03', end: '2026-11-15', source: '由10月3日至11月15日' });
  });

  it('reads "from" and "until" phrases', () => {
    expect(x('即日起至11月15日')).toEqual({ start: '2026-09-30', end: '2026-11-15', source: '即日起至11月15日' });
    expect(se('展覽11月15日止')).toEqual({ start: '2026-09-30', end: '2026-11-15' });
    expect(se('10月20日起')).toEqual({ start: '2026-10-20', end: undefined });
  });

  it('checks the weekday written after a date', () => {
    expect(f('10月10日（六）')).toMatchObject({ when: { start: '2026-10-10' }, confidence: 'high' });
    expect(f('10月10日(土)')).toMatchObject({ when: { start: '2026-10-10' }, confidence: 'high' });
    // 10 Oct 2026 is a Saturday, not a Friday.
    expect(f('10月10日（五）')?.confidence).toBe('low');
  });

  it('reads times next to the date', () => {
    expect(se('10月10日 晚上7點')).toEqual({ start: '2026-10-10T19:00', end: undefined });
    expect(se('10月10日晚上7點半')).toEqual({ start: '2026-10-10T19:30', end: undefined });
    expect(se('10月10日 下午3時')).toEqual({ start: '2026-10-10T15:00', end: undefined });
    expect(se('10月10日 中午12點')).toEqual({ start: '2026-10-10T12:00', end: undefined });
    expect(se('10月10日 19:30')).toEqual({ start: '2026-10-10T19:30', end: undefined });
    expect(se('10月10日 7:30pm')).toEqual({ start: '2026-10-10T19:30', end: undefined });
    expect(se('10月10日（六）時間：晚上8:15')).toEqual({ start: '2026-10-10T20:15', end: undefined });
    expect(se('10月10日 晚上8點至11點')).toEqual({ start: '2026-10-10T20:00', end: '2026-10-10T23:00' });
  });

  it('reads weekdays, with a time unless the week is named', () => {
    expect(se('星期五 晚上8點')).toEqual({ start: '2026-10-02T20:00', end: undefined });
    expect(se('週六晚上7點')).toEqual({ start: '2026-10-03T19:00', end: undefined });
    expect(se('下星期五')).toEqual({ start: '2026-10-09', end: undefined });
    expect(f('今個星期六')).toMatchObject({ when: { start: '2026-10-03' }, confidence: 'low' });
    expect(x('星期五')).toBeUndefined();
  });
});

describe('extractWhen: day/month without a year', () => {
  it('reads a range when only one order makes sense, or after a label', () => {
    expect(se('18/9-26/10')).toEqual({ start: '2026-09-18', end: '2026-10-26' });
    expect(se('18/9 – 26/10')).toEqual({ start: '2026-09-18', end: '2026-10-26' });
    expect(f('日期：18/9-26/10')).toMatchObject({ when: { start: '2026-09-18', end: '2026-10-26', source: '18/9-26/10' }, confidence: 'high' });
    expect(se('27-29/11')).toEqual({ start: '2026-11-27', end: '2026-11-29' });
    // 3/10 could be 3 Oct or 10 Mar: day first, but only after a label.
    expect(se('日期：3/10-5/10')).toEqual({ start: '2026-10-03', end: '2026-10-05' });
    expect(se('Dates: 3/10 - 5/10')).toEqual({ start: '2026-10-03', end: '2026-10-05' });
    expect(x('3/10-5/10')).toBeUndefined();
    // Weekdays settle it too, month first when only that fits (as written in Taiwan).
    expect(f('3/10(六)-4/10(日)')).toMatchObject({ when: { start: '2026-10-03', end: '2026-10-04' }, confidence: 'high' });
    expect(f('10/3(六)-10/4(日)')).toMatchObject({ when: { start: '2026-10-03', end: '2026-10-04' }, confidence: 'high' });
  });

  it('reads a single date only after a label or "until", or with its weekday', () => {
    expect(se('日期：14/11')).toEqual({ start: '2026-11-14', end: undefined });
    expect(se('14/11（六）')).toEqual({ start: '2026-11-14', end: undefined });
    expect(f('3/10（六）')).toMatchObject({ when: { start: '2026-10-03' }, confidence: 'high' });
    expect(f('10/3（六）')).toMatchObject({ when: { start: '2026-10-03' }, confidence: 'high' });
    expect(f('3/10（五）')?.confidence).toBe('low');
    expect(f('至14/11')).toMatchObject({ when: { start: '2026-09-30', end: '2026-11-14' }, confidence: 'high' });
    // 3 Nov or 11 Mar? Offered, not applied.
    expect(f('至3/11')).toMatchObject({ when: { start: '2026-09-30', end: '2026-11-03' }, confidence: 'low' });
    expect(f('until 3/11')?.confidence).toBe('low');
    expect(x('14/11')).toBeUndefined();
    expect(x('1/2杯牛奶')).toBeUndefined();
  });
});

describe('extractWhen: dates that are not the event’s', () => {
  it('ignores the posting date in a post’s likes / comments wrapper', () => {
    expect(x('1,234 likes, 56 comments - mei.eats on October 12, 2026: “Pasta night at home”')).toBeUndefined();
    expect(x('21K likes, 306 comments - mei.eats on October 12, 2026')).toBeUndefined();
    expect(x('mei.eats on October 12, 2026: “Pasta night at home”')).toBeUndefined();
    expect(x('2,345 個讚、67 則留言 - mei.eats 於 2026年10月12日:「屋企煮意粉」')).toBeUndefined();
    expect(x('Mei (@mei.eats) • Instagram reel\n1,234 likes, 56 comments - mei.eats on October 1, 2026: “Pasta night”')).toBeUndefined();
    expect(x('Instagram post by Mei • Oct 12, 2026 at 10:00 AM')).toBeUndefined();
    // The caption's own dates still count, and so does a sentence that only starts like a wrapper.
    expect(se('1,234 likes, 56 comments - mei.eats on October 12, 2026: “Supper club Fri 16 Oct, 7.30pm”')).toEqual({
      start: '2026-10-16T19:30',
      end: undefined,
    });
    expect(se('Mei (@mei.eats) • Instagram reel\n1,234 likes - mei.eats on October 1, 2026: “日期：18/9-26/10”')).toEqual({
      start: '2026-09-18',
      end: '2026-10-26',
    });
    expect(se('Concert on October 12, 2026')).toEqual({ start: '2026-10-12', end: undefined });
  });

  it('ignores opening hours and repeating days', () => {
    expect(x('開放時間：二至日 10:00-22:00')).toBeUndefined();
    expect(x('營業時間：週一至五 10:00-19:00')).toBeUndefined();
    expect(x('營業時間：週六 11:00-20:00')).toBeUndefined();
    expect(x('Opening hours: Sat 10am-4pm')).toBeUndefined();
    expect(x('Hours: Tue–Sun 9–5')).toBeUndefined();
    expect(x('10:00-22:00')).toBeUndefined();
    expect(x('逢星期六 晚上8點')).toBeUndefined();
    expect(x('週末去海邊')).toBeUndefined();
  });

  it('ignores offers, booking windows and posting dates', () => {
    expect(x('11月3-9期間訂購享9折')).toBeUndefined();
    expect(x('優惠期：11月3日至9日')).toBeUndefined();
    expect(x('早鳥優惠：即日起至10月20日')).toBeUndefined();
    expect(x('10月20日前報名')).toBeUndefined();
    expect(x('10月20日開售')).toBeUndefined();
    expect(x('報名截止日期：10月20日')).toBeUndefined();
    expect(x('發佈日期：2026年10月12日')).toBeUndefined();
    expect(x('Book by 20 Oct for 10% off')).toBeUndefined();
    expect(x('Early bird until 20 Oct')).toBeUndefined();
    // The event itself is still read.
    expect(se('早鳥優惠：即日起至10月20日\n日期：14/11（六）')).toEqual({ start: '2026-11-14', end: undefined });
  });

  it('ignores durations, seasons and counts', () => {
    expect(x('9日遊3個城市')).toBeUndefined();
    expect(x('26小時住宿')).toBeUndefined();
    expect(x('由朝早9點到翌日下午4點')).toBeUndefined();
    expect(x('每年 6–8 月最當造')).toBeUndefined();
    expect(x('3月10個人去露營')).toBeUndefined();
    expect(x('10月份')).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parseLocal reads local wall-clock time', () => {
    const d = parseLocal('2026-10-12');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 12, 0]);
    const t = parseLocal('2026-10-12T19:30');
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([12, 19, 30]);
    expect(Number.isNaN(parseLocal('12 Oct').getTime())).toBe(true);
  });

  it('isAllDay / isValidWhenString', () => {
    expect(isAllDay('2026-10-12')).toBe(true);
    expect(isAllDay('2026-10-12T19:30')).toBe(false);
    expect(isValidWhenString('2026-10-12T19:30')).toBe(true);
    expect(isValidWhenString('2028-02-29')).toBe(true);
    expect(isValidWhenString('2026-02-29')).toBe(false);
    expect(isValidWhenString('2026-13-01')).toBe(false);
    expect(isValidWhenString('2026-10-12T24:00')).toBe(false);
    expect(isValidWhenString('2026-10-12 19:30')).toBe(false);
    expect(isValidWhenString('2026-1-5')).toBe(false);
    expect(isValidWhenString(20261012)).toBe(false);
  });

  it('date arithmetic stays floating', () => {
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2026-10-12T19:30', -12)).toBe('2026-09-30T19:30');
    expect(addMinutesIso('2026-12-31T23:30', 120)).toBe('2027-01-01T01:30');
    expect(toLocalIso(at(2026, 3, 29, 23, 45))).toBe('2026-03-29');
    expect(toLocalIso(at(2026, 3, 29, 23, 45), true)).toBe('2026-03-29T23:45');
    expect(weekendRange(NOW)).toEqual({ start: '2026-10-03', end: '2026-10-04' });
    expect(weekendRange(at(2026, 10, 3, 12))).toEqual({ start: '2026-10-03', end: '2026-10-04' });
    expect(nextWeekRange(NOW)).toEqual({ start: '2026-10-05', end: '2026-10-11' });
  });

  it('normalizeWhen validates, swaps and tidies', () => {
    expect(normalizeWhen({ start: '2026-10-14', end: '2026-10-12' })).toEqual({ start: '2026-10-12', end: '2026-10-14' });
    expect(normalizeWhen({ start: '2026-10-12T21:00', end: '2026-10-12T19:00' })).toEqual({ start: '2026-10-12T19:00', end: '2026-10-12T21:00' });
    expect(normalizeWhen({ start: '2026-10-12', end: 'soon' })).toEqual({ start: '2026-10-12' });
    expect(normalizeWhen({ start: '2026-10-12', end: '2026-10-12' })).toEqual({ start: '2026-10-12' });
    expect(normalizeWhen({ start: '2026-10-12T19:00', end: '2026-10-12' })).toEqual({ start: '2026-10-12T19:00' });
    expect(normalizeWhen({ start: '2026-10-12', source: '  Sat\n 12 Oct ' })).toEqual({ start: '2026-10-12', source: 'Sat 12 Oct' });
    expect(normalizeWhen({ start: '2026-02-30' })).toBeUndefined();
    expect(normalizeWhen(undefined)).toBeUndefined();
    expect(normalizeWhen('2026-10-12')).toBeUndefined();
  });

  it('whenStatus: all-day ends are inclusive, timed events last 3 hours', () => {
    const day: When = { start: '2026-10-12' };
    expect(whenStatus(day, at(2026, 10, 11, 23, 59))).toBe('upcoming');
    expect(whenStatus(day, at(2026, 10, 12, 23, 59))).toBe('ongoing');
    expect(whenStatus(day, at(2026, 10, 13, 0, 0))).toBe('past');
    const range: When = { start: '2026-10-12', end: '2026-10-14' };
    expect(whenStatus(range, at(2026, 10, 14, 23, 59))).toBe('ongoing');
    expect(whenStatus(range, at(2026, 10, 15, 0, 1))).toBe('past');
    const gig: When = { start: '2026-10-12T19:30' };
    expect(whenStatus(gig, at(2026, 10, 12, 19, 29))).toBe('upcoming');
    expect(whenStatus(gig, at(2026, 10, 12, 22, 29))).toBe('ongoing');
    expect(whenStatus(gig, at(2026, 10, 12, 22, 31))).toBe('past');
    expect(whenStatus({ start: '2026-10-12T19:30', end: '2026-10-12T20:00' }, at(2026, 10, 12, 20, 1))).toBe('past');
  });

  it('daysUntil and compareWhen', () => {
    expect(daysUntil({ start: '2026-10-03' }, NOW)).toBe(3);
    expect(daysUntil({ start: '2026-09-30T23:00' }, NOW)).toBe(0);
    expect(daysUntil({ start: '2026-09-25', end: '2026-10-05' }, NOW)).toBe(-5);
    const list: (When | undefined)[] = [undefined, { start: '2026-10-12T19:00' }, { start: '2026-10-12' }, { start: '2026-10-01', end: '2026-10-20' }, { start: '2026-10-01' }];
    expect(list.sort(compareWhen)).toEqual([
      { start: '2026-10-01' },
      { start: '2026-10-01', end: '2026-10-20' },
      { start: '2026-10-12' },
      { start: '2026-10-12T19:00' },
      undefined,
    ]);
  });
});

describe('formatWhen', () => {
  it('formats single days, with relative words for today and tomorrow', () => {
    expect(formatWhen({ start: '2026-10-10T19:30' }, NOW, GB12)).toBe('Sat 10 Oct · 7:30 pm');
    expect(formatWhen({ start: '2026-10-10T19:30' }, NOW, 'en-GB')).toBe('Sat 10 Oct · 19:30');
    expect(formatWhen({ start: '2026-10-10T19:30' }, NOW, 'en-US')).toBe('Sat Oct 10 · 7:30 PM');
    expect(formatWhen({ start: '2026-09-30T19:00' }, NOW, GB12)).toBe('Today · 7 pm');
    expect(formatWhen({ start: '2026-10-01' }, NOW, GB12)).toBe('Tomorrow');
    expect(formatWhen({ start: '2026-10-10' }, NOW, GB12)).toBe('Sat 10 Oct');
  });

  it('formats ranges, showing the year only when it is not the current one', () => {
    expect(formatWhen({ start: '2026-07-12', end: '2026-07-14' }, NOW, GB12)).toBe('12–14 Jul');
    expect(formatWhen({ start: '2027-07-12', end: '2027-08-03' }, NOW, GB12)).toBe('12 Jul – 3 Aug 2027');
    expect(formatWhen({ start: '2026-12-28', end: '2027-01-03' }, NOW, GB12)).toBe('28 Dec – 3 Jan 2027');
    expect(formatWhen({ start: '2026-12-28', end: '2027-01-03' }, NOW, 'en-US')).toBe('Dec 28 – Jan 3, 2027');
    expect(formatWhen({ start: '2027-12-28', end: '2028-01-03' }, NOW, GB12)).toBe('28 Dec 2027 – 3 Jan 2028');
    expect(formatWhen({ start: '2027-07-12', end: '2027-07-14' }, NOW, 'en-US')).toBe('Jul 12–14, 2027');
    expect(formatWhen({ start: '2025-12-28', end: '2026-01-03' }, NOW, GB12)).toBe('28 Dec 2025 – 3 Jan 2026');
    expect(formatWhen({ start: '2026-11-01', end: '2026-11-30' }, NOW, GB12)).toBe('November');
    expect(formatWhen({ start: '2027-05-01', end: '2027-05-31' }, NOW, GB12)).toBe('May 2027');
    expect(formatWhen({ start: '2027-02-01', end: '2027-02-28' }, NOW, GB12)).toBe('February 2027');
  });

  it('shows the year on single days outside the current year only', () => {
    expect(formatWhen({ start: '2027-01-09T19:30' }, NOW, GB12)).toBe('Sat 9 Jan 2027 · 7:30 pm');
    expect(formatWhen({ start: '2026-12-31' }, NOW, GB12)).toBe('Thu 31 Dec');
    expect(formatWhen({ start: '2027-01-09' }, at(2027, 1, 2, 9), GB12)).toBe('Sat 9 Jan');
    // Relative words need no year.
    expect(formatWhen({ start: '2027-01-01' }, at(2026, 12, 31, 9), GB12)).toBe('Tomorrow');
  });

  it('says "Until …" for things on right now', () => {
    expect(formatWhen({ start: '2026-09-30', end: '2027-01-05' }, NOW, GB12)).toBe('Until 5 Jan 2027');
    expect(formatWhen({ start: '2026-12-20', end: '2027-01-05' }, at(2027, 1, 2, 9), GB12)).toBe('Until 5 Jan');
    expect(formatWhen({ start: '2026-09-25', end: '2026-09-30' }, NOW, GB12)).toBe('Ends today');
    expect(formatWhen({ start: '2026-09-25', end: '2026-10-01' }, NOW, GB12)).toBe('Until tomorrow');
  });

  it('formats timed spans', () => {
    expect(formatWhen({ start: '2026-10-10T19:00', end: '2026-10-10T23:00' }, NOW, GB12)).toBe('Sat 10 Oct · 7 pm – 11 pm');
    expect(formatWhen({ start: '2026-10-10T22:00', end: '2026-10-11T02:00' }, NOW, GB12)).toBe('Sat 10 Oct · 10 pm – 2 am');
    expect(formatWhen({ start: '2026-10-10T10:00', end: '2026-10-12T18:00' }, NOW, GB12)).toBe('Sat 10 Oct 10 am – Mon 12 Oct 6 pm');
  });

  it('falls back to the source for an invalid When', () => {
    expect(formatWhen({ start: 'someday', source: 'sometime soon' }, NOW)).toBe('sometime soon');
  });
});

describe('whenToFields / whenFromFields', () => {
  const roundTrip = (w: When) => whenFromFields(whenToFields(w)).when;
  const fields = (f: Partial<WhenFields>): WhenFields => ({ startDate: '2026-10-12', endDate: '', timed: false, startTime: '', endTime: '', ...f });

  it('round-trips every shape of When without losing anything', () => {
    const shapes: When[] = [
      { start: '2026-10-12' },
      { start: '2026-10-12', end: '2026-10-14' },
      { start: '2026-10-12T19:30' },
      { start: '2026-10-12T19:00', end: '2026-10-12T23:00' },
      { start: '2026-10-12T22:00', end: '2026-10-13T02:00' },
      { start: '2026-10-12T19:00', end: '2026-10-13T19:00' },
      { start: '2026-10-12T19:00', end: '2026-10-13T21:00' },
      { start: '2026-10-12T19:00', end: '2026-10-14' },
      { start: '2026-10-12', end: '2026-10-14T18:00' },
    ];
    for (const w of shapes) expect(roundTrip(w)).toEqual(w);
  });

  it('shows the time inputs for an all-day start with a timed end', () => {
    expect(whenToFields({ start: '2026-10-12', end: '2026-10-14T18:00' })).toEqual({
      startDate: '2026-10-12',
      endDate: '2026-10-14',
      timed: true,
      startTime: '',
      endTime: '18:00',
    });
    expect(whenToFields({ start: '2026-10-12T22:00', end: '2026-10-13T02:00' })).toMatchObject({ endDate: '', endTime: '02:00' });
    expect(whenToFields(undefined)).toEqual({ startDate: '', endDate: '', timed: false, startTime: '', endTime: '' });
  });

  it('validates the fields', () => {
    expect(whenFromFields(fields({ startDate: '' })).error).toBe('Pick a start date.');
    expect(whenFromFields(fields({ endDate: '2026-10-11' })).error).toBe('The end date is before the start.');
    expect(whenFromFields(fields({ timed: true })).error).toBe('Add a start time, or switch the time off.');
    expect(whenFromFields(fields({ timed: true, endTime: '18:00' })).error).toBe('Add a start time, or switch the time off.');
    expect(whenFromFields(fields({ timed: true, startTime: '19:00', endDate: '2026-10-12', endTime: '18:00' })).error).toBe('It ends before it starts.');
    expect(whenFromFields(fields({ startDate: '2026-02-30' })).error).toBe('That date doesn’t look right.');
    // Times are ignored while the switch is off; a late end time with no end date runs past midnight.
    expect(whenFromFields(fields({ startTime: '19:00', endTime: '23:00' })).when).toEqual({ start: '2026-10-12' });
    expect(whenFromFields(fields({ timed: true, startTime: '22:00', endTime: '01:00' })).when).toEqual({ start: '2026-10-12T22:00', end: '2026-10-13T01:00' });
  });
});

describe('relativeWhen', () => {
  it('describes how far away it is', () => {
    expect(relativeWhen({ start: '2026-10-03' }, NOW)).toBe('in 3 days');
    expect(relativeWhen({ start: '2026-10-01' }, NOW)).toBe('tomorrow');
    expect(relativeWhen({ start: '2026-09-30T19:00' }, NOW)).toBe('today');
    expect(relativeWhen({ start: '2026-09-30' }, NOW)).toBe('on now');
    expect(relativeWhen({ start: '2026-09-25', end: '2026-10-05' }, NOW)).toBe('on now');
    expect(relativeWhen({ start: '2026-09-29' }, NOW)).toBe('ended');
    expect(relativeWhen({ start: '2026-10-20' }, NOW)).toBe('in 3 weeks');
    expect(relativeWhen({ start: '2027-01-05' }, NOW)).toBe('in 3 months');
    expect(relativeWhen({ start: 'nope' }, NOW)).toBe('');
  });
});

describe('whenBadge', () => {
  it('follows the time: tomorrow, then today, then over', () => {
    const day = { start: '2026-10-01' };
    expect(whenBadge(day, NOW)).toMatchObject({ tone: 'soon', text: 'Tomorrow', spoken: 'tomorrow' });
    expect(whenBadge(day, at(2026, 10, 1, 0, 1))).toMatchObject({ tone: 'on', text: 'Today', spoken: '' });
    expect(whenBadge(day, at(2026, 10, 2, 0, 1))).toMatchObject({ tone: 'past', spoken: 'ended' });
  });

  it('says a timed event is on now while it runs', () => {
    const gig = { start: '2026-09-30T21:30', end: '2026-09-30T23:00' };
    expect(whenBadge(gig, at(2026, 9, 30, 21, 29))).toMatchObject({ tone: 'soon', spoken: 'today' });
    expect(whenBadge(gig, at(2026, 9, 30, 21, 30))).toMatchObject({ tone: 'on', text: 'On now', spoken: '' });
    expect(whenBadge(gig, at(2026, 9, 30, 23, 1))).toMatchObject({ tone: 'past', spoken: 'ended' });
  });

  it('says when a range on now ends, and how far off later ones are', () => {
    expect(whenBadge({ start: '2026-09-25', end: '2026-10-01' }, NOW)).toMatchObject({ tone: 'on', text: 'On now · until tomorrow' });
    expect(whenBadge({ start: '2026-10-20' }, NOW)).toMatchObject({ tone: 'later', spoken: 'in 3 weeks' });
    expect(whenBadge({ start: 'nope' }, NOW)).toBeUndefined();
  });
});
