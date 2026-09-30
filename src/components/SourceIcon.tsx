import { Camera, Cloud, Film, Gamepad2, Link, MapPin, Mic, Ticket, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

interface Props {
  /** Platform key, e.g. "youtube" (see Item.source). */
  source?: string;
  size?: number;
  /** Accessible name; without one the badge is decorative. */
  title?: string;
}

type Glyph = (px: number) => ReactNode;

interface Look {
  bg: string;
  fg?: string;
  glyph: Glyph;
  /** Hairline ring so near-black badges don't vanish on dark backgrounds. */
  ring?: boolean;
}

// Simple generic glyphs — deliberately not the platforms' own logos.
const svg = (px: number, children: ReactNode) => (
  <svg width={px} height={px} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const play: Glyph = (px) => svg(px, <path d="M9 6.6v10.8a.7.7 0 0 0 1.07.6l8.5-5.4a.7.7 0 0 0 0-1.2l-8.5-5.4A.7.7 0 0 0 9 6.6z" />);

const note: Glyph = (px) =>
  svg(
    px,
    <>
      <circle cx="9.3" cy="16" r="3.1" />
      <path d="M10.9 16V4.8h2.3c.25 1.9 1.7 3.3 3.8 3.5v2.3c-1.45 0-2.75-.45-3.8-1.25V16z" />
    </>,
  );

const cross: Glyph = (px) =>
  svg(px, <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" fill="none" />);

const butterfly: Glyph = (px) =>
  svg(
    px,
    <>
      <ellipse cx="7.6" cy="9.4" rx="4.1" ry="3" transform="rotate(-28 7.6 9.4)" />
      <ellipse cx="16.4" cy="9.4" rx="4.1" ry="3" transform="rotate(28 16.4 9.4)" />
      <ellipse cx="8.8" cy="15.2" rx="2.7" ry="2.1" transform="rotate(30 8.8 15.2)" />
      <ellipse cx="15.2" cy="15.2" rx="2.7" ry="2.1" transform="rotate(-30 15.2 15.2)" />
    </>,
  );

const letter =
  (text: string, scale = 1): Glyph =>
  (px) => (
    <span aria-hidden="true" style={{ fontSize: px * 0.95 * scale, lineHeight: 1, transform: 'translateY(-0.03em)' }}>
      {text}
    </span>
  );

const lucide =
  (Icon: LucideIcon, strokeWidth = 2.4): Glyph =>
  (px) => <Icon size={px} strokeWidth={strokeWidth} aria-hidden="true" />;

const pin = lucide(MapPin);
const ticket = lucide(Ticket);

const INK = '#111111';

const LOOKS: Record<string, Look> = {
  youtube: { bg: '#ff0033', glyph: play },
  'youtube-music': { bg: '#ff0033', glyph: note },
  tiktok: { bg: INK, glyph: note, ring: true },
  douyin: { bg: INK, glyph: note, ring: true },
  instagram: { bg: 'linear-gradient(45deg, #fdc468 0%, #fa7e1e 28%, #d62976 55%, #962fbf 80%, #4f5bd5 100%)', glyph: lucide(Camera) },
  x: { bg: '#000000', glyph: cross, ring: true },
  threads: { bg: '#000000', glyph: letter('@', 0.95), ring: true },
  bluesky: { bg: '#1185fe', glyph: butterfly },
  linkedin: { bg: '#0a66c2', glyph: letter('in', 0.8) },
  facebook: { bg: '#1877f2', glyph: letter('f', 1.1) },
  pinterest: { bg: '#e60023', glyph: letter('P') },
  reddit: { bg: '#ff4500', glyph: letter('r', 1.05) },
  rednote: { bg: '#ff2442', glyph: letter('R') },
  lemon8: { bg: '#ffe500', fg: INK, glyph: letter('8') },
  snapchat: { bg: '#fffc00', fg: INK, glyph: letter('S') },
  vimeo: { bg: '#1ab7ea', glyph: letter('v', 1.05) },
  dailymotion: { bg: '#0d0d0d', glyph: letter('d', 1.05), ring: true },
  twitch: { bg: '#9146ff', glyph: play },
  kick: { bg: '#53fc18', fg: INK, glyph: letter('K') },
  loom: { bg: '#625df5', glyph: play },
  letterboxd: { bg: '#202830', glyph: lucide(Film), ring: true },
  imdb: { bg: '#f5c518', fg: INK, glyph: lucide(Film) },
  spotify: { bg: '#1db954', fg: INK, glyph: note },
  'apple-music': { bg: 'linear-gradient(135deg, #fa586a, #fb233b)', glyph: note },
  'apple-podcasts': { bg: 'linear-gradient(135deg, #d56efc, #832bc1)', glyph: lucide(Mic) },
  soundcloud: { bg: '#ff5500', glyph: lucide(Cloud) },
  substack: { bg: '#ff6719', glyph: letter('S') },
  steam: { bg: '#1b2838', glyph: lucide(Gamepad2), ring: true },
  'google-maps': { bg: '#34a853', glyph: pin },
  'apple-maps': { bg: '#0a84ff', glyph: pin },
  openstreetmap: { bg: '#5f9e4f', glyph: pin },
  waze: { bg: '#33ccff', fg: INK, glyph: pin },
  eventbrite: { bg: '#f05537', glyph: ticket },
  ticketmaster: { bg: '#026cdf', glyph: ticket },
  dice: { bg: INK, glyph: ticket, ring: true },
  'resident-advisor': { bg: INK, glyph: ticket, ring: true },
  meetup: { bg: '#f65858', glyph: ticket },
  luma: { bg: '#5b4cf0', glyph: ticket },
  partiful: { bg: '#e14d9a', glyph: ticket },
};

const ALIASES: Record<string, string> = { twitter: 'x', xiaohongshu: 'rednote' };

const GENERIC: Look = { bg: 'var(--surface-3)', fg: 'var(--muted)', glyph: lucide(Link, 2.2) };

function lookFor(source: string | undefined): Look | undefined {
  if (!source) return undefined;
  const k = source.toLowerCase();
  const name = Object.hasOwn(ALIASES, k) ? ALIASES[k] : k;
  return Object.hasOwn(LOOKS, name) ? LOOKS[name] : undefined;
}

/** The badge colour for a platform (a colour or gradient), for tinting placeholders. */
export function sourceTint(source: string | undefined): string | undefined {
  return lookFor(source)?.bg;
}

/** Whether a platform has its own badge (otherwise SourceIcon shows a generic link). */
export function hasSourceIcon(source: string | undefined): boolean {
  return !!lookFor(source);
}

/** A small round platform badge: brand-ish colour with a simple glyph, or a link icon for anything else. */
export function SourceIcon({ source, size = 20, title }: Props) {
  const look = lookFor(source) ?? GENERIC;
  const style: CSSProperties = {
    display: 'inline-grid',
    placeItems: 'center',
    flex: '0 0 auto',
    width: size,
    height: size,
    borderRadius: '50%',
    overflow: 'hidden',
    background: look.bg,
    color: look.fg ?? '#ffffff',
    boxShadow: look.ring ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.22)' : undefined,
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1,
    userSelect: 'none',
    verticalAlign: 'middle',
  };
  const a11y = title ? { role: 'img', 'aria-label': title, title } : { 'aria-hidden': true as const };
  return (
    <span className="source-icon" data-source={source} style={style} {...a11y}>
      {look.glyph(Math.max(8, Math.round(size * 0.6)))}
    </span>
  );
}
