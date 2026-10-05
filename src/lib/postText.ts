/**
 * Social posts' own words. Instagram, Threads, Facebook and TikTok previews name the account in the
 * title ("Mei (@mei.eats) • Instagram reel") and wrap the caption in the description
 * ('1,234 likes, 56 comments - mei.eats on March 5, 2026: "Caption"'). This pulls the caption, author and
 * posting date back out, and turns a caption into a short title. Pure text work: no network.
 */

export interface PostInfo {
  /** The post's own text, without the likes / comments / date wrapper or the quotes around it. */
  caption?: string;
  /** Display name, e.g. "Mei Chan". */
  author?: string;
  /** Account handle without the @, e.g. "mei.eats". */
  handle?: string;
  /** When it was posted, 'YYYY-MM-DD'. */
  publishedAt?: string;
  kind?: 'reel' | 'photo' | 'video' | 'post';
}

type PostKind = NonNullable<PostInfo['kind']>;

// ---------------------------------------------------------------------------
// Description and title forms

// "1,234 likes", "21K likes", "1,234 個讚", "56 則留言", "いいね！12件", "좋아요 12개"…
// Spaces belong to exactly one part of each pattern (two optional runs side by side backtrack badly on junk), and
// the big patterns spell out their capitals instead of using the i flag: they compile much faster that way.
const NUM = String.raw`\d[\d.,]*(?:\s*(?:[KkMmBb]|萬|万|千|億|亿))?\+?`;
const COUNT_AFTER = String.raw`[Ll]ikes?|[Cc]omments?|[Rr]eactions?|[Ss]hares?|[Vv]iews?|[Pp]lays?|[Rr]eposts?|個讚好?|个赞|次赞|讚好?|赞|則留言|條留言|条留言|則回應|個回應|條評論|条评论|則評論|留言|评论|評論|回應|回应|次分享|次觀看|次观看|次播放`;
const COUNT_BEFORE = String.raw`いいね[！!]?|コメント|좋아요|댓글`;
const COUNT = String.raw`(?:${NUM}\s*(?:${COUNT_AFTER})(?![A-Za-z])|(?:${COUNT_BEFORE})\s*${NUM}(?:\s*(?:件|개))?)`;
// Each count followed by a separator, or by the dash / full stop / bar that ends the list (one copy of COUNT keeps it small).
const COUNTS = String.raw`(?:${COUNT}(?:\s*[,，、·•]\s*|(?=\s*[-–—.。|])))+`;

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const DATE = String.raw`(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+(?:${MONTHS})\.?,?\s+\d{4}|\d{4}\s*[年년]\s*\d{1,2}\s*[月월]\s*\d{1,2}\s*[日일]?|\d{4}-\d{1,2}-\d{1,2}`;
const TIME = String.raw`(?:(?:\s+at\s+|\s*[於于]\s*|\s+)\d{1,2}:\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?(?:\s*(?:UTC|GMT)(?:[+-]\d{1,2})?)?)?`;
// Between the handle and the date: " on ", "於", "님,", " - ", or just a space.
const BY_ON = String.raw`(?:\s+on\s+|\s*(?:於|于|在|님[,，]?|[-–—,，、])\s*|\s+)`;
const PLATFORMS = 'Instagram|Threads|TikTok|Facebook';

/** '1,234 likes, 56 comments - mei.eats on March 5, 2026: "Caption"' and its translations ("handle 於 2026年3月5日:「…」"). */
const IG_RE = new RegExp(String.raw`^\s*(?:(${COUNTS})\s*[-–—]\s*)?([\w.]{1,30})${BY_ON}(${DATE})${TIME}(?:\s*[:：]\s*([\s\S]*))?\s*$`);
/** Older: '1,234 Likes, 56 Comments - Mei (@mei.eats) on Instagram: "Caption"'. */
const ON_IG_RE = new RegExp(
  String.raw`^\s*(?:(${COUNTS})\s*[-–—]\s*)?(?:(.{0,80}?)\s*\(@([\w.]{1,30})\)|@([\w.]{1,30})|([^\n:：]{1,60}?))\s+on\s+(?:Instagram|Threads)(?:\s*[:：]\s*([\s\S]*))?\s*$`,
);
/** '1.2M Likes, 3,456 Comments. TikTok video from Mei (@mei.eats): "Caption". original sound - mei.eats'. */
const TIKTOK_RE = new RegExp(String.raw`^\s*(?:${COUNTS}(?:\s*[.。])?\s*)?TikTok video from\s+(.{1,80}?)\s*\(@([\w.]{1,30})\)\s*[:：]\s*([\s\S]*)$`);

/** "Mei (@mei.eats) • Instagram reel", "Mei (@mei.eats) on Threads", "Mei (@mei.eats) | TikTok". */
const ACCOUNT_TITLE_RE = new RegExp(
  String.raw`^(.{0,80}?)\s*\(@([\w.]{1,30})\)\s*(?:[•·|]\s*(?:${PLATFORMS})(?:\s+([^•·|]{1,30}?))?|on\s+(?:${PLATFORMS}))\s*$`,
);
/** "Instagram", "Instagram reel", "Instagram photos and videos". */
const PLATFORM_TITLE_RE = new RegExp(String.raw`^(?:${PLATFORMS})(?:\s+([^•·|:]{1,30}))?$`, 'i');
/** Older: "Instagram post by Mei • Mar 5, 2026 at 10:00 AM". */
const POST_BY_TITLE_RE = /^Instagram\s+(post|photo|video|reel)s?\s+(?:by|from)\s+(.{1,80}?)(?:\s*[•·]\s*(.*))?$/i;
/** Facebook: "12K views · 345 reactions | Caption | By Mei Chan | Facebook". */
const FB_TITLE_RE = new RegExp(String.raw`^(?:${COUNTS}\s*\|\s*)?(.*?)\s*\|\s*By\s+([^|]{1,80}?)\s*\|\s*Facebook$`);
/** Facebook: "Reel by Mei Chan | Facebook". */
const FB_BY_TITLE_RE = /^(Reel|Video|Photo|Post)\s+by\s+(.{1,80}?)\s*\|\s*Facebook$/i;
/** 'Mei on X: "Post" / X', 'Mei on Bluesky: "Post"'. */
const ON_PLATFORM_TITLE_RE = /^(@[\w.]{1,30}|[^\n]{1,60}?)\s+on\s+(?:Instagram|Threads|TikTok|Facebook|X|Twitter|Bluesky)\s*[:：]\s*([\s\S]+)$/i;

/** Login walls and error pages, once the platform's name is taken off. */
const WALL_TITLE_RE =
  /^(?:log ?in|login|sign ?(?:in|up)|log in or sign up(?: to view)?|log into (?:facebook|instagram)|登入|登录|ログイン|로그인|page not found|content (?:isn['’]t|not) available|this (?:page|content) isn['’]t available(?: right now)?|restricted (?:profile|video|content)|error|explore)$/i;
const PLATFORM_AFFIX_RE = new RegExp(String.raw`^(?:${PLATFORMS})\s*[:•·|–—-]\s*|\s*[:•·|–—-]\s*(?:${PLATFORMS})$`, 'i');

const LEAD_QUOTE_RE = /^\s*["“”「『]/u;
const TRAIL_QUOTE_RE = /["”“」』]\s*[.。]?\s*$/u;
// Mid-text, only a quote with Instagram's full stop after it closes a caption.
const CLOSING_QUOTE_RE = /["”“」』]\s*[.。]\s*$/u;
// TikTok: '"Caption". original sound - chef' — the caption is what's inside the last quotes.
const TIKTOK_QUOTED_RE = /^\s*["“”]([\s\S]*)["”“]\s*[.。]?(?:\s+[^"“”]*)?$/u;

function kindOf(word: string | undefined): PostKind | undefined {
  const w = word?.trim().toLowerCase();
  if (!w) return undefined;
  if (/^(?:reels?|連續短片|连续短视频|リール|릴스)$/u.test(w)) return 'reel';
  if (/^(?:photos?|相片|照片|写真|사진)$/u.test(w)) return 'photo';
  if (/^(?:videos?|影片|视频|視頻|動画|동영상)$/u.test(w)) return 'video';
  if (/^(?:posts?|貼文|帖子|帖文|投稿|게시물)$/u.test(w)) return 'post';
  return undefined;
}

const MONTH_NUMBERS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNumber = (name: string) => MONTH_NUMBERS[name.slice(0, 3).toLowerCase()];

/** "March 5, 2026", "5 March 2026", "2026年3月5日", "2026-03-05" → '2026-03-05' (real dates only). */
function postDate(text: string | undefined): string | undefined {
  const s = text?.trim();
  if (!s) return undefined;
  let r: RegExpExecArray | null;
  let y: number, m: number | undefined, d: number;
  if ((r = /^(\d{4})\s*[年년-]\s*(\d{1,2})\s*[月월-]\s*(\d{1,2})/u.exec(s))) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i.exec(s))) [m, d, y] = [monthNumber(r[1]), +r[2], +r[3]];
  else if ((r = /^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})/i.exec(s))) [d, m, y] = [+r[1], monthNumber(r[2]), +r[3]];
  else return undefined;
  if (!m || m > 12 || y < 2004 || y > 2100 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** A date written the way post wrappers write it ("March 5, 2026", "on 5 March 2026", "2026年3月5日") → 'YYYY-MM-DD'. */
export function postingDay(text: string | undefined): string | undefined {
  return postDate(text?.trim().replace(/^(?:on|於|于)\s*/i, ''));
}

// Sites whose previews name the account in the title and wrap the post in likes / comments / date.
const POST_HOSTS = ['instagram.com', 'instagr.am', 'facebook.com', 'fb.com', 'fb.watch', 'threads.net', 'threads.com', 'tiktok.com', 'x.com', 'twitter.com', 'bsky.app'];

/** A link to a social post (Instagram, Facebook, Threads, TikTok, X, Bluesky), whose preview texts this module reads. */
export function isPostLink(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return POST_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Tidies a caption: trimmed lines, no runs of blank lines. */
function tidyCaption(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t || undefined;
}

/** The caption without the quotes the description wraps it in (the closing one is missing when it was cut short). */
function unquote(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (!LEAD_QUOTE_RE.test(s)) return tidyCaption(s);
  return tidyCaption(s.replace(LEAD_QUOTE_RE, '').replace(TRAIL_QUOTE_RE, ''));
}

/** Drops undefined fields, so results compare and spread cleanly. */
function info(fields: PostInfo): PostInfo {
  const out: PostInfo = {};
  for (const [k, v] of Object.entries(fields) as [keyof PostInfo, string | undefined][]) if (v) (out as Record<string, string>)[k] = v;
  return out;
}

const cleanName = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() || undefined;

/**
 * A social post's og:description: Instagram's '1,234 likes, 56 comments - handle on March 5, 2026: "Caption"'
 * (also without the counts, without a caption, and in Chinese / Japanese / Korean), the older
 * '… - Name (@handle) on Instagram: "Caption"' and TikTok's 'TikTok video from Name (@handle): "Caption"'.
 * Undefined when the text isn't one.
 */
export function parsePostDescription(text: string): PostInfo | undefined {
  if (!text || text.length < 8) return undefined;
  let m = IG_RE.exec(text);
  if (m) {
    const [, counts, handle, date, rest] = m;
    // Without the counts, only a quoted caption makes it a post ("Updated on March 5, 2026: …" isn't).
    if (!counts && !(rest && LEAD_QUOTE_RE.test(rest))) return undefined;
    return info({ caption: unquote(rest), handle, publishedAt: postDate(date) });
  }
  m = ON_IG_RE.exec(text);
  if (m) {
    const [, counts, name, handle, bareHandle, plainName, rest] = m;
    if (!counts && !(rest && LEAD_QUOTE_RE.test(rest))) return undefined;
    return info({ caption: unquote(rest), author: cleanName(name ?? plainName), handle: handle ?? bareHandle });
  }
  m = TIKTOK_RE.exec(text);
  if (m) {
    const [, name, handle, rest] = m;
    const quoted = TIKTOK_QUOTED_RE.exec(rest);
    return info({ caption: quoted ? tidyCaption(quoted[1]) : unquote(rest), author: cleanName(name), handle, kind: 'video' });
  }
  return undefined;
}

/**
 * A social post's og:title: "Name (@handle) • Instagram reel", "Instagram reel", 'Name on Instagram: "Caption"',
 * "Name (@handle) on Threads", "… | By Name | Facebook" and the like. Undefined for any other title.
 */
export function parsePostTitle(title: string): PostInfo | undefined {
  const t = title?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  let m = TIKTOK_RE.exec(t);
  if (m) {
    const quoted = TIKTOK_QUOTED_RE.exec(m[3]);
    return info({ caption: quoted ? tidyCaption(quoted[1]) : unquote(m[3]), author: cleanName(m[1]), handle: m[2], kind: 'video' });
  }
  if ((m = ACCOUNT_TITLE_RE.exec(t))) return info({ author: cleanName(m[1]), handle: m[2], kind: kindOf(m[3]) });
  if ((m = ON_IG_RE.exec(t)) && (m[3] || m[4] || m[6])) {
    const [, , name, handle, bareHandle, plainName, rest] = m;
    return info({ caption: unquote(rest), author: cleanName(name ?? plainName), handle: handle ?? bareHandle });
  }
  if ((m = PLATFORM_TITLE_RE.exec(t)) && (!m[1] || kindOf(m[1]) || /^photos and videos$/i.test(m[1]))) return info({ kind: kindOf(m[1]) });
  if ((m = POST_BY_TITLE_RE.exec(t))) {
    const who = m[2].trim();
    return info({
      kind: kindOf(m[1]),
      author: who.startsWith('@') ? undefined : cleanName(who),
      handle: who.startsWith('@') ? who.slice(1) : undefined,
      publishedAt: postDate(m[3]),
    });
  }
  if ((m = FB_TITLE_RE.exec(t))) return info({ caption: unquote(m[1]), author: cleanName(m[2]) });
  if ((m = FB_BY_TITLE_RE.exec(t))) return info({ kind: kindOf(m[1]), author: cleanName(m[2]) });
  if ((m = ON_PLATFORM_TITLE_RE.exec(t))) {
    const who = m[1].trim();
    return info({
      caption: unquote(m[2].replace(/\s*\/\s*(?:X|Twitter)$/i, '')),
      author: who.startsWith('@') ? undefined : cleanName(who),
      handle: who.startsWith('@') ? who.slice(1) : undefined,
    });
  }
  return undefined;
}

/**
 * True for titles that only name an account or platform ("Name (@handle) • Instagram reel", "Instagram reel",
 * "Facebook", "Login • Instagram"…), and for no title at all: a title made from the caption reads better.
 */
export function isBoilerplateTitle(title: string | undefined): boolean {
  const t = title?.replace(/\s+/g, ' ').trim();
  if (!t) return true;
  const post = parsePostTitle(t);
  if (post) return !post.caption;
  const bare = t.replace(PLATFORM_AFFIX_RE, '').trim();
  return !bare || WALL_TITLE_RE.test(bare);
}

// Cheap pre-check before the per-line work: post wrappers carry counts, an account or a quoted caption after a date.
const MAYBE_POST_RE = /likes?\b|comments?\b|[讚赞]|留言|评论|評論|回應|いいね|좋아요|\(@|instagram|threads|tiktok|facebook|\d{4}[日일]?\s*[:：]\s*["“”「『]/i;
const TIKTOK_TRAILER_RE = /["”“]\s*[.。]?\s+(?:original sound|♬)[^"“”]*$/i;

/** What follows a post wrapper at the start of a line ("" when the line is only the wrapper); undefined when it has none. */
function afterPostHead(line: string): string | undefined {
  let m = IG_RE.exec(line);
  // Without the counts or a quoted caption it's just a sentence ("Party on March 5, 2026: bring snacks").
  if (m) return m[1] || (m[4] && LEAD_QUOTE_RE.test(m[4])) ? (m[4] ?? '') : undefined;
  m = ON_IG_RE.exec(line);
  if (m) return m[1] || (m[6] && LEAD_QUOTE_RE.test(m[6])) ? (m[6] ?? '') : undefined;
  if ((m = TIKTOK_RE.exec(line))) return m[3].replace(TIKTOK_TRAILER_RE, '');
  return undefined;
}

/**
 * The text with posts' engagement / publish-date wrappers taken off ("1,234 likes, 56 comments - chef on
 * March 5, 2026: "…"" keeps only the caption), and lines that only name an account ("Name (@handle) •
 * Instagram reel") left out, so the publish date and the account's name don't pass for an event date or a
 * place. Anything else comes back unchanged.
 */
export function stripPostBoilerplate(text: string): string {
  if (!text || !MAYBE_POST_RE.test(text)) return text;
  const lines = text.split('\n');
  let changed = false;
  // A caption's closing quote (with Instagram's full stop) can be lines further down.
  let quoteOpen = false;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let rest = afterPostHead(line);
    if (rest !== undefined) {
      quoteOpen = LEAD_QUOTE_RE.test(rest);
      rest = rest.replace(LEAD_QUOTE_RE, '');
      if (quoteOpen && (i === lines.length - 1 ? TRAIL_QUOTE_RE : CLOSING_QUOTE_RE).test(rest)) {
        rest = rest.replace(TRAIL_QUOTE_RE, '');
        quoteOpen = false;
      }
      changed = true;
      if (rest.trim()) out.push(rest);
      continue;
    }
    if (quoteOpen && (i === lines.length - 1 ? TRAIL_QUOTE_RE : CLOSING_QUOTE_RE).test(line)) {
      out.push(line.replace(TRAIL_QUOTE_RE, ''));
      quoteOpen = false;
      continue;
    }
    if (line.length <= 140 && /\(@[\w.]{1,30}\)|instagram|threads|facebook|tiktok/i.test(line)) {
      const post = parsePostTitle(line);
      if (post && !post.caption) {
        changed = true;
        continue;
      }
    }
    out.push(line);
  }
  return changed ? out.join('\n') : text;
}

// ---------------------------------------------------------------------------
// Caption → title

// Wide characters (CJK, kana, hangul, full-width forms, emoji) take two columns.
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}\p{Extended_Pictographic}]/u;
const ZERO_RE = /[\p{M}\u200d\ufe0e\ufe0f\p{Emoji_Modifier}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFF60\uA000-\uA4CF]/u;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/u;
const SPACE_RE = /[ \t\u00a0\u3000]/;
const LETTER_RE = /[\p{L}\p{N}]/u;

function cpWidth(c: string): number {
  if (ZERO_RE.test(c)) return 0;
  return WIDE_RE.test(c) ? 2 : 1;
}

function width(s: string): number {
  let w = 0;
  for (const c of s) w += cpWidth(c);
  return w;
}

const OPENERS = new Set(['（', '(', '【', '「', '『', '《', '〈', '[', '〔']);
const CLOSERS = new Set(['）', ')', '】', '」', '』', '》', '〉', ']', '〕']);
const ENDERS = new Set(['。', '！', '？', '!', '?', '‼', '⁉', '｡']);
const AFTER_END = new Set([...CLOSERS, '"', '”', '’', "'", '｣']);
const CLAUSE = new Set(['，', '、', '；', ';', '：', ':', ',']);
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'etc', 'no', 'jr', 'sr', 'mt', 'ft', 'inc', 'ltd', 'co', 'eg', 'ie', 'approx', 'ave', 'rd', 'feat']);

// Where a new part starts, checked at whitespace: section dividers, separators, list items, labelled fields, 📍.
const DIVIDER_RE = /\s*(?:[-–—_=~～*]\s*){3,}/y;
const SEPARATOR_RE = /\s+[/|¦•·‧]\s+|\s*｜\s*|\s+[-–—]{1,2}\s+/y;
const LIST_ITEM_RE = /\s+(?=\d{1,2}[.)、](?!\d)|[①-⑳❶-❿➀-➓]|[•●▪◦‣・✔✅☑✓]|\d\ufe0f?\u20e3)/y;
const LIST_NUMBER_BEFORE_RE = /(?:^|\s)\d{1,2}$/;
const FIELD = String.raw`地址|地點|地点|位置|日期|時間|时间|開放時間|开放时间|營業時間|营业时间|電話|电话|票價|票价|門票|门票|價錢|价钱|交通|網址|网址|Address|Location|Venue|Dates?|Time|Hours|Opening hours|Tel|Phone|Price|Tickets?|Website|Directions|Info|Credits?|Photos?(?: by)?|圖片來源|影片來源|圖源|來源`;
const FIELD_START_RE = new RegExp(String.raw`\s+(?=📍|📌|(?:${FIELD})\s*[:：])`, 'iy');
const PINS = new Set(['📍', '📌']);

// Calls to action and promo lines: "Comment 'recipe'…", "留言「酒店」我send俾你", "請Follow…", "優惠碼…".
const CALL_TO_ACTION = [
  String.raw`^(?:new (?:video|post|reel|episode)|link in (?:my )?bio|swipe|save (?:this|for later)|follow (?:me|us|for more)|please (?:follow|share|subscribe|like)|tag (?:a|your) (?:friend|bestie)|comment below|watch (?:till|until) the end)\b`,
  String.raw`^(?:留言|comment\b|請?follow\b|追蹤|追踪|關注|关注|點擊|点击|tap\b|click\b)`,
  String.raw`優惠碼|优惠码|折扣碼|折扣码|discount code|promo code|coupon code|link in (?:my )?bio|連結在|链接在|簡介連結|限動精選`,
];
const CALL_TO_ACTION_RE = new RegExp(CALL_TO_ACTION.join('|'), 'i');
/** Parts that make poor titles when something better follows. */
const LOW_INFO_RE = new RegExp(
  [
    ...CALL_TO_ACTION,
    // "EP 15", "Part 2", "Part 4 is live!", "第3集"
    String.raw`^(?:ep(?:isode)?|parts?|pt|day|vol(?:ume)?|chapter|ch|no|#|第)\.?\s*\d+(?:\s*(?:and|&|[-–/,、])\s*\d+)*\s*(?:集|話|话|回|天|篇|部)?(?:\s+(?:is|are)\s+(?:up|out|here|live|now live))?\s*[!！.。]*$`,
    // "Which one would you choose??"
    String.raw`^(?:who|which|what)\b[^.!?]{0,30}\byou\b[^.!?]{0,20}\?+$`,
    String.raw`^(?:${FIELD})\s*[:：]`,
    // An aside in brackets: "(link in the shop tab)"
    String.raw`^[（(\[][^（()）\[\]]*[）)\]]$`,
  ].join('|'),
  'i',
);

const MATH_ALNUM_RE = /[\u{1D400}-\u{1D7FF}]/gu;
const INVISIBLE_RE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
// A link, and a short label leading up to it ("Full story: https://…", "全文：https://…").
const URL_RE = /(?:[^\s:：]{1,10} ?[:：] *)?\b(?:https?:\/\/|www\.)[^\s<>"'`\u3000-\u303F\uFF00-\uFFEF]+/giu;
const MENTION_RE = /(^|[^\w.@])@[\w.]{1,30}/gu;
const HASHTAG_RUN_RE = /(?:[#＃][\p{L}\p{N}_]+[ \t,，]*){2,}/gu;
const LINE_END_HASHTAG_RE = /(?<![ \t])[ \t]*[#＃][\p{L}\p{N}_]+[ \t]*$/gmu;
// Douyin / RedNote share wrappers: "看看【小明的作品】…".
const WORKS_RE = /(?:看看\s*)?【[^】]{1,30}的作品】/gu;
const SCAN_MAX = 1500;

const LEAD_JUNK_RE =
  /^(?:[\s\p{S}\p{Pd}\u200d\ufe0f\u20e3*•·・,，、。.:：;；!！?？/|｜_\\]|\d\ufe0f?\u20e3|\d{1,2}[.)、](?=\s*\D)|[#＃][\p{L}\p{N}_]+(?=\s*(?:[\p{S}\p{Pd}:：|｜#＃]|$))|[（(][^（()）]{0,40}[）)](?=\s*\S))+/u;
const TRAIL_JUNK_RE = /[\s\p{S}\p{Pd}\u200d\ufe0f\u20e3*•·・,，、。.:：;；/|｜_\\]/u;
const KEEP_AT_END = new Set(['～', '~', '…', '⋯', '!', '！', '?', '？']);
const EMOJI_BEFORE_END_RE = /(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f]|\s)+([!?！？]+)$/u;

const DANGLING_RE = /(?:\s+(?:with|from|by|at|to|and|&|feat\.?|ft\.?|via|x|×|thanks to))+$/i;

/** A part of a caption as a title: no leading bullets, emoji or hashtags, no trailing emoji or punctuation. */
function tidy(s: string): string {
  let t = s.replace(/\s+/g, ' ').replace(LEAD_JUNK_RE, '');
  t = t.replace(/[#＃](?=[\p{L}\p{N}_])/gu, '');
  const chars = Array.from(t);
  while (chars.length && TRAIL_JUNK_RE.test(chars[chars.length - 1]) && !KEEP_AT_END.has(chars[chars.length - 1])) chars.pop();
  t = chars.join('');
  if (/[!?！？]$/.test(t)) t = t.replace(EMOJI_BEFORE_END_RE, '$1');
  t = t
    .replace(/\s+([,，、。！？!?:：;；)）」』】》])/gu, '$1')
    .replace(/([(（「『【《])\s+/gu, '$1')
    .replace(/(?<![(（「『【《“"])[(（「『【《“"]+$/u, '')
    .trim();
  // Words left dangling by a dropped @mention: "Haul from @shop" → "Haul".
  if (t.includes(' ')) t = t.replace(DANGLING_RE, '');
  return LETTER_RE.test(t) ? t : '';
}

const WEAK = 0;
const MEDIUM = 1;
const SEPARATOR = 2;
const HARD = 3;
/** Before a list item ("… 2. Osaka"): a title never runs on into one. */
const LIST = 4;

interface Token {
  start: number;
  /** Where its own text ends (before the boundary). */
  cut: number;
  /** Where the next token starts. */
  end: number;
  /** How strong the break after it is. */
  boundary: number;
}

const charAt = (s: string, i: number) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : '');
const charBefore = (s: string, i: number) => {
  if (i <= 0) return '';
  const lo = s.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s.charAt(i - 1);
};

function emojiRunEnd(s: string, i: number): number {
  let j = i;
  for (;;) {
    const c = charAt(s, j);
    if (!c) return j;
    if (EMOJI_RE.test(c) || (/\d/.test(c) && /^\ufe0f?\u20e3/.test(s.slice(j + 1, j + 3)))) j += c.length;
    else return j;
  }
}

function abbreviationBefore(s: string, i: number): boolean {
  const m = /([A-Za-z]+)$/.exec(s.slice(Math.max(0, i - 12), i));
  return !!m && (m[1].length === 1 || ABBREVIATIONS.has(m[1].toLowerCase()));
}

/** Splits a caption into short parts at sentence ends, separators, emoji and the spaces between CJK phrases. */
function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let start = 0;
  let depth = 0;
  let openAt = 0;
  const push = (cut: number, end: number, boundary: number) => {
    if (end <= start && cut <= start) return;
    tokens.push({ start, cut, end, boundary });
    start = end;
  };
  const sticky = (re: RegExp, i: number) => {
    re.lastIndex = i;
    const m = re.exec(s);
    return m ? i + m[0].length : -1;
  };
  for (let i = 0; i < s.length; ) {
    const c = charAt(s, i);
    if (c === '\n') {
      push(i, i + 1, HARD);
      depth = 0;
      i++;
      continue;
    }
    if (OPENERS.has(c)) {
      if (!depth) openAt = i;
      depth++;
      i += c.length;
      continue;
    }
    if (CLOSERS.has(c)) {
      if (depth) depth--;
      i += c.length;
      continue;
    }
    if (depth && i - openAt > 80) depth = 0; // never closed
    if (depth) {
      i += c.length;
      continue;
    }
    if (ENDERS.has(c) && (CJK_RE.test(c) || !/[A-Za-z0-9]/.test(charAt(s, i + 1)))) {
      let j = i + c.length;
      for (let n = charAt(s, j); n && (ENDERS.has(n) || AFTER_END.has(n) || EMOJI_RE.test(n)); n = charAt(s, j)) j += n.length;
      const cut = j;
      while (SPACE_RE.test(charAt(s, j))) j++;
      push(cut, j, HARD);
      i = j;
      continue;
    }
    // "2. " after a space is a list number (split off before it), not a sentence's end.
    if (c === '.' && SPACE_RE.test(charAt(s, i + 1)) && LETTER_RE.test(charBefore(s, i)) && !abbreviationBefore(s, i) && !LIST_NUMBER_BEFORE_RE.test(s.slice(Math.max(0, i - 3), i))) {
      let j = i + 1;
      while (SPACE_RE.test(charAt(s, j))) j++;
      const next = charAt(s, j);
      if (!next || /[\p{Lu}\p{N}"“'‘(（「【《#]/u.test(next) || CJK_RE.test(next) || EMOJI_RE.test(next)) {
        push(i + 1, j, HARD);
        i = j;
        continue;
      }
    }
    if (PINS.has(c) && i > start) {
      push(i, i, HARD);
      i += c.length;
      continue;
    }
    if (SPACE_RE.test(c) || /[-–—_=~～*｜]/.test(c)) {
      let j: number;
      if ((j = sticky(DIVIDER_RE, i)) > 0) push(i, j, HARD);
      else if ((j = sticky(SEPARATOR_RE, i)) > 0) push(i, j, SEPARATOR);
      else if (SPACE_RE.test(c) && (j = sticky(LIST_ITEM_RE, i)) > 0) push(i, j, LIST);
      else if (SPACE_RE.test(c) && (j = sticky(FIELD_START_RE, i)) > 0) push(i, j, HARD);
      else if (SPACE_RE.test(c)) {
        j = i + 1;
        while (SPACE_RE.test(charAt(s, j))) j++;
        if (CJK_RE.test(charBefore(s, i)) || CJK_RE.test(charAt(s, j))) push(i, j, WEAK);
      } else j = i + 1;
      i = Math.max(j, i + 1);
      continue;
    }
    if (EMOJI_RE.test(c)) {
      const runEnd = emojiRunEnd(s, i);
      const next = charAt(s, runEnd);
      if (!next || SPACE_RE.test(next) || CJK_RE.test(next)) {
        let j = runEnd;
        while (SPACE_RE.test(charAt(s, j))) j++;
        push(runEnd, j, MEDIUM);
        i = j;
      } else i = Math.max(runEnd, i + c.length);
      continue;
    }
    i += c.length;
  }
  push(s.length, s.length, HARD);

  // Parts with no words (a lone emoji, a stray symbol) join a neighbour.
  const merged: Token[] = [];
  for (const t of tokens) {
    const empty = !LETTER_RE.test(s.slice(t.start, t.cut));
    const prev = merged[merged.length - 1];
    if (empty && prev) {
      prev.cut = t.cut;
      prev.end = t.end;
      prev.boundary = Math.max(prev.boundary, t.boundary);
    } else if (prev && !LETTER_RE.test(s.slice(prev.start, prev.cut))) {
      prev.cut = t.cut;
      prev.end = t.end;
      prev.boundary = t.boundary;
    } else merged.push({ ...t });
  }
  return merged;
}

interface Cut {
  text: string;
  /** 'clause' at punctuation, a bracket or a phrase break; 'word' at a space; 'hard' anywhere. */
  at: 'clause' | 'word' | 'hard';
}

/** Shortens `s` to at most `budget` wide (plus an ellipsis), at a clause or phrase break, else a word, else anywhere. */
function cutTo(s: string, budget: number): Cut {
  const cps = Array.from(s);
  let w = 0;
  let clause = 0;
  let clauseW = 0;
  let word = 0;
  let wordW = 0;
  let hard = 0;
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    const cw = cpWidth(c);
    if (w + cw > budget) break;
    w += cw;
    const next = cps[i + 1] ?? '';
    if (!ZERO_RE.test(next)) hard = i + 1;
    const phraseBreak =
      (SPACE_RE.test(next) && (CJK_RE.test(c) || CJK_RE.test(cps[i + 2] ?? '') || EMOJI_RE.test(c))) ||
      (EMOJI_RE.test(c) && !ZERO_RE.test(next) && !EMOJI_RE.test(next) && CJK_RE.test(next));
    if (CLAUSE.has(c) || CLAUSE.has(next) || CLOSERS.has(c) || OPENERS.has(next) || phraseBreak) [clause, clauseW] = [i + 1, w];
    else if (SPACE_RE.test(next)) [word, wordW] = [i + 1, w];
  }
  const pick = (end: number, at: Cut['at']): Cut => ({ text: tidy(cps.slice(0, end).join('')), at });
  let cut: Cut | undefined;
  if (clause && clauseW >= budget * 0.5) cut = pick(clause, 'clause');
  else if (word && wordW >= budget * 0.6) cut = pick(word, 'word');
  else if (clause && clauseW >= budget * 0.3) cut = pick(clause, 'clause');
  if (!cut?.text) cut = pick(hard, 'hard');
  return cut;
}

const withEllipsis = (s: string) => (s ? `${s.replace(/[…⋯]+$/u, '')}…` : s);

/** Before the caption is split: no links, @mentions, hashtag runs or share-app wrappers. */
function prepare(caption: string): string {
  const s = caption.length > SCAN_MAX ? caption.slice(0, SCAN_MAX) : caption;
  return s
    .replace(MATH_ALNUM_RE, (c) => c.normalize('NFKC'))
    // ".ᐟ" is a decorative "!".
    .replace(/\.?ᐟ/gu, '!')
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(WORKS_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(MENTION_RE, '$1 ')
    .replace(HASHTAG_RUN_RE, ' ')
    .replace(LINE_END_HASHTAG_RE, '');
}

/**
 * A short, recognisable title from a post's caption: its first meaningful sentence or line, split the CJK way
 * too (。！？, line breaks, " / ", " | ", emoji between phrases), without hashtags, @mentions, links or trailing
 * emoji, keeping 【】 headings. Openers like "EP 15 |", "Part 2 is up!" or "Comment 'link'…" are skipped
 * when a better part follows. `max` is in display width (CJK and emoji count double), cut at a clause or word.
 */
export function captionTitle(caption: string, max = 70): string | undefined {
  if (!caption?.trim()) return undefined;
  const s = prepare(caption);
  const tokens = tokenize(s);
  if (!tokens.length) return undefined;
  const text = (from: number, to: number) => tidy(s.slice(tokens[from].start, tokens[to].cut));
  const tokenText = tokens.map((_, i) => text(i, i));
  // A phrase runs from one emoji, separator or sentence break to the next.
  const phraseEnd = (i: number) => {
    let j = i;
    while (j < tokens.length - 1 && tokens[j].boundary === WEAK) j++;
    return j;
  };
  const startsPhrase = (i: number) => i === 0 || tokens[i - 1].boundary !== WEAK;
  const phraseText = (i: number) => text(i, phraseEnd(i));

  let first = -1;
  for (let i = 0; i < tokens.length && first < 0; i++) {
    if (!startsPhrase(i)) continue;
    const p = phraseText(i);
    if (p && !LOW_INFO_RE.test(p)) first = i;
  }
  if (first < 0) first = tokenText.findIndex(Boolean);
  if (first < 0) return undefined;

  let title = tokenText[first];
  for (let j = first + 1; j < tokens.length; j++) {
    const boundary = tokens[j - 1].boundary;
    if (boundary === LIST) break;
    const w = width(title);
    // A full sentence, or a phrase long enough, is a title.
    if (boundary === HARD && w >= 16) break;
    if ((boundary === MEDIUM || boundary === SEPARATOR) && w >= 24) break;
    if (!tokenText[j]) continue;
    // Within a phrase only a call to action stops it ("Kyoto / 京都 Please follow"); "Ep.9" after a name is fine.
    if (boundary === WEAK ? CALL_TO_ACTION_RE.test(tokenText[j]) : LOW_INFO_RE.test(phraseText(j))) break;
    const joined = text(first, j);
    if (width(joined) <= max) {
      title = joined;
      continue;
    }
    if (boundary === WEAK) {
      // Mid-sentence: stop at this phrase break, or cut further along when that leaves too little.
      title = w >= max / 2 && w < max ? withEllipsis(title) : withEllipsis(cutTo(joined, max - 1).text);
    } else {
      const c = cutTo(joined, max - 1);
      if (c.at !== 'hard' && width(c.text) > w) title = withEllipsis(c.text);
    }
    return title || undefined;
  }
  if (width(title) > max) title = withEllipsis(cutTo(title, max - 1).text);
  return title || undefined;
}

/** The regexes worth compiling ahead of the first post (see warmup.ts). */
export function warmRegExps(): RegExp[] {
  return [
    MAYBE_POST_RE,
    IG_RE,
    ON_IG_RE,
    TIKTOK_RE,
    ACCOUNT_TITLE_RE,
    PLATFORM_TITLE_RE,
    POST_BY_TITLE_RE,
    FB_TITLE_RE,
    FB_BY_TITLE_RE,
    ON_PLATFORM_TITLE_RE,
    WALL_TITLE_RE,
    PLATFORM_AFFIX_RE,
    WIDE_RE,
    CJK_RE,
    EMOJI_RE,
    LOW_INFO_RE,
    CALL_TO_ACTION_RE,
    LIST_NUMBER_BEFORE_RE,
  ];
}
