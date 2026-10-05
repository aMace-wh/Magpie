import { classify, normalizeTag, type Confidence } from './classify';
import { placeCandidates, type PlaceCandidate } from './location';
import type { LinkPreview } from './metadata';
import { captionTitle, isBoilerplateTitle, isPostLink, parsePostDescription, parsePostTitle, postingDay, stripPostBoilerplate, type PostInfo } from './postText';
import type { EditedField, Item, ItemType, Place, When } from './types';
import { findWhen } from './when';

/**
 * What a save is about, worked out offline from what's stored with it and its link preview: a title from the
 * post's caption instead of the account's name, a better kind, an event date (never the day it was posted) and
 * places worth looking up. Used when a preview comes in (enrich.ts) and to look again at older saves (backfill.ts).
 */

/** Bumped when the analysis improves enough to be worth running again on saves analysed before. */
export const ANALYSIS_VERSION = 1;

/** Kinds that only say where a link came from: a caption can say better. */
export const GENERIC_TYPES: ReadonlySet<ItemType> = new Set<ItemType>(['link', 'video', 'note']);

export interface SaveInput {
  url?: string;
  /** Platform the save came from (Item.source). */
  source?: string;
  title?: string;
  type?: ItemType;
  sharedText?: string;
  note?: string;
  when?: When;
  place?: Place;
  author?: string;
  /** What the user set by hand (Item.edited): the analysis suggests no change to it. */
  edited?: EditedField[];
}

export interface SaveAnalysis {
  /** A better title, only when the current one is automatic (an account or platform name, or none). */
  title?: string;
  /** The kind the save should have: its current kind unless that's generic (or came from the posting date). */
  type: ItemType;
  /** How sure the text analysis is of `type`. */
  confidence: Confidence;
  tags: string[];
  /** An event date from the text, when the save has none (or only had the posting date). Never one the user cleared. */
  when?: When;
  /** How clear that date is: 'high' for a full date, lower for "this Saturday" (only taken for events). */
  whenConfidence?: Confidence;
  /** The save's date was read from the post's "… on March 5, 2026" line, the day it went up: drop it. */
  dropWhen?: boolean;
  /** Places worth searching for, best first. */
  candidates: PlaceCandidate[];
  /** Who posted it: their display name, or "@handle". */
  author?: string;
  /** When it was posted, 'YYYY-MM-DD'. */
  publishedAt?: string;
  /** The post's own words, when the description wraps them in likes / comments / date. */
  caption?: string;
}

// ---------------------------------------------------------------------------
// Text helpers

const URLS_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const DATE_LEAD_RE = /(?:[ \t]+(?:on|from|until|till|til|this|next)|[ \t]*[,·•|–—-])[ \t]*$/i;

/** The text with its date phrase(s) blanked out, so "📍 Lisbon — Sat 10 Oct" doesn't become a place called "Lisbon, Sat 10 Oct". */
export function withoutDates(text: string, now = new Date()): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const m = findWhen(out, now);
    if (!m) break;
    // Take a joining word or dash in front of it along ("Lisbon on 12 Oct", "Lisbon · Sat 12 Oct").
    const lead = DATE_LEAD_RE.exec(out.slice(0, m.index));
    const start = lead ? lead.index : m.index;
    out = `${out.slice(0, start)}\n${out.slice(m.index + m.length)}`;
  }
  return out;
}

const squash = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** "a…b…c" in order within `s`. */
function inOrder(letters: string, s: string): boolean {
  let at = 0;
  for (const ch of letters) {
    at = s.indexOf(ch, at) + 1;
    if (!at) return false;
  }
  return true;
}

/**
 * A title that is only the account's display name: the author itself, or a short name whose Latin words show up
 * in the handle ("City Bites Daily" for @citybites_daily, "WKD 旅遊" for @weekendtrips_hk). Older saves were
 * titled like that before captions were read.
 */
export function looksLikeAccount(title: string | undefined, author?: string, handle?: string): boolean {
  const t = title?.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const k = squash(t);
  if (!k) return false;
  if (author && squash(author.replace(/^@/, '')) === k) return true;
  if (!handle) return false;
  const h = handle.toLowerCase().replace(/[^a-z]/g, '');
  if (k === squash(handle)) return true;
  if (t.length > 48 || /[.。!！?？:：]$|[!！?？。]/.test(t) || h.length < 3) return false;
  const words = t.normalize('NFKC').match(/[A-Za-z]{3,}/g) ?? [];
  if (!words.length) return false;
  // An all-caps short word is often the account's initials ("WKD" in "weekendtrips").
  const hits = words.filter((w) => h.includes(w.toLowerCase()) || (w.length <= 5 && w === w.toUpperCase() && inOrder(w.toLowerCase(), h)));
  return hits.length * 2 >= words.length;
}

const KIND_WORDS: Record<NonNullable<PostInfo['kind']>, string> = { reel: 'Reel', photo: 'Photo', video: 'Video', post: 'Post' };

function postKindFromUrl(url: string | undefined): PostInfo['kind'] {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname;
    if (/\/(?:reels?|reel_share)\//i.test(path)) return 'reel';
    if (/\/(?:tv|videos?|watch)\//i.test(path)) return 'video';
    if (/\/(?:p|posts?|permalink|photos?)\//i.test(path)) return 'post';
  } catch {
    /* not a URL */
  }
  return undefined;
}

/** "2026-08-15" or "2026-08-15T10:00" is that day. */
const sameDay = (iso: string | undefined, day: string) => !!iso && iso.slice(0, 10) === day;

const POST_SOURCES = new Set(['instagram', 'facebook', 'threads', 'tiktok', 'x', 'bluesky']);

/** A social post (Instagram, Facebook, Threads, TikTok…), whose preview wraps the caption in likes and a date. */
export function isSocialSave(item: Pick<SaveInput, 'url' | 'source'>): boolean {
  return isPostLink(item.url) || (!!item.source && POST_SOURCES.has(item.source));
}

/**
 * The save's date was read from the post's "… on August 15, 2026" line, so it's only the day the post went up
 * (older versions took it for an event date). Told by the phrase it was read from; a lone day with no phrase (shares
 * don't carry it) counts too. Never a date with a time or a span of days, one the caption names itself, or one the
 * user set (see analyzeSave).
 */
function fromPostingLine(when: When | undefined, publishedAt: string | undefined, body: string): boolean {
  if (!when || !publishedAt || !sameDay(when.start, publishedAt) || (when.end && !sameDay(when.end, publishedAt))) return false;
  const source = when.source?.trim();
  if (!source) return when.start.length === 10 && !when.end;
  return postingDay(source) === publishedAt && !squash(body).includes(squash(source));
}

/** Text that adds something to `body` (not already in it). */
function adds(text: string | undefined, body: string): string | undefined {
  const t = text?.trim();
  if (!t) return undefined;
  const k = squash(t);
  return k && !squash(body).includes(k) ? t : undefined;
}

// ---------------------------------------------------------------------------

/**
 * Works out what a save is from what's stored with it and its link preview. Pure and offline. Only suggests
 * changes to what looks automatic, never to what the user set (`item.edited`): `title` only when the current title
 * just names an account or platform, a new `type` only over a generic kind, `when` only when there's no date (or
 * only the posting date, see `dropWhen`).
 */
export function analyzeSave(item: SaveInput, preview: LinkPreview, now: Date = new Date()): SaveAnalysis {
  const userSet = (f: EditedField) => !!item.edited?.includes(f);
  // Only social posts' previews wrap the post: a news site's "LONDON, March 5, 2026: “…”" is just its text.
  const social = isSocialSave(item);
  const description = preview.description?.trim() ?? '';
  const post = social && description ? parsePostDescription(description) : undefined;
  const pageTitle = preview.rawTitle ?? preview.title;
  const fromTitle = social ? (pageTitle && parsePostTitle(pageTitle)) || (item.title ? parsePostTitle(item.title) : undefined) : undefined;
  const caption = preview.caption?.trim() || post?.caption;
  const handle = post?.handle ?? fromTitle?.handle;
  const named = preview.author ?? item.author ?? fromTitle?.author ?? post?.author;
  // The day the post went up, from its own wrapper (a fresh preview brings it along with the caption), never just
  // the date a page says it was published or changed.
  const publishedAt = post?.publishedAt ?? fromTitle?.publishedAt ?? (preview.caption ? preview.publishedAt?.slice(0, 10) : undefined);

  // A title that's the account's name says nothing about the post, and its words (a creator's bio, a city in
  // their name) would only mislead the analysis.
  const accountTitle = (t: string | undefined) => !t || isBoilerplateTitle(t) || (social && looksLikeAccount(t, named, handle));
  const autoTitle = !userSet('title') && accountTitle(item.title);
  const author = named ?? (autoTitle && item.title && !isBoilerplateTitle(item.title) && handle ? item.title.trim() : undefined) ?? (handle ? `@${handle}` : undefined);

  const body = caption ?? (description && social ? stripPostBoilerplate(description) : description);
  const titleText = [item.title, pageTitle].find((t) => !accountTitle(t) && adds(t, body));
  const shared = adds(item.sharedText?.replace(URLS_RE, ' ').replace(/\s+/g, ' '), body);
  const note = item.note?.trim();
  const rest = [body, shared, note].filter(Boolean).join('\n');
  const text = [titleText, rest].filter(Boolean).join('\n');

  // Kind: the caption's evidence, over a generic kind. An "event" whose only date was the posting day was very
  // likely filed as one because of that date: it gets a second look too.
  const c = classify({ title: titleText ?? '', text: rest, url: item.url });
  const candidates = text ? placeCandidates(withoutDates(text, now)) : [];
  let suggested = c.type;
  let confidence = c.confidence;
  const top = candidates[0];
  // A pinned venue or address ("📍 …", "地址：…") on a post that's otherwise just a video: a place to go.
  if ((GENERIC_TYPES.has(suggested) || confidence === 'low') && top?.marked && !top.area && top.countryCode) {
    suggested = 'place';
    confidence = 'medium';
  }
  // Dates: the text has no posting date left in it, so a date it names is a real one, even on the posting day.
  const postingDate = !userSet('when') && fromPostingLine(item.when, publishedAt, body);
  const date = (!item.when || postingDate) && !userSet('when') && text ? findWhen(text, now) : undefined;
  const current = item.type;
  const replaceable = !userSet('type') && (!current || GENERIC_TYPES.has(current) || (current === 'event' && postingDate && !date));
  let type: ItemType = current ?? suggested;
  if (replaceable && current && suggested !== current && confidence !== 'low' && !(current === 'event' && GENERIC_TYPES.has(suggested))) type = suggested;

  const out: SaveAnalysis = { type, confidence, tags: c.tags, candidates };
  if (author) out.author = author;
  if (publishedAt) out.publishedAt = publishedAt;
  if (caption) out.caption = caption;

  // A title from the caption, else the page's own; for a post with neither, "Reel by Mei" beats "Instagram reel".
  if (autoTitle) {
    const kind = fromTitle?.kind ?? postKindFromUrl(item.url);
    const page = preview.title && !accountTitle(preview.title) ? preview.title : undefined;
    const better =
      (caption ? captionTitle(caption) : undefined) ??
      page ??
      (post && author && kind && isBoilerplateTitle(item.title) ? `${KIND_WORDS[kind]} by ${author}` : undefined);
    if (better && better !== item.title) out.title = better;
  }

  // A clear date, or any for an event.
  if (postingDate) out.dropWhen = true;
  if (date && (date.confidence === 'high' || type === 'event')) {
    out.when = date.when;
    out.whenConfidence = date.confidence;
  }
  return out;
}

/** The save's tags plus new ones (normalised, no repeats), up to 6 unless it already had more. */
export function mergeTags(have: string[], add: string[]): string[] {
  const out: string[] = [];
  for (const t of [...have, ...add]) {
    const n = normalizeTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, Math.max(have.length, 6));
}

/**
 * Whether a save's place candidates are worth a lookup: any pinned one ("📍 …", "地址：…"), or the best one for
 * a place or event (a shop or mall for a product). Only with a country to check the answer against.
 */
export function shouldLocate(type: ItemType, candidates: PlaceCandidate[]): boolean {
  const top = candidates[0];
  if (!top?.countryCode) return false;
  if (candidates.some((c) => c.marked && c.countryCode)) return true;
  if (type === 'place' || type === 'event') return true;
  return type === 'product' && !top.area;
}

const wrapped = (item: Pick<Item, 'description'>) => !!item.description && !!parsePostDescription(item.description);

/**
 * Whether a stored save still looks the way Magpie filled it in, so looking again may change its title, kind, date
 * and place: a social post whose title only names the account, or whose description still has the likes / date
 * wrapper the preview gave it. Saves analysed since also keep a record of what the user changed (Item.edited).
 */
export function looksAutomatic(item: Pick<Item, 'url' | 'source' | 'title' | 'description' | 'analyzed'>): boolean {
  return isSocialSave(item) && (!!item.analyzed || isBoilerplateTitle(item.title) || wrapped(item));
}

/**
 * Whether a save's title is one Magpie made and may replace: just an account or platform name ("Mei (@mei) •
 * Instagram reel"), or on an older social save, the account's display name it was titled with before captions
 * were read (analyzeSave then offers a better one). Never a title the user typed or changed.
 */
export function automaticTitle(item: Pick<Item, 'url' | 'source' | 'title' | 'description' | 'analyzed' | 'edited'>): boolean {
  if (item.edited?.includes('title')) return false;
  return isBoilerplateTitle(item.title) || (!item.analyzed && isSocialSave(item) && wrapped(item));
}

/** What a stored save's own fields say in place of a fresh link preview (for looking at older saves again). */
export function storedPreview(item: Pick<Item, 'title' | 'description' | 'siteName' | 'author'>): LinkPreview {
  const p: LinkPreview = { title: item.title, rawTitle: item.title };
  if (item.description) p.description = item.description;
  if (item.siteName) p.siteName = item.siteName;
  if (item.author) p.author = item.author;
  return p;
}

/**
 * What looking again at a stored save changes, offline, while it looks automatic (looksAutomatic) and only where
 * the user hasn't set anything (Item.edited): a caption title over an account name, a better kind over a generic
 * one (with its tags), the posting date dropped (and a real date added), the author, and the description without
 * its likes / comments / date wrapper. Places are looked up separately (they need the network).
 */
export function reanalysisChanges(item: Item, a: SaveAnalysis): Partial<Item> {
  const changes: Partial<Item> = {};
  if (!looksAutomatic(item)) return changes;
  const userSet = (f: EditedField) => !!item.edited?.includes(f);
  if (a.title && a.title !== item.title && automaticTitle(item)) changes.title = a.title;
  if (a.type !== item.type && !userSet('type')) {
    changes.type = a.type;
    const tags = userSet('tags') ? item.tags : mergeTags(item.tags, a.tags);
    if (tags.length !== item.tags.length) changes.tags = tags;
  }
  if (!userSet('when')) {
    if (a.dropWhen) changes.when = a.when;
    else if (!item.when && a.when) changes.when = a.when;
  }
  if (!item.author && a.author) changes.author = a.author;
  // "1,234 likes, 56 comments - chef on March 5, 2026: “…”" → just the caption (nothing, when there's none).
  const post = item.description ? parsePostDescription(item.description) : undefined;
  if (post && post.caption !== item.description) changes.description = post.caption;
  return changes;
}

/** Whether looking again at a stored save should look up where it is (a few are, per launch). */
export function wantsLookup(item: Item, a: SaveAnalysis, type: ItemType = a.type): boolean {
  return !item.place && !item.edited?.includes('place') && looksAutomatic(item) && shouldLocate(type, a.candidates);
}
