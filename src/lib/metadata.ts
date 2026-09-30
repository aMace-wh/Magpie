import { analyzeTitle, hostOf, safeUrl, youtubeId } from './classify';

/**
 * Link previews (title, image, description, author…). Browsers can't read other sites'
 * HTML directly (CORS), so this asks public CORS-friendly preview services.
 * It can be switched off in Settings; saving works without it.
 */

export interface LinkPreview {
  /** Cleaned title: no hashtags, "- YouTube" / "| TikTok" trailers or login-wall text. */
  title?: string;
  /** The title as the page gave it, only whitespace tidied (keeps hashtags for tagging); set whenever `title` is. */
  rawTitle?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** Where the link ended up after redirects — short map links resolve to ones with coordinates. */
  finalUrl?: string;
  /** Creator, channel or author, e.g. "Joshua Weissman" or "@chef". */
  author?: string;
  /** When the page says it was published, as an ISO 8601 string. */
  publishedAt?: string;
  /** Page language, e.g. "en" or "zh-HK". */
  lang?: string;
  /** Kind of content the provider reports, e.g. "video", "photo", "rich", "article". */
  type?: string;
}

const TIMEOUT_MS = 8000;

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw new Error('Aborted');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function clean(s: unknown, max = 300): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** Title fields from a provider's raw title; the creator named in it (e.g. "Chef on Instagram: …") is a fallback author. */
function titleFields(raw: unknown): Pick<LinkPreview, 'title' | 'rawTitle' | 'author'> {
  const rawTitle = clean(raw);
  if (!rawTitle) return {};
  const { title, author } = analyzeTitle(rawTitle);
  if (!title) return {}; // login walls, bot checks, bare site names
  return { title, rawTitle, author: clean(author, 80) };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** ISO 8601 dates only: other formats parse differently per browser, and Date.parse rolls "2024-02-30" over to March. */
function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.trim().match(ISO_DATE_RE);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1990 || year > new Date().getUTCFullYear() + 5) return undefined;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return undefined;
  if (m[4] && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) return undefined;
  // Rebuilt in the one form every browser parses the same way: "+0100" → "+01:00", fractions to ms.
  const zone = m[8]?.toUpperCase();
  const offset = zone && zone !== 'Z' ? `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}` : zone ?? '';
  const time = m[4] ? `T${m[4]}:${m[5]}:${m[6] ?? '00'}${(m[7] ?? '').slice(0, 4)}${offset}` : '';
  const normalized = `${m[1]}-${m[2]}-${m[3]}${time}`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function langCode(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/_/g, '-');
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(s) ? s : undefined;
}

function kind(v: unknown): string | undefined {
  const s = clean(v, 40)?.toLowerCase();
  return s && /^[a-z][\w.:-]*$/.test(s) ? s : undefined;
}

/** oEmbed via noembed.com — covers YouTube, Vimeo, TikTok, Flickr, SoundCloud and more. */
async function fromNoembed(url: string, signal?: AbortSignal): Promise<LinkPreview | undefined> {
  const data = (await getJson(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, signal)) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object' || data.error) return undefined;
  const t = titleFields(data.title);
  const author = clean(data.author_name, 80);
  return {
    title: t.title,
    rawTitle: t.rawTitle,
    image: safeUrl(data.thumbnail_url),
    siteName: clean(data.provider_name, 60),
    description: author ? `by ${author}` : undefined,
    author: author ?? t.author,
    type: kind(data.type),
  };
}

/** Open Graph / meta tags via microlink.io's free tier. */
async function fromMicrolink(url: string, signal?: AbortSignal): Promise<LinkPreview | undefined> {
  const res = (await getJson(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, signal)) as {
    status?: string;
    data?: Record<string, unknown>;
  } | null;
  if (res?.status !== 'success' || !res.data || typeof res.data !== 'object') return undefined;
  const d = res.data;
  const imageUrl = (v: unknown) => (v && typeof v === 'object' ? safeUrl((v as { url?: unknown }).url) : undefined);
  const t = titleFields(d.title);
  return {
    title: t.title,
    rawTitle: t.rawTitle,
    description: clean(d.description, 500),
    image: imageUrl(d.image) ?? imageUrl(d.logo),
    siteName: clean(d.publisher, 60),
    finalUrl: safeUrl(d.url),
    author: clean(d.author, 80) ?? t.author,
    publishedAt: isoDate(d.date),
    lang: langCode(d.lang),
    type: kind(d.type),
  };
}

const OEMBED_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'soundcloud.com', 'flickr.com', 'dailymotion.com'];

export async function fetchPreview(url: string, signal?: AbortSignal): Promise<LinkPreview> {
  const preview: LinkPreview = {};
  if (!safeUrl(url)) return preview;
  const host = hostOf(url);
  const yt = youtubeId(url);
  if (yt) preview.image = `https://i.ytimg.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg`;

  const merge = (p: LinkPreview | undefined) => {
    if (!p) return;
    // The raw title always travels with the title it belongs to.
    if (!preview.title && p.title) {
      preview.title = p.title;
      preview.rawTitle = p.rawTitle;
    }
    for (const k of Object.keys(p) as (keyof LinkPreview)[]) {
      if (k === 'title' || k === 'rawTitle') continue;
      if (!preview[k] && p[k]) preview[k] = p[k];
    }
  };

  const attempts = OEMBED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? [fromNoembed, fromMicrolink] : [fromMicrolink];
  for (const attempt of attempts) {
    if (signal?.aborted || (preview.title && preview.image)) break;
    try {
      merge(await attempt(url, signal));
    } catch {
      /* try the next source */
    }
  }
  if (!preview.rawTitle) delete preview.rawTitle;
  return preview;
}
