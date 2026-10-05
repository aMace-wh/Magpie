import { analyzeTitle, hostOf, safeUrl, stripTracking, youtubeId } from './classify';
import { captionTitle, isBoilerplateTitle, isPostLink, parsePostDescription, parsePostTitle, type PostInfo } from './postText';

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
  /** A social post's own text (Instagram, Facebook, Threads, TikTok caption), without likes, comments or date. */
  caption?: string;
  /**
   * Why nothing came back: 'limited' when the preview service's daily allowance is used up (HTTP 429),
   * 'timeout' when it was too slow, 'failed' otherwise (errors, login walls, nothing found). Unset when the
   * caller cancelled.
   */
  problem?: 'limited' | 'timeout' | 'failed';
}

type Problem = NonNullable<LinkPreview['problem']>;

const TIMEOUT_MS = 8000;
/** Instagram, Facebook and Threads previews often take the services well over 8 s. */
const SLOW_TIMEOUT_MS = 15000;
const SLOW_HOSTS = ['instagram.com', 'facebook.com', 'fb.watch', 'threads.net', 'threads.com'];
const SOCIAL_HOSTS = [...SLOW_HOSTS, 'tiktok.com'];
/** Instagram's own caption limit. */
const CAPTION_MAX = 2200;

const onHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

class PreviewProblem extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem);
    this.problem = problem;
  }
}

const PROBLEM_RANK: Record<Problem, number> = { failed: 0, timeout: 1, limited: 2 };
const worse = (a: Problem | undefined, b: Problem): Problem => (a && PROBLEM_RANK[a] >= PROBLEM_RANK[b] ? a : b);

async function getJson(url: string, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  if (signal?.aborted) throw new Error('Aborted');
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new PreviewProblem(res.status === 429 ? 'limited' : 'failed');
    return await res.json();
  } catch (e) {
    throw timedOut && !signal?.aborted ? new PreviewProblem('timeout') : e;
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

/** Like clean(), but keeps line breaks: captions put places, dates and lists on lines of their own. */
function cleanLines(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  const t = s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
async function fromNoembed(url: string, signal?: AbortSignal, timeoutMs?: number): Promise<LinkPreview | undefined> {
  const data = (await getJson(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, signal, timeoutMs)) as Record<string, unknown> | null;
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

// Login walls' descriptions: they say nothing about the post.
const WALL_DESCRIPTION_RE =
  /^(?:create an account or log in to instagram|log in to (?:see|view) (?:photos|this)|welcome back to instagram|log into facebook|facebook helps you connect|see posts, photos and more on facebook|join threads|log in with your instagram)/i;

const KIND_WORDS: Record<NonNullable<PostInfo['kind']>, string> = { reel: 'Reel', photo: 'Photo', video: 'Video', post: 'Post' };

/** What kind of post a link is, from its path: instagram.com/reel/…, /p/…, /tv/…. */
function postKindFromUrl(url: string): PostInfo['kind'] {
  try {
    const path = new URL(url).pathname;
    if (/\/(?:reels?|reel_share)\//i.test(path)) return 'reel';
    if (/\/(?:tv|videos?|watch)\//i.test(path)) return 'video';
    if (/\/(?:p|posts?|permalink|photos?|story\.php|share\/p)\b/i.test(path)) return 'post';
  } catch {
    /* not a URL */
  }
  return undefined;
}

/**
 * Social posts: the caption (without "1,234 likes, 56 comments - chef on March 5, 2026:") becomes the
 * description, the posting date and account fill publishedAt and author, and the title is made from the
 * caption instead of the account's name ("Chef (@chef) • Instagram reel"). Undefined for a login wall.
 */
function withPost(p: LinkPreview, rawTitle: unknown, rawDescription: unknown, url: string): LinkPreview | undefined {
  const title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
  const description = typeof rawDescription === 'string' ? rawDescription.replace(/\r\n?/g, '\n').trim() : '';
  const host = hostOf(url);
  // Only social posts: a news site's "LONDON, March 5, 2026: “…”" isn't a caption with its author.
  const post = isPostLink(url) || isPostLink(p.finalUrl);
  const fromText = post && description ? parsePostDescription(description) : undefined;
  const fromTitle = post && title ? parsePostTitle(title) : undefined;
  const handle = fromText?.handle ?? fromTitle?.handle;
  const name = fromTitle?.author ?? fromText?.author;
  // A login wall: just the platform's name, nothing about the post or who posted it.
  if (onHost(host, SOCIAL_HOSTS) && isBoilerplateTitle(title) && !handle && !name && (!description || WALL_DESCRIPTION_RE.test(description))) {
    return undefined;
  }
  if (!fromText && !fromTitle) return p;

  let caption = fromText?.caption ?? fromTitle?.caption;
  // Threads: the title names the account and the description is the post itself.
  if (!caption && !fromText && (handle || name) && onHost(host, ['threads.net', 'threads.com'])) caption = description;
  caption = cleanLines(caption, CAPTION_MAX);

  const out: LinkPreview = { ...p };
  out.author = clean(name, 80) ?? (handle ? `@${handle}` : undefined) ?? p.author;
  out.publishedAt = isoDate(fromText?.publishedAt ?? fromTitle?.publishedAt) ?? p.publishedAt;
  const postKind = fromTitle?.kind ?? fromText?.kind ?? postKindFromUrl(url);
  if (postKind === 'reel' || postKind === 'video') out.type = 'video';
  else if (postKind === 'photo') out.type = 'photo';

  if (caption) {
    out.caption = caption;
    out.description = caption;
  } else if (fromText) {
    // "1,234 likes, 56 comments - chef on March 5, 2026" says nothing the other fields don't.
    delete out.description;
  }
  const titled = caption ? captionTitle(caption) : undefined;
  if (titled) {
    out.title = titled;
    // Hashtags and all, for tags and kind evidence.
    out.rawTitle = clean(caption, 600);
  } else if (fromText || isBoilerplateTitle(title)) {
    // Nothing to go on but the account: "Reel by Chef" beats "Chef (@chef) • Instagram reel".
    const fallback = out.author && postKind ? `${KIND_WORDS[postKind]} by ${out.author}` : undefined;
    if (fallback) out.title = out.rawTitle = fallback;
    else if (out.title && isBoilerplateTitle(out.title)) {
      delete out.title;
      delete out.rawTitle;
    }
  }
  return out;
}

/** Open Graph / meta tags via microlink.io's free tier. */
async function fromMicrolink(url: string, signal?: AbortSignal, timeoutMs?: number): Promise<LinkPreview | undefined> {
  const res = (await getJson(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, signal, timeoutMs)) as {
    status?: string;
    code?: string;
    data?: Record<string, unknown>;
  } | null;
  if (res?.status !== 'success' || !res.data || typeof res.data !== 'object') {
    if (res?.code === 'ERATE') throw new PreviewProblem('limited');
    return undefined;
  }
  const d = res.data;
  const imageUrl = (v: unknown) => (v && typeof v === 'object' ? safeUrl((v as { url?: unknown }).url) : undefined);
  const t = titleFields(d.title);
  return withPost(
    {
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
    },
    d.title,
    d.description,
    url,
  );
}

const OEMBED_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'soundcloud.com', 'flickr.com', 'dailymotion.com'];

// ---------------------------------------------------------------------------
// microlink.io's free allowance (about 50 previews a day): once it says no, it's left alone until tomorrow.

const LIMITED_KEY = 'magpie:previews-limited-until';
/** At least this long, however close midnight is. */
const MIN_LIMITED_MS = 3 * 3600_000;
let limitedUntil: number | undefined;

/** Until when (ms) previews are paused because the service's daily allowance ran out; 0 when they aren't. */
export function previewsLimitedUntil(now = Date.now()): number {
  if (limitedUntil === undefined) {
    try {
      limitedUntil = Number(localStorage.getItem(LIMITED_KEY)) || 0;
    } catch {
      limitedUntil = 0;
    }
  }
  return limitedUntil > now ? limitedUntil : 0;
}

function setLimitedUntil(until: number): void {
  limitedUntil = until;
  try {
    if (until) localStorage.setItem(LIMITED_KEY, String(until));
    else localStorage.removeItem(LIMITED_KEY);
  } catch {
    /* private mode: this session's memory is enough */
  }
}

/** The allowance ran out: pause until the start of tomorrow. */
function noteLimited(now = Date.now()): void {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  setLimitedUntil(Math.max(tomorrow.getTime(), now + MIN_LIMITED_MS));
}

/** Forgets the pause. For tests. */
export function resetPreviewLimit(): void {
  setLimitedUntil(0);
  limitedUntil = undefined;
}

export interface FetchPreviewOptions {
  /** Ask microlink even while its allowance is paused (someone tapped "Refresh preview"). */
  force?: boolean;
}

/**
 * A link's preview from the public services. Never throws: when nothing comes back, `problem` says why
 * (unless `signal` cancelled it). While microlink's daily allowance is used up it isn't asked (see
 * previewsLimitedUntil), unless `force`.
 */
export async function fetchPreview(url: string, signal?: AbortSignal, opts: FetchPreviewOptions = {}): Promise<LinkPreview> {
  const preview: LinkPreview = {};
  if (!safeUrl(url)) return preview;
  // Per-share tokens (?igsh, ?stkn, ?si…) only split the services' caches, and Instagram answers the canonical link best.
  const target = stripTracking(url);
  const host = hostOf(target);
  const timeout = onHost(host, SLOW_HOSTS) ? SLOW_TIMEOUT_MS : TIMEOUT_MS;
  const yt = youtubeId(url);
  if (yt) preview.image = `https://i.ytimg.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg`;

  const merge = (p: LinkPreview | undefined) => {
    if (!p) return;
    // The raw title always travels with the title it belongs to.
    if (!preview.title && p.title) {
      preview.title = p.title;
      preview.rawTitle = p.rawTitle;
    }
    const fill = preview as Record<keyof LinkPreview, unknown>;
    for (const k of Object.keys(p) as (keyof LinkPreview)[]) {
      if (k === 'title' || k === 'rawTitle') continue;
      if (!fill[k] && p[k]) fill[k] = p[k];
    }
  };

  const limited = !opts.force && previewsLimitedUntil() > 0;
  const attempts = [...(onHost(host, OEMBED_HOSTS) ? [fromNoembed] : []), ...(limited ? [] : [fromMicrolink])];
  let answered = false;
  let problem: Problem | undefined = limited ? 'limited' : undefined;
  for (const attempt of attempts) {
    if (signal?.aborted || (preview.title && preview.image)) break;
    try {
      const p = await attempt(target, signal, timeout);
      if (p && Object.values(p).some(Boolean)) answered = true;
      merge(p);
      if (attempt === fromMicrolink && previewsLimitedUntil()) setLimitedUntil(0);
    } catch (e) {
      // Try the next source, remembering the most telling reason this one failed.
      const why = e instanceof PreviewProblem ? e.problem : 'failed';
      if (why === 'limited' && attempt === fromMicrolink) noteLimited();
      problem = worse(problem, why);
    }
  }
  if (!preview.rawTitle) delete preview.rawTitle;
  if (!answered && !signal?.aborted) preview.problem = problem ?? 'failed';
  return preview;
}
