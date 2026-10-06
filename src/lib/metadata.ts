import { analyzeTitle, classify, hostOf, safeUrl, stripTracking, youtubeId } from './classify';
import { captionTitle, isBoilerplateTitle, isPostLink, parsePostDescription, parsePostTitle, type PostInfo } from './postText';
import type { Item } from './types';

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
   * 'timeout' when it was too slow, 'unavailable' when the platform showed it an error page or sent it somewhere
   * else (the account, the reel's audio, the home page) instead of the post — deleted, private, or only for some
   * countries or signed-in people — and 'failed' otherwise (errors, login walls, nothing found). Unset when the
   * caller cancelled.
   */
  problem?: 'limited' | 'timeout' | 'unavailable' | 'failed';
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

const PROBLEM_RANK: Record<Problem, number> = { failed: 0, timeout: 1, unavailable: 2, limited: 3 };
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

// The platform's "this isn't available" pages (deleted, private or restricted posts), in the languages it answers in.
const UNAVAILABLE_PHRASES = [
  String.raw`(?:sorry,?\s*)?this page (?:isn['’]?t|is not) available`,
  String.raw`(?:sorry,?\s*)?(?:this\s+)?content (?:isn['’]?t|is not|is no longer|no longer|not) available`,
  String.raw`(?:sorry,?\s*)?this (?:post|reel|video|account) (?:is (?:currently |no longer )?unavailable|isn['’]?t available|is (?:no longer|not) available)`,
  String.raw`(?:sorry,?\s*)?(?:video|post|content|page) (?:is )?(?:currently )?unavailable`,
  String.raw`(?:sorry,?\s*)?page not found`,
  String.raw`the link you followed may be broken`,
  String.raw`this account is private`,
  String.raw`(?:很)?抱歉[，,、]?\s*(?:(?:此|這個|这个)(?:頁面|页面)(?:目前)?(?:無法使用|无法使用|無法存取|无法访问|無法顯示|无法显示|不存在|已不存在|不可用)|(?:無法使用|无法使用)(?:此|這個|这个)(?:頁面|页面))`,
  String.raw`(?:此|這個|这个)(?:頁面|页面)(?:目前)?(?:無法使用|无法使用|無法存取|无法访问|無法顯示|无法显示|不存在|已不存在|不可用)`,
  String.raw`找不到(?:此|這個|这个)?(?:頁面|页面|網頁|网页)`,
  String.raw`(?:這|这)(?:個|个)(?:帳號|帐号|账号|账户|帳戶)(?:是|為|为)?私(?:人|密)(?:帳號|帐号|账号|账户|帳戶)?`,
  'このページはご利用いただけません',
  'ページが見つかりません',
  'このアカウントは非公開です',
  String.raw`(?:죄송합니다[.,]?\s*)?페이지를 사용할 수 없습니다`,
  '비공개 계정입니다',
];
// What those pages go on to say: why, and the way back. Anything else after the phrase is someone's own words.
const UNAVAILABLE_TAIL = [
  'the link you followed',
  'the page may',
  'it may have been',
  'it(?:\'|’)?s usually because',
  'when this happens',
  'this (?:may|might) be because',
  '(?:go|return) (?:back )?to',
  'follow (?:this account |them )?to see',
  'learn more',
  'you (?:can|may|might)',
  '你',
  '您',
  '連結',
  '链接',
  '可能',
  '返回',
  '請',
  '请',
  'リンク',
  'ページ',
  'instagramに戻る',
  '클릭',
  '링크',
  '페이지',
  'instagram으로',
].join('|');
const UNAVAILABLE_RE = new RegExp(
  String.raw`^\s*(?:${UNAVAILABLE_PHRASES.join('|')})` +
    String.raw`(?:\s+(?:right now|at the moment|at this time|for now|in your (?:country|region)))?` +
    String.raw`(?:\s*[•|·–—-]\s*(?:instagram|facebook|threads|tiktok))?` +
    String.raw`[\s.!。！]*(?:(?:${UNAVAILABLE_TAIL})[^?？#＃@]{0,300})?$`,
  'i',
);

/**
 * The whole text is one of those pages' messages ("Sorry, this page isn't available. The link you followed may be
 * broken…", "Page not found • Instagram"), not a caption that happens to start with the same words.
 */
const unavailableText = (s: string | undefined): boolean => !!s && s.length <= 500 && UNAVAILABLE_RE.test(s);

// What an account's page or a reel's audio page says: a preview of those isn't a preview of the post.
const PROFILE_TEXT_RE = new RegExp(
  [
    // "12K Followers, 300 Following, 1,234 Posts - …", and the same in Chinese, Japanese and Korean.
    String.raw`^[\d.,]+\s*[kmb]?\s+followers?\s*,\s*[\d.,]+\s*[kmb]?\s+following\b`,
    String.raw`^[\d.,]+\s*[萬万千億亿]?\s*位?(?:粉絲|粉丝)\s*[、,，]`,
    String.raw`^フォロワー\s*[\d.,]+\s*[万千億]?\s*人`,
    String.raw`^팔로워\s*[\d.,]+\s*[만천억]?\s*명`,
    // "… - See Instagram photos and videos from Mei Chan (@mei.eats)"
    String.raw`see instagram photos and videos from\b[^\n]{0,100}\(@[\w.]+\)`,
    String.raw`\(@[\w.]+\)\s*的\s*instagram\s*(?:相片和影片|照片和视频|照片和影片)`,
    String.raw`\(@[\w.]+\)\s*さんのinstagramの写真と動画`,
    String.raw`\(@[\w.]+\)\s*님의\s*instagram\s*사진\s*및\s*동영상`,
    // A reel's audio: "Watch 1,234 reels made with Original audio - chef"
    String.raw`^watch [\d.,]+\s*[kmb]?\s+reels made with\b`,
  ].join('|'),
  'i',
);

// The audio's page is titled after it: "Original audio - chef".
const AUDIO_TITLE_RE = /^original audio\b/i;

/**
 * The page of the account or of the reel's audio, not the post: their description (or an author made from it), or
 * an audio's name for a title with nothing else to go on. The fetch and the clean-up of older saves both go by this.
 */
function notThePost(url: string, title: string | undefined, description: string | undefined, author?: string): boolean {
  const text = description?.trim() ?? '';
  if (PROFILE_TEXT_RE.test(text) || (!!author && PROFILE_TEXT_RE.test(author))) return true;
  return onHost(hostOf(url), ['instagram.com']) && !!title && AUDIO_TITLE_RE.test(title.trim()) && (!text || isBoilerplateTitle(text));
}

/** The platform's own artwork (logo, default share picture): never a post's picture. */
function platformAsset(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.pathname.includes('/rsrc.php/') || /^static\.(?:[\w-]+\.)?(?:cdninstagram\.com|fbcdn\.net)$/.test(host) || onHost(host, ['ttwstatic.com'])) return true;
    return (onHost(host, ['instagram.com']) && /^\/static\//i.test(u.pathname)) || (onHost(host, ['facebook.com']) && /^\/images\//i.test(u.pathname));
  } catch {
    return false;
  }
}

// Where a platform sends you to sign in or check you're human: a wall, not the post moving somewhere else.
const WALL_PATH_RE = /^\/(?:accounts\/(?:login|signup)|login|signup|challenge|checkpoint|consent|privacy\/checks)(?:[/?.]|$)/i;
// A share link ("instagram.com/share/reel/BAxyz…/"): its token isn't the post's code, and it redirects to the post.
const SHARE_PATH_RE = /^\/share\//i;
// One-segment paths that are a post or a video's page all the same ("facebook.com/watch?v=…", "/video.php?v=…").
const POST_SEGMENT_RE = /^(?:watch|reels?|videos?|photos?|story|stories|permalink|groups|events|live|tv|p|posts?)$|\.php$/i;

/** The code in an Instagram or Threads post link ("/reel/ABC123/", "/@chef/post/ABC123" → "ABC123"). */
function postCode(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!onHost(u.hostname.toLowerCase(), ['instagram.com', 'threads.net', 'threads.com']) || SHARE_PATH_RE.test(u.pathname)) return undefined;
    return /\/(?:p|reels?|tv|post)\/([A-Za-z0-9_-]{5,})/.exec(u.pathname)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Asked about a post, the service ended up somewhere else on the same platform: the home page, an account, the reel's
 * audio, another post. That's what the platform does when the post isn't public to it. Only plain signs count: a post
 * reached under another path (a share link's real one, "/watch?v=…" for "/videos/…") is still the post.
 */
function landedElsewhere(url: string, finalUrl: string | undefined): boolean {
  if (!finalUrl) return false;
  let from: URL;
  let to: URL;
  try {
    from = new URL(url);
    to = new URL(finalUrl);
  } catch {
    return false;
  }
  if (!askedForPost(url)) return false;
  const family = (host: string) => SOCIAL_HOSTS.find((h) => onHost(host.toLowerCase(), [h]))?.replace(/^fb\.watch$/, 'facebook.com');
  if (!family(to.hostname) || family(to.hostname) !== family(from.hostname) || WALL_PATH_RE.test(to.pathname)) return false;
  // The reel's audio, or a sound's page.
  if (/^\/(?:reels\/audio|music)\//i.test(to.pathname)) return true;
  const segments = to.pathname.split('/').filter(Boolean);
  // The home page, or an account's ("instagram.com/chef/", "tiktok.com/@chef", "facebook.com/profile.php?id=…").
  if (!segments.length) return true;
  if (segments.length === 1) return /^profile\.php$/i.test(segments[0]) || !POST_SEGMENT_RE.test(segments[0]);
  const [a, b] = [postCode(url), postCode(finalUrl)];
  return !!a && !!b && a !== b;
}

/** A link to a post, or a share link that leads to one. */
function askedForPost(url: string): boolean {
  try {
    return !!postKindFromUrl(url) || SHARE_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The post's own code standing in for a title ("Dd8tDDNKhSA"): what Instagram's page title can be when it has nothing else. */
function isPostCodeTitle(title: string | undefined, url: string | undefined): boolean {
  const t = title?.trim();
  const code = t && url ? postCode(url) : undefined;
  return !!code && t!.toLowerCase() === code.toLowerCase();
}

/** A link to a post on Instagram, Facebook, Threads or TikTok. */
export function isSocialPostLink(url: string | undefined): boolean {
  // Most saves are elsewhere: a quick look before parsing.
  if (!url || !/instagram\.com|facebook\.com|fb\.watch|threads\.(?:net|com)|tiktok\.com/i.test(url)) return false;
  const safe = safeUrl(url);
  return !!safe && onHost(hostOf(safe), SOCIAL_HOSTS) && !!postKindFromUrl(safe);
}

// "Reel by Mei Chan": made from the account's name when there's no caption.
const BY_TITLE_RE = /^(?:reel|photo|video|post) by \S/i;

/**
 * Saves made before Magpie knew the signs: what their stored preview got from an error page, the platform's logo,
 * or the account's or audio's page instead of the post. Returns the fields to clear (so the preview is asked for
 * again), or undefined when it looks fine. Only for social post links; never the title the user typed.
 */
export function badPreviewFields(
  item: Pick<Item, 'url' | 'title' | 'image' | 'description' | 'siteName' | 'author' | 'edited'>,
): Partial<Item> | undefined {
  if (!isSocialPostLink(item.url)) return undefined;
  const url = safeUrl(item.url)!;
  const description = item.description?.trim() ?? '';
  const typedTitle = !!item.edited?.includes('title');
  const elsewhere = notThePost(url, typedTitle ? undefined : item.title, description, item.author);
  // An error page's message, a login wall's (which names nobody), or just the platform's name.
  const errorText =
    !!description && (unavailableText(description) || (WALL_DESCRIPTION_RE.test(description) && !item.author) || isBoilerplateTitle(description));
  const errorTitle = !typedTitle && unavailableText(item.title);
  const badImage = platformAsset(item.image);
  // An earlier version kept the post's code as its title.
  const codeTitle = !typedTitle && isPostCodeTitle(item.title, url);
  if (!elsewhere && !errorText && !errorTitle && !badImage && !codeTitle) return undefined;
  const out: Partial<Item> = {};
  // The account's picture or the audio's cover came with that page, and so did anything it said.
  if (badImage || (elsewhere && item.image)) out.image = undefined;
  if (description && (elsewhere || errorText || errorTitle)) out.description = undefined;
  // With no picture or text left, the site name would stop the preview from being asked for again.
  const imageLeft = 'image' in out ? undefined : item.image;
  const descriptionLeft = 'description' in out ? undefined : description;
  if (item.siteName && !imageLeft && !descriptionLeft) out.siteName = undefined;
  // That page's name for the post ("Reel by <account>", "Original audio - chef", "Page not found") and its account
  // go too, so the post's own caption title and author can take their place.
  if (elsewhere && item.author) out.author = undefined;
  const pageTitle =
    errorTitle || (elsewhere && (BY_TITLE_RE.test(item.title) || AUDIO_TITLE_RE.test(item.title) || item.title === item.author || isBoilerplateTitle(item.title)));
  const linkTitle = classify({ url }).title;
  if (!typedTitle && pageTitle && item.title !== linkTitle) out.title = linkTitle;
  if (codeTitle) out.title = (description && !('description' in out) ? captionTitle(description) : undefined) || linkTitle;
  return out;
}

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
  let title = typeof rawTitle === 'string' ? rawTitle.replace(/\s+/g, ' ').trim() : '';
  const description = typeof rawDescription === 'string' ? rawDescription.replace(/\r\n?/g, '\n').trim() : '';
  const host = hostOf(url);
  // The post's code as its "title" says nothing: leave it out, and with nothing else to go on, nothing came back.
  if (isPostCodeTitle(title, url) || isPostCodeTitle(p.title, url)) {
    title = '';
    p = { ...p, title: undefined, rawTitle: undefined };
    if (!description && !p.image) return undefined;
  }
  // Only social posts: a news site's "LONDON, March 5, 2026: “…”" isn't a caption with its author.
  const post = isPostLink(url) || isPostLink(p.finalUrl);
  const fromText = post && description ? parsePostDescription(description) : undefined;
  const fromTitle = post && title ? parsePostTitle(title) : undefined;
  const handle = fromText?.handle ?? fromTitle?.handle;
  const name = fromTitle?.author ?? fromText?.author;
  if (onHost(host, SOCIAL_HOSTS) && !handle && !name) {
    // "Sorry, this page isn't available" as the title, or under just the platform's name: deleted or not public.
    if (unavailableText(title) || ((!title || isBoilerplateTitle(title)) && unavailableText(description))) throw new PreviewProblem('unavailable');
    // A login wall: just the platform's name, nothing about the post or who posted it.
    // (A picture here is the post's own: the platform's logo never gets this far.)
    if (!p.image && isBoilerplateTitle(title) && (!description || WALL_DESCRIPTION_RE.test(description) || isBoilerplateTitle(description))) return undefined;
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
  const social = onHost(hostOf(url), SOCIAL_HOSTS);
  // Sent to the account, the audio or the home page instead, or given their page under the post's own link: not a
  // preview of this post (the clean-up of older saves goes by the same signs).
  if (social && askedForPost(url) && (landedElsewhere(url, safeUrl(d.url)) || notThePost(url, clean(d.title), clean(d.description, 500)))) {
    throw new PreviewProblem('unavailable');
  }
  const t = titleFields(d.title);
  const image = imageUrl(d.image);
  return withPost(
    {
      title: t.title,
      rawTitle: t.rawTitle,
      description: clean(d.description, 500),
      // A social post's picture is its own: never the platform's logo or default artwork.
      image: social ? (platformAsset(image) ? undefined : image) : image ?? imageUrl(d.logo),
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
  // The platform wouldn't show the post at its plain link. It may still show it with the link as it was shared (a
  // share token such as Instagram's ?stkn= may be what opens it to people who aren't signed in): asked once more that
  // way. Only then, so the token goes to the service only for a post it can't see otherwise.
  const shared = safeUrl(url);
  if (!answered && problem === 'unavailable' && shared && shared !== target && attempts.includes(fromMicrolink) && !signal?.aborted) {
    try {
      const p = await fromMicrolink(shared, signal, timeout);
      if (p && Object.values(p).some(Boolean)) answered = true;
      merge(p);
    } catch (e) {
      // Still not public; the reason stays "unavailable" whatever this second try ran into.
      if (e instanceof PreviewProblem && e.problem === 'limited') noteLimited();
    }
  }
  if (!preview.rawTitle) delete preview.rawTitle;
  if (!answered && !signal?.aborted) preview.problem = problem ?? 'failed';
  return preview;
}
