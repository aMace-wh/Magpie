import { safeUrl } from './classify';
import { payloadEmoji, payloadTitle, type SharedPayloadV2 } from './share';
import type { Place, When } from './types';

/**
 * Share intents for common apps (no SDKs, no tracking — just URLs), and the
 * friendly message that goes with a Magpie link.
 */

export type SocialTargetId = 'whatsapp' | 'telegram' | 'messenger' | 'facebook' | 'x' | 'email' | 'sms' | 'line' | 'reddit' | 'linkedin';

export interface SocialTarget {
  id: SocialTargetId;
  label: string;
  /** Brand colour for the button glyph. */
  color: string;
  /** Only works where the app is installed (custom URL scheme). */
  mobileOnly?: boolean;
  /** A private message to a friend, where a file can be sent when the share is too big for a link. */
  direct: boolean;
  /**
   * How much message text the target takes, not counting the link. 0 = it only takes a link.
   * Targets with 1000+ get the full message with a list of saves; see acceptsLongText().
   */
  maxText: number;
}

export const SOCIAL_TARGETS: SocialTarget[] = [
  { id: 'whatsapp', label: 'WhatsApp', color: '#25D366', direct: true, maxText: 4000 },
  { id: 'telegram', label: 'Telegram', color: '#229ED9', direct: true, maxText: 4096 },
  { id: 'messenger', label: 'Messenger', color: '#0A7CFF', direct: true, mobileOnly: true, maxText: 0 },
  { id: 'facebook', label: 'Facebook', color: '#1877F2', direct: false, maxText: 0 },
  { id: 'x', label: 'X', color: '#000000', direct: false, maxText: 280 },
  { id: 'email', label: 'Email', color: '#6B7280', direct: true, maxText: 8000 },
  { id: 'sms', label: 'SMS', color: '#34C759', direct: true, maxText: 160 },
  { id: 'line', label: 'LINE', color: '#06C755', direct: true, maxText: 4000 },
  { id: 'reddit', label: 'Reddit', color: '#FF4500', direct: false, maxText: 300 },
  { id: 'linkedin', label: 'LinkedIn', color: '#0A66C2', direct: false, maxText: 0 },
];

export function getTarget(id: SocialTargetId): SocialTarget {
  return SOCIAL_TARGETS.find((t) => t.id === id)!;
}

/** Can this target take a multi-line message with a list of saves? */
export function acceptsLongText(target: SocialTarget | SocialTargetId): boolean {
  return (typeof target === 'string' ? getTarget(target) : target).maxText >= 1000;
}

/** Does this target take any message text (as opposed to just a link)? */
export function acceptsText(target: SocialTarget | SocialTargetId): boolean {
  return (typeof target === 'string' ? getTarget(target) : target).maxText > 0;
}

// ---------------------------------------------------------------------------
// Text helpers

const enc = encodeURIComponent;

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

const length = (s: string) => Array.from(s).length;

/**
 * Length as X counts it: most Latin / European characters count 1, everything
 * else (CJK, emoji…) counts 2. Emoji sequences are over-counted, which is safe.
 */
export function xLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

/** Every link on X counts as 23 characters, plus the space before it. */
export const X_LIMIT = 280;
export const X_URL_LENGTH = 23;

function fitX(text: string, hasUrl: boolean): string {
  const budget = X_LIMIT - (hasUrl ? X_URL_LENGTH + 1 : 0);
  if (xLength(text) <= budget) return text;
  const room = budget - xLength('…'); // the ellipsis itself counts 2
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = xLength(ch);
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  return `${out.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Flags, places and dates (kept here so share text needs nothing else)

/** 🇵🇹 for "PT"; empty string for anything that isn't a two-letter code. */
export function flag(countryCode: string | undefined): string {
  const c = countryCode?.trim().toUpperCase();
  if (!c || !/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** "Dishoom, London, United Kingdom" — the most useful parts of a place, without repeats. */
export function placeLabel(p: Place | undefined): string | undefined {
  if (!p) return undefined;
  const parts: string[] = [];
  for (const part of [p.name, p.city, p.country]) {
    const v = part?.trim();
    if (v && !parts.some((x) => x.toLowerCase() === v.toLowerCase())) parts.push(v);
  }
  if (parts.length) return parts.join(', ');
  const addr = p.address?.trim();
  return addr ? truncate(addr, 80) : undefined;
}

const WHEN_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

function parseWhen(s: string | undefined): { date: Date; time: boolean } | undefined {
  const m = s ? WHEN_RE.exec(s) : null;
  if (!m) return undefined;
  const date = new Date(2000, 0, 1);
  date.setFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  date.setHours(m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : { date, time: m[4] !== undefined };
}

/** "Sat 12 Oct, 19:30", "12 Oct – 14 Oct 2027" … for floating local ISO dates. */
export function whenLabel(w: Pick<When, 'start' | 'end'> | undefined, locale?: string, now = new Date()): string | undefined {
  const start = parseWhen(w?.start);
  if (!start) return undefined;
  const end = parseWhen(w?.end);
  const year = (d: Date) => (d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined);
  const day = (d: Date) => d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: year(d) });
  const time = (d: Date) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  let out = start.time ? `${day(start.date)}, ${time(start.date)}` : day(start.date);
  if (end && end.date.getTime() > start.date.getTime()) {
    const sameDay = end.date.toDateString() === start.date.toDateString();
    if (sameDay) out += end.time ? ` – ${time(end.date)}` : '';
    else out += ` – ${end.time ? `${day(end.date)}, ${time(end.date)}` : day(end.date)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Messages

export interface MessageOptions {
  /** Maximum length of the whole message (including the link). The link itself is never cut. */
  maxLength?: number;
  /** Just the headline (and the link) — for SMS and other tight spots. */
  short?: boolean;
  /** How many save titles to list for collections / libraries. */
  listCount?: number;
  locale?: string;
  now?: Date;
}

function detailsLine(p: SharedPayloadV2, opts: MessageOptions): string | undefined {
  const s = p.items[0];
  if (!s) return undefined;
  const parts: string[] = [];
  const when = whenLabel(s.w, opts.locale, opts.now);
  if (when) parts.push(`📅 ${when}`);
  const place = placeLabel(s.p);
  if (place) parts.push(`${flag(s.p?.countryCode) || '📍'} ${place}`);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * The friendly text that goes with a share. Pass the Magpie link to end with
 * "Add it to your Magpie: <link>"; leave it out when the link travels separately.
 */
export function shareMessage(payload: SharedPayloadV2, magpieUrl?: string, opts: MessageOptions = {}): string {
  const single = payload.kind === 'item';
  const cta = magpieUrl ? `${single ? 'Add it to your Magpie' : 'Open in Magpie'}: ${magpieUrl}` : undefined;
  const n = payload.items.length;
  const emoji = payloadEmoji(payload);

  // Build from richest to leanest and return the first version that fits.
  const build = (titleMax: number, listCount: number, extras: boolean): string => {
    const lines: string[] = [];
    if (single) {
      lines.push(`${emoji} ${truncate(payloadTitle(payload), titleMax)}`);
      if (extras) {
        const original = safeUrl(payload.items[0]?.u);
        if (original) lines.push(original);
        const details = detailsLine(payload, opts);
        if (details) lines.push(details);
      }
    } else {
      lines.push(`${emoji} ${truncate(payloadTitle(payload), titleMax)} — ${n} ${n === 1 ? 'save' : 'saves'}`);
      const shown = payload.items.slice(0, listCount);
      for (const s of shown) lines.push(`• ${truncate(s.n, 60)}`);
      if (shown.length && n > shown.length) lines.push(`…and ${n - shown.length} more`);
    }
    const head = lines.join('\n');
    return cta ? `${head}\n\n${cta}` : head;
  };

  const max = opts.maxLength ?? Infinity;
  const list = opts.short ? 0 : (opts.listCount ?? 5);
  const extras = !opts.short;
  for (let count = list; count >= 0; count--) {
    const text = build(140, count, extras);
    if (length(text) <= max) return text;
  }
  for (const [titleMax, withExtras] of [
    [140, false],
    [60, false],
    [30, false],
  ] as const) {
    const text = build(titleMax, 0, withExtras);
    if (length(text) <= max) return text;
  }
  // Only the link fits (or not even that — the caller should send a file).
  if (cta && magpieUrl) {
    const headroom = max - length(magpieUrl) - 2;
    const head = truncate(`${emoji} ${payloadTitle(payload)}`, headroom);
    return head ? `${head}\n${magpieUrl}` : magpieUrl;
  }
  return truncate(build(140, 0, false), max);
}

/** Text for when the share goes as a file instead of a link. */
export function fileMessage(payload: SharedPayloadV2): string {
  const n = payload.items.length;
  const what = payload.kind === 'item' ? `“${payloadTitle(payload)}”` : `${payloadEmoji(payload)} ${payloadTitle(payload)} (${n} ${n === 1 ? 'save' : 'saves'})`;
  return `I'm sending you ${what} from my Magpie — open the attached file with Magpie to add it.`;
}

// ---------------------------------------------------------------------------
// Share URLs

export interface ShareParts {
  text?: string;
  url?: string;
  title?: string;
}

/** Removes the link from a message for targets that take it separately; a "Label:" line that only introduced the link goes too. */
function withoutUrl(text: string, url: string): string {
  if (!url || !text.includes(url)) return text.trim();
  return text
    .split('\n')
    .flatMap((line) => {
      if (!line.includes(url)) return [line];
      const rest = line.split(url).join('').trim();
      return !rest || /[:：]$/.test(rest) ? [] : [rest];
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function withUrl(text: string | undefined, url: string | undefined): string {
  const t = text?.trim() ?? '';
  if (!url || t.includes(url)) return t;
  return t ? `${t}\n${url}` : url;
}

/**
 * The web / app URL that opens `target` with the given text, link and title, all properly encoded.
 * Targets that take the link separately get it separately (and it's removed from the text).
 */
export function buildShareUrl(target: SocialTarget | SocialTargetId, parts: ShareParts): string {
  const t = typeof target === 'string' ? getTarget(target) : target;
  const url = parts.url ?? '';
  const title = parts.title?.trim() ?? '';
  switch (t.id) {
    case 'whatsapp':
      return `https://wa.me/?text=${enc(withUrl(parts.text, url))}`;
    case 'telegram': {
      // Telegram needs a url; its 4096-character limit covers the link and the text together.
      if (!url) return `https://t.me/share/url?url=${enc(truncate(parts.text?.trim() ?? title, t.maxText))}`;
      const text = truncate(withoutUrl(parts.text ?? '', url), t.maxText - length(url) - 1);
      return `https://t.me/share/url?url=${enc(url)}${text ? `&text=${enc(text)}` : ''}`;
    }
    case 'messenger':
      return `fb-messenger://share/?link=${enc(url)}`;
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`;
    case 'x': {
      const text = fitX(withoutUrl(parts.text ?? title, url), !!url);
      return `https://x.com/intent/post?text=${enc(text)}${url ? `&url=${enc(url)}` : ''}`;
    }
    case 'line':
      return `https://line.me/R/share?text=${enc(withUrl(parts.text, url))}`;
    case 'reddit':
      return `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(truncate(title || withoutUrl(parts.text ?? '', url), 300))}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`;
    case 'email':
      return `mailto:?subject=${enc(title)}&body=${enc(withUrl(parts.text, url))}`;
    case 'sms':
      return `sms:?&body=${enc(withUrl(parts.text, url))}`;
  }
}

/** The text / link / title that suit a target, for a Magpie share link. */
export function composeShare(target: SocialTarget | SocialTargetId, payload: SharedPayloadV2, magpieUrl: string, opts: Pick<MessageOptions, 'locale' | 'now'> = {}): ShareParts {
  const t = typeof target === 'string' ? getTarget(target) : target;
  const title = `${payloadEmoji(payload)} ${payloadTitle(payload)}`;
  const base = { locale: opts.locale, now: opts.now };
  switch (t.id) {
    case 'telegram':
      // The link travels in its own parameter; the text is what's left of Telegram's 4096.
      return { url: magpieUrl, title, text: shareMessage(payload, undefined, { ...base, maxLength: Math.max(0, t.maxText - length(magpieUrl) - 1) }) };
    case 'x':
    case 'reddit':
      return { url: magpieUrl, title, text: shareMessage(payload, undefined, { ...base, short: true }) };
    case 'sms':
      return { url: magpieUrl, title, text: shareMessage(payload, magpieUrl, { ...base, short: true }) };
    case 'messenger':
    case 'facebook':
    case 'linkedin':
      return { url: magpieUrl, title };
    default:
      return { url: magpieUrl, title, text: shareMessage(payload, magpieUrl, { ...base, maxLength: t.maxText + length(magpieUrl) }) };
  }
}

/** composeShare + buildShareUrl: the URL to open for sharing a Magpie link on `target`. */
export function targetShareUrl(target: SocialTarget | SocialTargetId, payload: SharedPayloadV2, magpieUrl: string, opts: Pick<MessageOptions, 'locale' | 'now'> = {}): string {
  return buildShareUrl(target, composeShare(target, payload, magpieUrl, opts));
}
