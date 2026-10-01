import type { When } from './types';

/**
 * Event / activity periods. Reads a date or date range out of free text
 * ("Sat 12 Oct 7:30pm", "12–14 July", "runs until 5 Jan") and validates, compares
 * and formats the floating local ISO strings stored in `When`.
 *
 * Everything is local wall-clock time: "2026-10-12" is the 12th wherever you are,
 * so nothing here goes through UTC parsing.
 */

// ---------------------------------------------------------------------------
// Local date primitives

interface Ymd {
  y: number;
  m: number;
  d: number;
}

interface Hm {
  h: number;
  min: number;
}

const DAY_MS = 86_400_000;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y: number, m: number) => (m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1]);
const validYmd = (y: number, m: number, d: number) =>
  Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
const validDate = (a: Ymd) => validYmd(a.y, a.m, a.d);

/** A local Date without the two-digit-year quirk of `new Date(y, …)`. */
function localDate(y: number, m: number, d: number, h = 0, min = 0): Date {
  const dt = new Date(2000, 0, 1);
  dt.setFullYear(y, m - 1, d);
  dt.setHours(h, min, 0, 0);
  return dt;
}

const ymdOf = (dt: Date): Ymd => ({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() });
const cmpYmd = (a: Ymd, b: Ymd) => a.y - b.y || a.m - b.m || a.d - b.d;
// Calendar arithmetic in UTC so DST changes never add or lose a day.
const dayNum = (a: Ymd) => Math.round(Date.UTC(a.y, a.m - 1, a.d) / DAY_MS);
const weekdayOf = (a: Ymd) => new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
function addDays(a: Ymd, n: number): Ymd {
  const dt = new Date(Date.UTC(a.y, a.m - 1, a.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
const isoDate = (a: Ymd) => `${pad(a.y, 4)}-${pad(a.m)}-${pad(a.d)}`;
const isoDateTime = (a: Ymd, t: Hm) => `${isoDate(a)}T${pad(t.h)}:${pad(t.min)}`;
const minutesOf = (t: Hm) => t.h * 60 + t.min;

interface ParsedIso {
  date: Ymd;
  time?: Hm;
}

const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

function parseIso(s: unknown): ParsedIso | undefined {
  if (typeof s !== 'string') return undefined;
  const m = WHEN_RE.exec(s);
  if (!m) return undefined;
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (!validDate(date)) return undefined;
  if (m[4] === undefined) return { date };
  const time = { h: Number(m[4]), min: Number(m[5]) };
  if (time.h > 23 || time.min > 59) return undefined;
  return { date, time };
}

// ---------------------------------------------------------------------------
// Public helpers

/** Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" as local time. Invalid input gives an Invalid Date. */
export function parseLocal(iso: string): Date {
  const p = parseIso(iso);
  if (!p) return new Date(NaN);
  return localDate(p.date.y, p.date.m, p.date.d, p.time?.h ?? 0, p.time?.min ?? 0);
}

/** True for a date without a time ("2026-10-12"). */
export function isAllDay(iso: string): boolean {
  return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso);
}

/** Strict check: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" that is a real calendar date and time. */
export function isValidWhenString(s: unknown): s is string {
  return parseIso(s) !== undefined;
}

/** A local Date as a floating ISO string: "2026-10-12", or "2026-10-12T19:30" with `withTime`. */
export function toLocalIso(date: Date, withTime = false): string {
  const ymd = ymdOf(date);
  return withTime ? isoDateTime(ymd, { h: date.getHours(), min: date.getMinutes() }) : isoDate(ymd);
}

/** Moves a floating ISO string by whole days, keeping its time (if any). Invalid input is returned as is. */
export function addDaysIso(iso: string, days: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const d = addDays(p.date, days);
  return p.time ? isoDateTime(d, p.time) : isoDate(d);
}

/** Moves a floating ISO string by minutes; the result always has a time. Invalid input is returned as is. */
export function addMinutesIso(iso: string, minutes: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const t = p.time ?? { h: 0, min: 0 };
  const dt = new Date(Date.UTC(p.date.y, p.date.m - 1, p.date.d, t.h, t.min) + minutes * 60_000);
  return isoDateTime(
    { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() },
    { h: dt.getUTCHours(), min: dt.getUTCMinutes() },
  );
}

function thisWeekend(today: Ymd): [Ymd, Ymd | undefined] {
  const wd = weekdayOf(today);
  if (wd === 0) return [today, undefined]; // Sunday: what's left of it is today
  const sat = addDays(today, 6 - wd);
  return [sat, addDays(sat, 1)];
}

function nextWeekend(today: Ymd): [Ymd, Ymd] {
  const wd = weekdayOf(today);
  const sat = wd === 0 ? addDays(today, 6) : addDays(today, 6 - wd + 7);
  return [sat, addDays(sat, 1)];
}

/** The coming weekend: Sat–Sun (from Mon–Sat), or just today on a Sunday. */
export function weekendRange(now: Date = new Date()): When {
  const [start, end] = thisWeekend(ymdOf(now));
  return end ? { start: isoDate(start), end: isoDate(end) } : { start: isoDate(start) };
}

/** Monday to Sunday of next calendar week. */
export function nextWeekRange(now: Date = new Date()): When {
  const today = ymdOf(now);
  const monday = addDays(today, 7 - ((weekdayOf(today) + 6) % 7));
  return { start: isoDate(monday), end: isoDate(addDays(monday, 6)) };
}

/**
 * Validates and tidies a When (e.g. from an import or a share): drops it if the start is
 * invalid, drops an invalid or redundant end, swaps start/end if they are the wrong way
 * round and trims the source phrase.
 */
export function normalizeWhen(w: unknown): When | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const raw = w as Record<string, unknown>;
  const s = parseIso(raw.start);
  if (!s) return undefined;
  let start = raw.start as string;
  let end = parseIso(raw.end) ? (raw.end as string) : undefined;
  if (end) {
    const e = parseIso(end)!;
    const byDate = cmpYmd(e.date, s.date);
    if (byDate === 0 && (!e.time || !s.time)) {
      // Same day and one side has no time: the end adds nothing.
      end = undefined;
    } else if (byDate < 0 || (byDate === 0 && minutesOf(e.time!) < minutesOf(s.time!))) {
      [start, end] = [end, start];
    }
    if (end === start) end = undefined;
  }
  const source = typeof raw.source === 'string' ? raw.source.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return { start, ...(end ? { end } : {}), ...(source ? { source } : {}) };
}

/** [start, end] instants in ms. All-day ends run to 23:59:59.999; a timed event with no end lasts 3 hours. */
function bounds(w: When): [number, number] | undefined {
  const s = parseIso(w?.start);
  if (!s) return undefined;
  const startMs = localDate(s.date.y, s.date.m, s.date.d, s.time?.h ?? 0, s.time?.min ?? 0).getTime();
  const e = w.end ? parseIso(w.end) : undefined;
  let endMs: number;
  if (e?.time) endMs = localDate(e.date.y, e.date.m, e.date.d, e.time.h, e.time.min).getTime();
  else if (e) endMs = localDate(e.date.y, e.date.m, e.date.d + 1).getTime() - 1;
  else if (s.time) endMs = startMs + 3 * 3_600_000;
  else endMs = localDate(s.date.y, s.date.m, s.date.d + 1).getTime() - 1;
  return [startMs, Math.max(startMs, endMs)];
}

export type WhenStatus = 'upcoming' | 'ongoing' | 'past';

/** Whether the event is still to come, happening now, or over. Invalid values count as past. */
export function whenStatus(w: When, now: Date = new Date()): WhenStatus {
  const b = bounds(w);
  if (!b) return 'past';
  const t = now.getTime();
  return t < b[0] ? 'upcoming' : t <= b[1] ? 'ongoing' : 'past';
}

/** Calendar days from today to the start date (0 = today, negative = started earlier). NaN if invalid. */
export function daysUntil(w: When, now: Date = new Date()): number {
  const s = parseIso(w?.start);
  return s ? dayNum(s.date) - dayNum(ymdOf(now)) : NaN;
}

/** Sort comparator: earliest start first, then earliest end; items without a When go last. */
export function compareWhen(a: When | undefined, b: When | undefined): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return cmp(a.start, b.start) || cmp(a.end ?? a.start, b.end ?? b.start);
}

// ---------------------------------------------------------------------------
// Form fields (native date / time inputs)

/** A When split into the values of native date and time inputs, as edited in WhenEditor. */
export interface WhenFields {
  /** "YYYY-MM-DD", or '' when empty. */
  startDate: string;
  endDate: string;
  /** Whether the time inputs are shown and used. */
  timed: boolean;
  /** "HH:mm", or '' when empty. */
  startTime: string;
  endTime: string;
}

export type WhenFieldsResult = { when: When; error?: undefined } | { when?: undefined; error: string };

/** Splits a When into form fields. Round-trips through whenFromFields without losing anything. */
export function whenToFields(value: When | undefined): WhenFields {
  const w = normalizeWhen(value);
  if (!w) return { startDate: '', endDate: '', timed: false, startTime: '', endTime: '' };
  const startDate = w.start.slice(0, 10);
  const startTime = w.start.slice(11, 16);
  const endDate = w.end?.slice(0, 10) ?? '';
  const endTime = w.end?.slice(11, 16) ?? '';
  // An end time later that day, or early the next morning, needs no separate end date.
  const sameEvening = !!startTime && !!endTime && (endDate === startDate || (endDate === addDaysIso(startDate, 1) && endTime < startTime));
  // Either side having a time shows the time inputs, so an all-day start with a timed end keeps its time.
  return { startDate, endDate: sameEvening ? '' : endDate, timed: !!startTime || !!endTime, startTime, endTime };
}

/** Builds a When from form fields, or says what's wrong with them (friendly UI copy). */
export function whenFromFields(f: WhenFields): WhenFieldsResult {
  if (!f.startDate) return { error: 'Pick a start date.' };
  const startTime = f.timed ? f.startTime : '';
  const endTime = f.timed ? f.endTime : '';
  // Without a start time, an end time only means something on a later end date.
  if (f.timed && !startTime && !(endTime && f.endDate > f.startDate)) return { error: 'Add a start time, or switch the time off.' };
  const start = startTime ? `${f.startDate}T${startTime}` : f.startDate;
  let end: string | undefined;
  if (f.endDate) {
    if (f.endDate < f.startDate) return { error: 'The end date is before the start.' };
    if (endTime) {
      if (f.endDate === f.startDate && endTime <= startTime) return { error: 'It ends before it starts.' };
      end = `${f.endDate}T${endTime}`;
    } else {
      end = f.endDate;
    }
  } else if (startTime && endTime && endTime !== startTime) {
    // No end date: an end time earlier than the start runs past midnight.
    end = `${endTime < startTime ? addDaysIso(f.startDate, 1) : f.startDate}T${endTime}`;
  }
  const when = normalizeWhen({ start, end });
  return when ? { when } : { error: 'That date doesn’t look right.' };
}

// ---------------------------------------------------------------------------
// Formatting

const formatters = new Map<string, Intl.DateTimeFormat>();

function dtf(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(opts)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, opts);
    } catch {
      f = new Intl.DateTimeFormat(undefined, opts); // malformed locale tag
    }
    formatters.set(key, f);
  }
  return f;
}

// Intl uses narrow / thin no-break spaces around times and ranges; plain spaces keep output predictable.
const tidy = (s: string) => s.replace(/[\u00a0\u2009\u202f]/g, ' ');

interface DateBits {
  weekday: string;
  day: string;
  month: string;
  year: string;
  monthFirst: boolean;
  /** Month is a word ("Oct"). False for locales like ja-JP, which get Intl's own layout instead. */
  wordy: boolean;
}

function dateBits(a: Ymd, locale?: string): DateBits {
  const parts = dtf(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).formatToParts(localDate(a.y, a.m, a.d, 12));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month');
  return {
    weekday: get('weekday'),
    day: get('day'),
    month,
    year: get('year'),
    monthFirst: parts.findIndex((p) => p.type === 'month') < parts.findIndex((p) => p.type === 'day'),
    wordy: /\p{L}/u.test(month),
  };
}

const dayMonth = (b: DateBits) => (b.monthFirst ? `${b.month} ${b.day}` : `${b.day} ${b.month}`);
const yearSuffix = (b: DateBits) => (b.monthFirst ? `, ${b.year}` : ` ${b.year}`);

/** The year is shown only when it isn't the current one. */
const showYear = (a: Ymd, today: Ymd) => a.y !== today.y;

function dateText(a: Ymd, withWeekday: boolean, withYear: boolean, locale?: string): string {
  const b = dateBits(a, locale);
  if (!b.wordy) {
    return tidy(
      dtf(locale, { weekday: withWeekday ? 'short' : undefined, day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined }).format(
        localDate(a.y, a.m, a.d, 12),
      ),
    );
  }
  return `${withWeekday ? `${b.weekday} ` : ''}${dayMonth(b)}${withYear ? yearSuffix(b) : ''}`;
}

function relativeDay(a: Ymd, today: Ymd): string | undefined {
  const diff = dayNum(a) - dayNum(today);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : undefined;
}

function rangeText(a: Ymd, b: Ymd, today: Ymd, locale?: string): string {
  const withYear = showYear(a, today) || showYear(b, today);
  const A = dateBits(a, locale);
  const B = dateBits(b, locale);
  if (!A.wordy) {
    const f = dtf(locale, { day: 'numeric', month: 'short', year: withYear ? 'numeric' : undefined });
    const da = localDate(a.y, a.m, a.d, 12);
    const db = localDate(b.y, b.m, b.d, 12);
    return tidy(typeof f.formatRange === 'function' ? f.formatRange(da, db) : `${f.format(da)} – ${f.format(db)}`);
  }
  const yr = withYear ? yearSuffix(B) : '';
  if (a.y === b.y && a.m === b.m) return A.monthFirst ? `${A.month} ${A.day}–${B.day}${yr}` : `${A.day}–${B.day} ${A.month}${yr}`;
  // "28 Dec – 3 Jan 2027" when it starts this year; "28 Dec 2025 – 3 Jan 2026" otherwise.
  const startYear = a.y !== b.y && showYear(a, today) ? yearSuffix(A) : '';
  return `${dayMonth(A)}${startYear} – ${dayMonth(B)}${yr}`;
}

function is12Hour(locale?: string): boolean {
  const o = dtf(locale, { hour: 'numeric' }).resolvedOptions();
  return o.hourCycle ? o.hourCycle === 'h11' || o.hourCycle === 'h12' : !!o.hour12;
}

function timeText(t: Hm, locale?: string): string {
  // "7 pm" reads better than "7:00 pm", but 24-hour clocks always show minutes ("19:00").
  const opts: Intl.DateTimeFormatOptions = is12Hour(locale) && t.min === 0 ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' };
  return tidy(dtf(locale, opts).format(localDate(2000, 1, 1, t.h, t.min)));
}

/**
 * Short human text for a When, e.g. "Sat 12 Oct · 7:30 pm", "12–14 Jul", "12 Jul – 3 Aug 2027",
 * "Until 5 Jan", "Today · 7 pm", "Tomorrow". Years only appear for dates outside the current
 * year. Pass a BCP 47 locale for a fixed format
 * (e.g. "en-GB", or "en-GB-u-hc-h12" for 12-hour times); defaults to the user's.
 */
export function formatWhen(w: When, now: Date = new Date(), locale?: string): string {
  const s = parseIso(w?.start);
  if (!s) return typeof w?.source === 'string' ? w.source.trim() : '';
  const today = ymdOf(now);
  const e = w.end ? parseIso(w.end) : undefined;
  const label = (a: Ymd) => relativeDay(a, today) ?? dateText(a, true, showYear(a, today), locale);
  const sameDay = (a: Ymd, b: Ymd) => cmpYmd(a, b) === 0;

  if (s.time) {
    const startLabel = `${label(s.date)} · ${timeText(s.time, locale)}`;
    if (!e || (!e.time && sameDay(e.date, s.date))) return startLabel;
    if (e.time) {
      // Same evening, or an overnight one ("7 pm – 2 am").
      const overnight = dayNum(e.date) - dayNum(s.date) === 1 && minutesOf(e.time) < minutesOf(s.time);
      if (sameDay(e.date, s.date) || overnight) return `${startLabel} – ${timeText(e.time, locale)}`;
      return `${label(s.date)} ${timeText(s.time, locale)} – ${label(e.date)} ${timeText(e.time, locale)}`;
    }
    return `${label(s.date)} ${timeText(s.time, locale)} – ${label(e.date)}`;
  }

  if (!e || sameDay(e.date, s.date)) return label(s.date);
  const last = e.date;
  if (cmpYmd(last, s.date) < 0) return label(s.date);
  if (cmpYmd(s.date, today) <= 0 && cmpYmd(today, last) <= 0) {
    // On now: what matters is when it ends.
    const left = dayNum(last) - dayNum(today);
    if (left === 0) return 'Ends today';
    if (left === 1) return 'Until tomorrow';
    return `Until ${dateText(last, false, showYear(last, today), locale)}`;
  }
  if (s.date.d === 1 && s.date.y === last.y && s.date.m === last.m && last.d === daysInMonth(last.y, last.m)) {
    // A whole month: "November", "May 2027".
    return tidy(dtf(locale, { month: 'long', year: showYear(s.date, today) ? 'numeric' : undefined }).format(localDate(s.date.y, s.date.m, 15, 12)));
  }
  return rangeText(s.date, last, today, locale);
}

/** "in 3 days", "tomorrow", "today", "on now" or "ended". Empty for an invalid When. */
export function relativeWhen(w: When, now: Date = new Date()): string {
  if (!parseIso(w?.start)) return '';
  const status = whenStatus(w, now);
  if (status === 'ongoing') return 'on now';
  if (status === 'past') return 'ended';
  const days = daysUntil(w, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  if (days < 365) {
    const months = Math.round(days / 30.44);
    return months <= 1 ? 'in a month' : `in ${months} months`;
  }
  const years = Math.round(days / 365.25);
  return years <= 1 ? 'in a year' : `in ${years} years`;
}

export interface WhenBadgeView {
  /** on: happening now; soon: within a week; later; past. */
  tone: 'on' | 'soon' | 'later' | 'past';
  text: string;
  /** Tooltip: the full label, plus how far away it is. */
  title: string;
  /** Read out after the text ("tomorrow"); empty when the text already says it. */
  spoken: string;
}

/** What a date pill shows at `now`: "On now", "Today", "Tomorrow · 7 pm", "On now · until 5 Jan"… Undefined for an invalid When. */
export function whenBadge(when: When, now: Date = new Date()): WhenBadgeView | undefined {
  const w = normalizeWhen(when);
  if (!w) return undefined;
  const status = whenStatus(w, now);
  const label = formatWhen(w, now);
  const tone = status === 'ongoing' ? 'on' : status === 'past' ? 'past' : daysUntil(w, now) <= 7 ? 'soon' : 'later';

  let text = label;
  if (status === 'ongoing') {
    const multiDay = isAllDay(w.start) && !!w.end && w.end.slice(0, 10) !== w.start;
    // Ranges say when they end ("On now · until 5 Jan"); a timed event is simply on now; an all-day date is today.
    if (multiDay) text = `On now · ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
    else text = isAllDay(w.start) ? 'Today' : 'On now';
  }
  const relative = relativeWhen(w, now);
  return { tone, text, title: relative ? `${label} (${relative})` : label, spoken: relative && status !== 'ongoing' ? relative : '' };
}

// ---------------------------------------------------------------------------
// Extraction

const MON_NAMES = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const WD_NAMES = String.raw`mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?`;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const WD = String.raw`(?<![\p{L}\p{N}'])(?<wd>${WD_NAMES})(?!\p{L})\.?`;
const MON = String.raw`(?<![\p{L}\p{N}'])(?<mon>${MON_NAMES})(?!\p{L})\.?`;
// A day of the month that isn't part of a bigger number, a price, a time ("7pm", "7:30") or "5k".
const DAY = String.raw`(?<![\p{L}\p{N}.,:\/£$€#+'])(?<day>0?[1-9]|[12]\d|3[01])(?<ord>st|nd|rd|th)?(?![\p{L}\p{N}]|[:.,]\p{N}|[ \t]?[ap]\.?m(?!\p{L})|[ \t]?%)`;
const YEAR = String.raw`(?<year>(?:19|20|21)\d{2}|'\d{2})(?![\p{L}\p{N}]|[:.]\p{N})`;
const YEAR_SEP = String.raw`(?:,[ \t]*|[ \t]+|-(?=\d))`;
const THE = String.raw`(?:(?<!\p{L})the[ \t]+)?`;
const RANGE_WORDS = String.raw`-{1,2}|~|to|until|till|til|thru|through`;

const DM_RE = new RegExp(String.raw`(?:${WD}[\s,]+)?${THE}${DAY}(?:[ \t]+of[ \t]+|-|[ \t]+)${MON}(?:${YEAR_SEP}${YEAR})?`, 'giu');
const MD_RE = new RegExp(String.raw`(?:${WD}[\s,]+)?${MON}[ \t]+${THE}${DAY}(?:${YEAR_SEP}${YEAR})?`, 'giu');
const ISO_TEXT_RE =
  /(?<![\p{L}\p{N}/.:-])((?:19|20|21)\d{2})([-/.])(\d{1,2})\2(\d{1,2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?(?![\p{L}\p{N}]|[/.:]\p{N})/giu;
const NUM_RE = /(?<![\p{L}\p{N}.,:/£$€#+-])(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?![\p{L}\p{N}]|[/.:]\p{N}|[ \t]?%)/gu;
// "Wed 14/10": without a year, a numeric date only counts after a weekday.
const WD_NUM_RE = new RegExp(String.raw`${WD}[ \t,]+(?<a>\d{1,2})\/(?<b>\d{1,2})(?![\p{L}\p{N}]|[\/.:-]\p{N}|[ \t]?%)`, 'giu');
const MONTH_YEAR_RE = new RegExp(String.raw`${MON}(?:,[ \t]*|[ \t]+)(?<year>(?:19|20|21)\d{2})(?![\p{L}\p{N}]|[:.]\p{N})`, 'giu');
const RELATIVE_RE =
  /(?<![\p{L}\p{N}])(?:(?<rel>today|tonight|tonite|tomorrow|tmrw)(?:[ \t]+(?<pod>night|evening|morning|afternoon|lunchtime))?|(?<wq>this[ \t]+coming|this|next|coming)[ \t]+weekend)(?!\p{L})/giu;
const WEEKDAY_RE = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}])(?<q>this[ \t]+coming|this|next|coming|on|every)[ \t]+)?${WD}(?:[ \t]+(?<pod>night|evening|morning|afternoon|lunchtime))?`,
  'giu',
);

const RANGE_GAP = new RegExp(String.raw`^[ \t]*(?<sep>${RANGE_WORDS}|&|and|\/)[ \t]*$`, 'iu');
const PREFIX_DAY_RE = new RegExp(String.raw`(?:${WD}[\s,]+)?${THE}${DAY}[ \t]*(?<sep>${RANGE_WORDS}|&|and)[ \t]*${THE}$`, 'iu');
const SUFFIX_DAY_RE = new RegExp(String.raw`^[ \t]*(?<sep>${RANGE_WORDS}|&|and)[ \t]*(?:${WD}[\s,]+)?${THE}${DAY}(?:${YEAR_SEP}${YEAR})?`, 'iu');
const UNTIL_PREFIX =
  /(?<![\p{L}\p{N}])(?:(?:on[ \t]+now|now[ \t]+on|on|runs?|running|open|showing|available|playing|lasts?)[ \t]+)?(?:until|till|til|'til|through|thru|ends?|ending|closes?|closing|last[ \t]+day(?:[ \t]+is)?)[ \t]*[:,]?[ \t]*(?:on[ \t]+)?$/iu;
const FROM_PREFIX = /(?<![\p{L}\p{N}])(?:from|starting|starts|begins?|beginning|opens|opening|launch(?:es|ing)?)[ \t]*[:,]?[ \t]*(?:on[ \t]+|from[ \t]+)?$/iu;
const RANGE_FROM_PREFIX = /(?<![\p{L}\p{N}])(?:from|runs|running|open)[ \t]+$/iu;
const POSTED_PREFIX = /(?<!\p{L})(?:posted|updated|published|uploaded|edited|on[ \t]+sale|presale|pre-sale|booking[ \t]+opens?)[^\n\d.!?]{0,14}$/iu;
const CLOSED_PREFIX = /(?<!\p{L})closed[ \t]+(?:on[ \t]+)?$/iu;
const WD_LIST_AFTER = new RegExp(String.raw`^[ \t]*(?:${RANGE_WORDS}|&|and|,|\/)[ \t]*(?:${WD_NAMES})(?!\p{L})`, 'iu');
const WD_LIST_BEFORE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${WD_NAMES})\.?[ \t]*(?:${RANGE_WORDS}|&|and|,|\/)[ \t]*$`, 'iu');
const BARE_AT_RE = /^[ \t]+(?:at|from|@)[ \t]*(\d{1,2})(?::([0-5]\d))?(?![\p{N}:.]|[ \t]?[ap]\.?m(?!\p{L}))/iu;

// Times: "7pm", "7:30 p.m.", "19:30", "noon".
const TIME_TOKEN = String.raw`(?:(\d{1,2})(?:[:.]([0-5]\d))?[ \t]?([ap])\.?m\.?(?!\p{L})|([01]?\d|2[0-3]):([0-5]\d)(?!\p{N}|[:.]\p{N})|(noon|midday)(?!\p{L}))`;
const TIME_RE = new RegExp(String.raw`(?<![\p{L}\p{N}.,:\/£$€#+])${TIME_TOKEN}`, 'giu');
const TIME_STICKY = new RegExp(TIME_TOKEN, 'iuy');
// "Dec 31 10pm – Jan 1 2am": a start time between the two dates of a range, and the end time after it.
const TIMED_GAP_RE = new RegExp(String.raw`^[ \t]*,?[ \t]*(?:(?:at|from|@)[ \t]*)?${TIME_TOKEN}[ \t]*(?<sep>-{1,2}|~|to|until|till|til|thru|through)[ \t]*$`, 'iu');
const TIME_AFTER_RE = new RegExp(String.raw`^[ \t]*,?[ \t]*(?:(?:at|@)[ \t]*)?${TIME_TOKEN}`, 'iu');
const TIME_RANGE_SEP = /^[ \t]*(?:-{1,2}|~|to|till|til|until|'til)[ \t]*/iu;
const TIME_OPEN_END = /^(?:late|close|midnight|finish)(?!\p{L})/iu;
const BARE_START_RE = /(?<![\p{L}\p{N}.,:/£$€#+])(\d{1,2})(?::([0-5]\d))?[ \t]*(?:-{1,2}|~|to|till|until)[ \t]*$/iu;
const TIME_KEYWORD_BEFORE =
  /(?<!\p{L})(?:doors|gates|starts?|starting|start[ \t]+time|kick[- ]?off|showtime|show[ \t]+starts?)(?:[ \t]+open)?[^\p{L}\p{N}]{0,4}(?:(?:at|from)[^\p{L}\p{N}]{0,3})?$/iu;
const TIME_GAP_AFTER =
  /^[^\p{L}\p{N}]*(?:(?:at|from|doors|gates|starts?|starting|start[ \t]+time|kick[- ]?off|showtime|show|time|opens?|live)(?:[ \t]+open)?(?:[^\p{L}\p{N}]+(?:at|from))?[^\p{L}\p{N}]*)?$/iu;
const TIME_GAP_BEFORE = /^[^\p{L}\p{N}]*(?:on|this)?[^\p{L}\p{N}]*$/iu;

const MAX_TEXT = 20_000;

/**
 * The date and time regexes, so warmup.ts can compile them ahead of time (a regex compiles on its first runs,
 * which takes a while for the big Unicode ones on a phone).
 */
export function warmRegExps(): RegExp[] {
  return [
    DM_RE, MD_RE, ISO_TEXT_RE, NUM_RE, WD_NUM_RE, MONTH_YEAR_RE, RELATIVE_RE, WEEKDAY_RE, TIME_RE, TIME_STICKY,
    RANGE_GAP, PREFIX_DAY_RE, SUFFIX_DAY_RE, UNTIL_PREFIX, FROM_PREFIX, RANGE_FROM_PREFIX, POSTED_PREFIX, CLOSED_PREFIX,
    WD_LIST_AFTER, WD_LIST_BEFORE, BARE_AT_RE, TIMED_GAP_RE, TIME_AFTER_RE, TIME_RANGE_SEP, TIME_OPEN_END, BARE_START_RE,
    TIME_KEYWORD_BEFORE, TIME_GAP_AFTER, TIME_GAP_BEFORE, WHEN_RE,
  ];
}

interface Span {
  index: number;
  end: number;
}

interface RawDate extends Span {
  m: number;
  d: number;
  y?: number;
  time?: Hm;
  named: boolean;
  monthFirst: boolean;
  /** The weekday written with the date (0 = Sunday), e.g. the "Sat" in "Sat 12 Oct". */
  wd?: number;
  iso: boolean;
}

interface Cand extends Span {
  start: Ymd;
  endDate?: Ymd;
  startTime?: Hm;
  endTime?: Hm;
  allowTime: boolean;
  /** A bare weekday ("Friday") only counts with a time next to it. */
  needsTime?: boolean;
  /** Resolved to the next occurrence of a weekday, so a time already gone today means next week. */
  rollsWeekly?: boolean;
  /** The weekday written with it doesn't match the date ("Sat 12 Oct" in a year where that's a Monday). */
  doubtful?: boolean;
  score: number;
}

interface TimeHit extends Span {
  start: Hm;
  finish?: Hm;
  keyword: boolean;
}

interface PartialDate {
  m: number;
  d: number;
  y?: number;
}

const overlaps = (a: Span, b: Span) => a.index < b.end && b.index < a.end;
const overlapsAny = (a: Span, list: Span[]) => list.some((b) => overlaps(a, b));
const monthIndex = (word: string) => MONTH_KEYS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
const weekdayIndex = (word: string | undefined) => (word ? WEEKDAY_KEYS.indexOf(word.slice(0, 3).toLowerCase()) : -1);
/** True when a weekday was written next to a date and the date falls on a different day. */
const clash = (wd: number | undefined, date: Ymd) => wd !== undefined && wd >= 0 && weekdayOf(date) !== wd;

function parseYear(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  return raw.startsWith("'") ? 2000 + Number(raw.slice(1)) : Number(raw);
}

/** Text just before `index`. Short windows keep prefix checks cheap; every prefix pattern is well under 80 chars. */
function windowBefore(t: string, index: number, size = 80): { text: string; offset: number } {
  const offset = Math.max(0, index - size);
  return { text: t.slice(offset, index), offset };
}

/**
 * Same-length clean-up so match positions still line up with the original text:
 * dashes → "-", curly apostrophes → "'", odd spaces → " ", and links blanked out.
 */
function normalizeText(s: string): string {
  return s
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, (m) => ' '.repeat(m.length))
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-')
    .replace(/[\u2018\u2019\u201b\u02bc\uff07]/g, "'")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000\ufeff]/g, ' ')
    .replace(/\uff1a/g, ':');
}

function cleanSource(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:·•|~-]+/u, '')
    .replace(/[\s,;:·•|~!?-]+$/u, '')
    .replace(/(?<![ap]\.m)\.$/i, '')
    .trim();
}

function inferSingle(m: number, d: number, today: Ymd): Ymd | undefined {
  for (let y = today.y; y <= today.y + 8; y++) {
    if (validYmd(y, m, d) && cmpYmd({ y, m, d }, today) >= 0) return { y, m, d };
  }
  return undefined;
}

/** Fills in missing years: the next occurrence that hasn't ended yet, rolling the end into the next year if needed. */
function inferRange(a: PartialDate, b: PartialDate, today: Ymd): [Ymd, Ymd] | undefined {
  const endBeforeStart = b.m < a.m || (b.m === a.m && b.d < a.d);
  let s: Ymd;
  let e: Ymd;
  if (a.y !== undefined && b.y !== undefined) {
    s = { y: a.y, m: a.m, d: a.d };
    e = { y: b.y, m: b.m, d: b.d };
  } else if (a.y !== undefined) {
    s = { y: a.y, m: a.m, d: a.d };
    e = { y: endBeforeStart ? a.y + 1 : a.y, m: b.m, d: b.d };
  } else if (b.y !== undefined) {
    e = { y: b.y, m: b.m, d: b.d };
    s = { y: endBeforeStart ? b.y - 1 : b.y, m: a.m, d: a.d };
  } else {
    for (let y = today.y - 1; y <= today.y + 8; y++) {
      const s1 = { y, m: a.m, d: a.d };
      const e1 = { y: endBeforeStart ? y + 1 : y, m: b.m, d: b.d };
      if (validDate(s1) && validDate(e1) && cmpYmd(e1, today) >= 0) return [s1, e1];
    }
    return undefined;
  }
  if (!validDate(s) || !validDate(e)) return undefined;
  return cmpYmd(e, s) < 0 ? [e, s] : [s, e];
}

/** "&" / "and" only joins consecutive days ("12 & 13 Oct"); "12 and 19 Oct" are two separate dates. */
function joinable(sep: string, r: [Ymd, Ymd]): boolean {
  const gap = dayNum(r[1]) - dayNum(r[0]);
  return /^(?:&|and)$/i.test(sep) ? gap === 1 : gap > 0;
}

function resolveWeekday(target: number, q: string | undefined, today: Ymd): Ymd {
  const cur = weekdayOf(today);
  if (q === 'next') {
    // The one in next calendar week (weeks start on Monday).
    const mondayIndex = (d: number) => (d + 6) % 7;
    return addDays(today, 7 - mondayIndex(cur) + mondayIndex(target));
  }
  return addDays(today, (target - cur + 7) % 7);
}

/** Dates written in the text, plus the spans of impossible ones ("30 Feb 2027") so nothing else reads them. */
function collectSingles(t: string): { dates: RawDate[]; rejected: Span[] } {
  const found: RawDate[] = [];
  const rejected: Span[] = [];
  for (const re of [DM_RE, MD_RE]) {
    for (const m of t.matchAll(re)) {
      const g = m.groups!;
      // Lower-case "may" / "march" are usually the verb ("you may 2x it"), unless the date is otherwise clear.
      if (/^(?:may|mar|march)$/.test(g.mon) && !g.ord && !g.year && !g.wd) continue;
      const month = monthIndex(g.mon);
      const d = Number(g.day);
      const y = parseYear(g.year);
      if (!month || d > daysInMonth(y ?? 2000, month)) {
        // Otherwise "30 Feb 2027" would come back as the whole of "Feb 2027".
        rejected.push({ index: m.index, end: m.index + m[0].length });
        continue;
      }
      found.push({ index: m.index, end: m.index + m[0].length, m: month, d, y, named: true, monthFirst: re === MD_RE, wd: g.wd ? weekdayIndex(g.wd) : undefined, iso: false });
    }
  }
  for (const m of t.matchAll(ISO_TEXT_RE)) {
    let y = Number(m[1]);
    let month = Number(m[3]);
    let d = Number(m[4]);
    let time: Hm | undefined;
    if (m[5] !== undefined) {
      if (m[2] !== '-') continue;
      time = { h: Number(m[5]), min: Number(m[6]) };
      if (time.h > 23 || time.min > 59 || !validYmd(y, month, d)) continue;
      if (m[7]) {
        // An instant (UTC or offset): show it in local time.
        const offset = m[7].toUpperCase() === 'Z' ? 'Z' : m[7].replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
        const dt = new Date(`${pad(y, 4)}-${pad(month)}-${pad(d)}T${pad(time.h)}:${pad(time.min)}:00${offset}`);
        if (Number.isNaN(dt.getTime())) continue;
        ({ y, m: month, d } = ymdOf(dt));
        time = { h: dt.getHours(), min: dt.getMinutes() };
      }
    }
    if (!validYmd(y, month, d)) continue;
    found.push({ index: m.index, end: m.index + m[0].length, m: month, d, y, time, named: false, monthFirst: false, iso: true });
  }
  for (const m of t.matchAll(NUM_RE)) {
    const [a, b, sep, yRaw] = [Number(m[1]), Number(m[3]), m[2], m[4]];
    if (sep !== '/' && yRaw.length !== 4) continue; // "1.2.34" is a version, not a date
    const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    if (y < 1900 || y > 2199) continue;
    // Day first, unless that's impossible ("10/13/2026").
    const [d, month] = a > 12 || b <= 12 ? [a, b] : [b, a];
    if (!validYmd(y, month, d)) continue;
    found.push({ index: m.index, end: m.index + m[0].length, m: month, d, y, named: false, monthFirst: false, iso: false });
  }
  for (const m of t.matchAll(WD_NUM_RE)) {
    const [a, b] = [Number(m.groups!.a), Number(m.groups!.b)];
    const [d, month] = a > 12 || b <= 12 ? [a, b] : [b, a];
    if (month < 1 || month > 12 || d < 1 || d > daysInMonth(2000, month)) continue;
    found.push({ index: m.index, end: m.index + m[0].length, m: month, d, named: false, monthFirst: false, wd: weekdayIndex(m.groups!.wd), iso: false });
  }
  found.sort((a, b) => a.index - b.index || b.end - a.end);
  const kept: RawDate[] = [];
  for (const r of found) if (!kept.length || r.index >= kept[kept.length - 1].end) kept.push(r);
  return { dates: kept, rejected };
}

function parseTime(m: RegExpMatchArray | RegExpExecArray): Hm | undefined {
  if (m[3]) {
    const h = Number(m[1]);
    if (h < 1 || h > 12) return undefined;
    return { h: (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0), min: m[2] ? Number(m[2]) : 0 };
  }
  if (m[4] !== undefined) return { h: Number(m[4]), min: Number(m[5]) };
  if (m[6]) return { h: 12, min: 0 };
  return undefined;
}

function findTimes(t: string, taken: Span[]): TimeHit[] {
  const hits: TimeHit[] = [];
  for (const m of t.matchAll(TIME_RE)) {
    let start = parseTime(m);
    if (!start) continue;
    let index = m.index;
    let end = index + m[0].length;
    let finish: Hm | undefined;

    // "7-11pm": a bare hour before a 12-hour time shares its am/pm.
    if (m[3]) {
      const w = windowBefore(t, index, 24);
      const b = BARE_START_RE.exec(w.text);
      const sh = b ? Number(b[1]) : 0;
      const bareIndex = b ? w.offset + b.index : 0;
      // …unless that number is the day of a date ("Oct 3 - 7pm").
      if (b && sh >= 1 && sh <= 12 && !overlapsAny({ index: bareIndex, end: bareIndex + b[1].length }, taken)) {
        let h = (sh % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
        const min = b[2] ? Number(b[2]) : 0;
        if (h * 60 + min > minutesOf(start) && h >= 12) h -= 12; // "11-2pm" starts in the morning
        finish = start;
        start = { h, min };
        index = bareIndex;
      }
    }

    // "7pm – 11pm", "19:00-23:00", "7pm till late"
    if (!finish) {
      const sep = TIME_RANGE_SEP.exec(t.slice(end, end + 12));
      if (sep) {
        const at = end + sep[0].length;
        TIME_STICKY.lastIndex = at;
        const n = TIME_STICKY.exec(t);
        const f = n ? parseTime(n) : undefined;
        if (n && f) {
          finish = f;
          end = at + n[0].length;
        } else {
          const open = TIME_OPEN_END.exec(t.slice(at, at + 10));
          if (open) end = at + open[0].length;
        }
      }
    }
    hits.push({ index, end, start, finish, keyword: TIME_KEYWORD_BEFORE.test(windowBefore(t, index).text) });
  }
  // The second half of "7pm-11pm" is also matched on its own; keep the combined hit.
  const kept: TimeHit[] = [];
  for (const h of hits) if (!kept.length || h.index >= kept[kept.length - 1].end) kept.push(h);
  return kept;
}

function attachTime(c: Cand, hits: TimeHit[], t: string): { hit: TimeHit; where: 'after' | 'before' | 'near' } | undefined {
  const next = hits.find((h) => h.index >= c.end);
  if (next && next.index - c.end <= 40 && TIME_GAP_AFTER.test(t.slice(c.end, next.index))) return { hit: next, where: 'after' };
  let prev: TimeHit | undefined;
  for (const h of hits) if (h.end <= c.index) prev = h;
  if (prev && c.index - prev.end <= 16 && TIME_GAP_BEFORE.test(t.slice(prev.end, c.index))) return { hit: prev, where: 'before' };
  // "Doors 7pm" further away in the post still belongs to the event.
  const kw = hits.find((h) => h.keyword);
  return kw ? { hit: kw, where: 'near' } : undefined;
}

export interface WhenMatch {
  when: When;
  /** Where the phrase starts in the text, and its length. */
  index: number;
  length: number;
  /**
   * 'high' for explicit dates ("12 Oct", "2026-10-12", "12–14 July", "until 5 Jan", "Friday 7pm");
   * 'low' for loose ones ("today", "this Saturday") and for dates whose written weekday doesn't
   * match ("Sat 12 Oct" in a year where that's a Monday), which are better offered than applied.
   */
  confidence: 'high' | 'low';
}

/** Like extractWhen, but also says where the phrase was found and how sure it is. */
export function findWhen(text: string, now: Date = new Date()): WhenMatch | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const original = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const t = normalizeText(original);
  const today = ymdOf(now);
  const cands: Cand[] = [];

  const { dates: singles, rejected } = collectSingles(t);
  const taken: Span[] = [...singles, ...rejected];
  const consumed = new Set<RawDate>();

  // "12 Oct – 3 Nov", "Oct 3 – Oct 20", "2026-10-12 to 2026-10-14", "Dec 31 10pm – Jan 1 2am"
  for (let i = 0; i + 1 < singles.length; i++) {
    const a = singles[i];
    const b = singles[i + 1];
    const gap = t.slice(a.end, b.index);
    const g = RANGE_GAP.exec(gap);
    const tg = g || a.time || gap.length > 40 ? null : TIMED_GAP_RE.exec(gap);
    const gapTime = tg ? parseTime(tg) : undefined;
    if (!g && !gapTime) continue;
    const sep = (g ?? tg)!.groups!.sep;
    if (sep === '/' && !(a.iso && b.iso)) continue;
    const r = inferRange(a, b, today);
    if (!r || !joinable(sep, r)) continue;
    // inferRange only swaps two explicit dates written the wrong way round.
    const inOrder = r[0].m === a.m && r[0].d === a.d && (a.y === undefined || r[0].y === a.y);
    const c: Cand = {
      index: a.index,
      end: b.end,
      start: r[0],
      endDate: r[1],
      allowTime: false,
      doubtful: clash(a.wd, inOrder ? r[0] : r[1]) || clash(b.wd, inOrder ? r[1] : r[0]),
      score: a.named || b.named ? 10 : 9,
    };
    const startTime = a.time ?? gapTime;
    if (inOrder && startTime) {
      // With no end time, it starts at a set time and runs until the end of the last day.
      c.startTime = startTime;
      c.endTime = b.time;
      if (!b.time) {
        const after = TIME_AFTER_RE.exec(t.slice(b.end, b.end + 24));
        const endTime = after ? parseTime(after) : undefined;
        if (after && endTime) {
          c.endTime = endTime;
          c.end = b.end + after[0].length;
        }
      }
    }
    cands.push(c);
    taken.push({ index: c.index, end: c.end });
    consumed.add(a).add(b);
    i++;
  }

  // "12–14 July" and "July 12–14"
  for (let i = 0; i < singles.length; i++) {
    const s = singles[i];
    if (consumed.has(s) || !s.named) continue;
    if (!s.monthFirst) {
      const w = windowBefore(t, s.index);
      const m = PREFIX_DAY_RE.exec(w.text);
      const prevEnd = i > 0 ? singles[i - 1].end : 0;
      if (!m || w.offset + m.index < prevEnd) continue;
      const d1 = Number(m.groups!.day);
      if (d1 === s.d) continue;
      // "30–2 Nov" starts in the month before.
      const from = d1 < s.d ? { m: s.m, d: d1 } : { m: s.m === 1 ? 12 : s.m - 1, d: d1 };
      const r = inferRange(from, { m: s.m, d: s.d, y: s.y }, today);
      if (!r || !joinable(m.groups!.sep, r)) continue;
      const span = { index: w.offset + m.index, end: s.end };
      const doubtful = clash(weekdayIndex(m.groups!.wd), r[0]) || clash(s.wd, r[1]);
      cands.push({ ...span, start: r[0], endDate: r[1], allowTime: false, doubtful, score: 10 });
      taken.push(span);
      consumed.add(s);
    } else {
      const m = SUFFIX_DAY_RE.exec(t.slice(s.end, s.end + 60));
      const next = singles[i + 1];
      if (!m || (next && s.end + m[0].length > next.index)) continue;
      const d2 = Number(m.groups!.day);
      if (d2 === s.d) continue;
      const y2 = parseYear(m.groups!.year);
      const to = d2 > s.d ? { m: s.m, d: d2 } : { m: s.m === 12 ? 1 : s.m + 1, d: d2 };
      const r = inferRange({ m: s.m, d: s.d, y: y2 === undefined ? s.y : undefined }, { ...to, y: y2 }, today);
      if (!r || !joinable(m.groups!.sep, r)) continue;
      const span = { index: s.index, end: s.end + m[0].length };
      const doubtful = clash(s.wd, r[0]) || clash(weekdayIndex(m.groups!.wd), r[1]);
      cands.push({ ...span, start: r[0], endDate: r[1], allowTime: false, doubtful, score: 10 });
      taken.push(span);
      consumed.add(s);
    }
  }

  // Ranges may be introduced by "from" / "runs": keep it in the source phrase.
  for (const c of cands) {
    const w = windowBefore(t, c.index, 16);
    const f = RANGE_FROM_PREFIX.exec(w.text);
    if (f) c.index = w.offset + f.index;
  }

  // Single dates, possibly "until 5 Jan" / "from 1 Nov".
  for (const s of singles) {
    if (consumed.has(s)) continue;
    const date = s.y !== undefined ? { y: s.y, m: s.m, d: s.d } : inferSingle(s.m, s.d, today);
    if (!date) continue;
    // Usually an old post ("Sat 12 Oct" was 2024), or a typo: offer it rather than trust it.
    const doubtful = clash(s.wd, date);
    const w = windowBefore(t, s.index);
    const until = UNTIL_PREFIX.exec(w.text);
    if (until) {
      const start = cmpYmd(date, today) < 0 ? date : today;
      cands.push({ index: w.offset + until.index, end: s.end, start, endDate: date, allowTime: false, doubtful, score: 9 });
      continue;
    }
    const from = FROM_PREFIX.exec(w.text);
    const wdBonus = s.wd !== undefined && !doubtful ? 0.5 : 0;
    const base = s.iso ? 8 : s.named ? 8 + wdBonus + (s.y !== undefined ? 0.5 : 0) : 6.5 + wdBonus;
    cands.push({
      index: from ? w.offset + from.index : s.index,
      end: s.end,
      start: date,
      startTime: s.time,
      allowTime: !s.time,
      doubtful,
      score: from ? base + 0.5 : base,
    });
  }

  // "Nov 2026" (the whole month), "October 2026 – March 2027"
  const months: (Span & { y: number; m: number })[] = [];
  for (const m of t.matchAll(MONTH_YEAR_RE)) {
    const span = { index: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, taken)) continue;
    months.push({ ...span, y: Number(m.groups!.year), m: monthIndex(m.groups!.mon) });
  }
  taken.push(...months);
  for (let i = 0; i < months.length; i++) {
    const a = months[i];
    const first = { y: a.y, m: a.m, d: 1 };
    const b = months[i + 1];
    const gap = b ? RANGE_GAP.exec(t.slice(a.end, b.index)) : null;
    if (b && gap && gap.groups!.sep !== '/' && !/^(?:&|and)$/i.test(gap.groups!.sep) && (b.y > a.y || (b.y === a.y && b.m > a.m))) {
      cands.push({ index: a.index, end: b.end, start: first, endDate: { y: b.y, m: b.m, d: daysInMonth(b.y, b.m) }, allowTime: false, score: 7 });
      i++;
      continue;
    }
    const last = { y: a.y, m: a.m, d: daysInMonth(a.y, a.m) };
    const w = windowBefore(t, a.index);
    const until = UNTIL_PREFIX.exec(w.text);
    const from = FROM_PREFIX.exec(w.text);
    if (until) cands.push({ index: w.offset + until.index, end: a.end, start: cmpYmd(last, today) < 0 ? first : today, endDate: last, allowTime: false, score: 7 });
    else if (from) cands.push({ index: w.offset + from.index, end: a.end, start: first, allowTime: false, score: 6.5 });
    else cands.push({ index: a.index, end: a.end, start: first, endDate: last, allowTime: false, score: 6 });
  }

  // "today", "tonight", "tomorrow night", "this weekend"
  for (const m of t.matchAll(RELATIVE_RE)) {
    const span = { index: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, taken)) continue;
    const g = m.groups!;
    if (g.wq) {
      const [start, end] = /^next/i.test(g.wq) ? nextWeekend(today) : thisWeekend(today);
      cands.push({ ...span, start, endDate: end, allowTime: false, score: 5 });
      continue;
    }
    const rel = g.rel.toLowerCase();
    const pod = g.pod?.toLowerCase();
    const tomorrow = rel === 'tomorrow' || rel === 'tmrw';
    const c: Cand = { ...span, start: tomorrow ? addDays(today, 1) : today, allowTime: true, score: rel === 'today' ? 3 : tomorrow ? 4.5 : 5 };
    // "tonight at 8" means 8 pm.
    if (rel.startsWith('toni') || pod === 'night' || pod === 'evening') {
      const b = BARE_AT_RE.exec(t.slice(c.end, c.end + 20));
      const h = b ? Number(b[1]) : 0;
      if (b && h >= 1 && h <= 11) {
        c.startTime = { h: h + 12, min: b[2] ? Number(b[2]) : 0 };
        c.end += b[0].length;
        c.allowTime = false;
        c.score += 1;
      }
    }
    taken.push({ index: c.index, end: c.end });
    cands.push(c);
  }

  // "this Saturday", "next Friday", "Friday 7pm", "until Sunday"
  for (const m of t.matchAll(WEEKDAY_RE)) {
    const span = { index: m.index, end: m.index + m[0].length };
    if (overlapsAny(span, taken)) continue;
    const g = m.groups!;
    const q = g.q?.toLowerCase().replace(/\s+/g, ' ');
    if (q === 'every') continue;
    // Lower-case "sat", "sun", "wed", "mon" are usually just words.
    if (!q && /^(?:sat|sun|wed|mon)$/.test(g.wd)) continue;
    const w = windowBefore(t, span.index);
    if (WD_LIST_BEFORE.test(w.text) || WD_LIST_AFTER.test(t.slice(span.end, span.end + 24)) || CLOSED_PREFIX.test(w.text)) continue;
    const date = resolveWeekday(weekdayIndex(g.wd), q, today);
    const until = UNTIL_PREFIX.exec(w.text);
    if (until) {
      cands.push({ index: w.offset + until.index, end: span.end, start: today, endDate: date, allowTime: false, score: 6.5 });
      continue;
    }
    cands.push({ ...span, start: date, allowTime: true, needsTime: !q && !g.pod, rollsWeekly: q !== 'next', score: q ? 5 : 4.5 });
  }

  if (!cands.length) return undefined;

  const hits = findTimes(t, taken).filter((h) => !overlapsAny(h, taken));
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const scored: Cand[] = [];
  for (const c of cands) {
    if (c.allowTime && !c.startTime) {
      const a = attachTime(c, hits, t);
      if (a) {
        c.startTime = a.hit.start;
        c.endTime = a.hit.finish;
        c.score += 1;
        if (a.where === 'after') c.end = a.hit.end;
        else if (a.where === 'before') c.index = a.hit.index;
      }
    }
    if (c.needsTime && !c.startTime) continue;
    if (c.rollsWeekly && c.startTime && dayNum(c.start) === dayNum(today) && minutesOf(c.startTime) < nowMinutes) c.start = addDays(c.start, 7);
    // "Posted 3 Sep", "on sale 1 Nov": a date, but not when the thing happens.
    if (POSTED_PREFIX.test(windowBefore(t, c.index).text)) continue;
    if (cmpYmd(c.endDate ?? c.start, today) < 0) c.score -= 4;
    if (c.doubtful) c.score -= 1;
    scored.push(c);
  }
  if (!scored.length) return undefined;

  // Best score; on a tie the one coming up soonest (a date that has already passed goes last), then the earliest mention.
  const soonness = (c: Cand) => {
    const toEnd = dayNum(c.endDate ?? c.start) - dayNum(today);
    return toEnd < 0 ? 1e6 - toEnd : Math.max(0, dayNum(c.start) - dayNum(today));
  };
  scored.sort((a, b) => b.score - a.score || soonness(a) - soonness(b) || a.index - b.index);
  const best = scored[0];

  const start = best.startTime ? isoDateTime(best.start, best.startTime) : isoDate(best.start);
  let end: string | undefined;
  if (best.endDate) end = best.endTime ? isoDateTime(best.endDate, best.endTime) : isoDate(best.endDate);
  else if (best.startTime && best.endTime && minutesOf(best.endTime) !== minutesOf(best.startTime)) {
    // "10pm – 2am" finishes the next day.
    end = isoDateTime(minutesOf(best.endTime) < minutesOf(best.startTime) ? addDays(best.start, 1) : best.start, best.endTime);
  }
  const when = normalizeWhen({ start, end, source: cleanSource(original.slice(best.index, best.end)) });
  if (!when) return undefined;
  return { when, index: best.index, length: best.end - best.index, confidence: best.score >= 5.5 && !best.doubtful ? 'high' : 'low' };
}

/**
 * The most likely event date or period in free text, e.g. "Sat 12 Oct 7:30pm", "12–14 July",
 * "runs until 5 Jan", "this weekend". Missing years resolve to the next occurrence on or after today.
 */
export function extractWhen(text: string, now: Date = new Date()): When | undefined {
  return findWhen(text, now)?.when;
}

/** extractWhen over several bits of text at once (title, note, shared text, page description…). */
export function whenFromTexts(parts: (string | null | undefined)[], now: Date = new Date()): When | undefined {
  return extractWhen(
    parts
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean)
      .join('\n'),
    now,
  );
}
