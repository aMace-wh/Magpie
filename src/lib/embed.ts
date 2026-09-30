import { safeUrl } from './classify';
import type { Item } from './types';

/**
 * The original post, video or track as its platform shows it, plus helpers for the
 * text that was shared with it.
 *
 * Every embed URL is rebuilt from strictly validated ids on a known https host. The
 * saved link itself only ever travels URL-encoded inside a known query parameter,
 * so a crafted link can't steer the player anywhere else.
 */

export type EmbedKind = 'video' | 'audio' | 'post';

export interface Embed {
  /** Platform key, matching Item.source where there is one, e.g. "youtube". */
  provider: string;
  /** Platform name to show, e.g. "YouTube". */
  label: string;
  /** Video player, audio player or a social post card. */
  kind: EmbedKind;
  src: string;
  /** width / height, e.g. 16/9 or 9/16. */
  aspect?: number;
  /** Fixed px height, for audio players and posts. */
  height?: number;
  /** Widest the embed looks right at, in px. */
  maxWidth?: number;
  /** Permissions policy for the iframe's allow attribute. */
  allow?: string;
  /** Portrait video (Shorts, TikTok, Reels). */
  vertical?: boolean;
  /** A thumbnail the platform serves for this id, known without a network call. */
  poster?: string;
}

export interface EmbedOptions {
  /** Host the app is served from. Twitch refuses to play without it, so Twitch is skipped when missing. */
  parentHost?: string;
  /** Matches the app's colour scheme where the platform supports it. */
  theme?: 'light' | 'dark';
}

/** Sandbox for embed iframes: enough for players and "open in app" links, no top navigation. */
export const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation allow-forms';

const VIDEO_ALLOW = 'autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen';
const AUDIO_ALLOW = 'autoplay; encrypted-media; clipboard-write';
const POST_ALLOW = 'autoplay; encrypted-media; picture-in-picture; clipboard-write; fullscreen';

const WIDE = 16 / 9;
const TALL = 9 / 16;

// ---------------------------------------------------------------------------
// Shared bits

type Parser = (u: URL, segs: string[], opts: EmbedOptions) => Embed | undefined;

const enc = encodeURIComponent;

/** A time offset in seconds from "90", "90s", "1m30s", "1h2m3s" or "1:30". */
export function parseStartTime(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  let n: number | undefined;
  if (/^\d{1,6}s?$/.test(s)) n = parseInt(s, 10);
  else if (/^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(s)) n = s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  else {
    const m = s.match(/^(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:(\d{1,5})s)?$/);
    if (m && (m[1] || m[2] || m[3])) n = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  return n && n > 0 && n < 86400 ? n : undefined;
}

/** Start time from ?t= / ?start= / ?time_continue= or a #t= fragment. */
function startOf(u: URL, keys = ['t', 'start', 'time_continue']): number | undefined {
  for (const k of keys) {
    const t = parseStartTime(u.searchParams.get(k));
    if (t) return t;
  }
  const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
  return parseStartTime(hash.get('t') ?? hash.get('start'));
}

function hms(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h${m}m${s}s`;
}

const video = (provider: string, label: string, src: string, extra: Partial<Embed> = {}): Embed => ({
  provider,
  label,
  kind: 'video',
  src,
  aspect: WIDE,
  allow: VIDEO_ALLOW,
  ...extra,
});

const vertical = { aspect: TALL, vertical: true } as const;

// ---------------------------------------------------------------------------
// Providers

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/;
// Path words that happen to be 11 characters long, so they'd pass as a video id.
const YT_NOT_IDS = new Set(['videoseries', 'live_stream']);

const youtube: Parser = (u, segs) => {
  const host = u.hostname;
  const music = host === 'music.youtube.com';
  const [provider, label] = music ? ['youtube-music', 'YouTube Music'] : ['youtube', 'YouTube'];
  let id: string | undefined;
  let shorts = false;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = segs[0];
  } else if (segs[0] === 'watch' || segs.length === 0) {
    id = u.searchParams.get('v') ?? undefined;
  } else if (['shorts', 'live', 'embed', 'v', 'e'].includes(segs[0])) {
    id = segs[1];
    shorts = segs[0] === 'shorts';
  }
  if (id && YT_NOT_IDS.has(id)) id = undefined;
  if (!id) {
    // Playlists: /playlist?list=… or /embed/videoseries?list=…
    const list = u.searchParams.get('list');
    if ((segs[0] === 'playlist' || (segs[0] === 'embed' && segs[1] === 'videoseries')) && list && YT_LIST.test(list)) {
      return video(provider, label, `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`);
    }
    return undefined;
  }
  if (!YT_ID.test(id)) return undefined;
  const start = startOf(u);
  const src = `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`;
  return video(provider, label, src, { poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, ...(shorts ? vertical : {}) });
};

const VIMEO_ID = /^\d{3,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/i;

const vimeo: Parser = (u, segs) => {
  let id: string | undefined;
  let hash: string | undefined;
  if (u.hostname === 'player.vimeo.com') {
    if (segs[0] === 'video') id = segs[1];
  } else if (VIMEO_ID.test(segs[0] ?? '')) {
    id = segs[0];
    hash = segs[1];
  } else if (segs[0] === 'channels' && segs.length === 3) {
    id = segs[2];
  } else if (segs[0] === 'groups' && segs[2] === 'videos' && segs.length === 4) {
    id = segs[3];
  } else if ((segs[0] === 'album' || segs[0] === 'showcase') && segs[2] === 'video' && segs.length === 4) {
    id = segs[3];
  } else if (segs[0] === 'video' && segs.length === 2) {
    id = segs[1];
  }
  if (!id || !VIMEO_ID.test(id)) return undefined;
  hash ??= u.searchParams.get('h') ?? undefined;
  const params = new URLSearchParams();
  if (hash && VIMEO_HASH.test(hash)) params.set('h', hash);
  params.set('dnt', '1');
  const start = startOf(u, ['t']);
  return video('vimeo', 'Vimeo', `https://player.vimeo.com/video/${id}?${params}${start ? `#t=${start}s` : ''}`);
};

const TIKTOK_ID = /^\d{15,21}$/;
const TIKTOK_USER = /^@[\w.-]{1,40}$/;

const tiktok: Parser = (_u, segs) => {
  let id: string | undefined;
  if (TIKTOK_USER.test(segs[0] ?? '') && (segs[1] === 'video' || segs[1] === 'photo')) id = segs[2];
  else if (segs[0] === 'embed') id = segs[1] === 'v2' ? segs[2] : segs[1];
  else if (segs[0] === 'player' && segs[1] === 'v1') id = segs[2];
  else if (segs[0] === 'v') id = segs[1]?.replace(/\.html$/, '');
  if (!id || !TIKTOK_ID.test(id)) return undefined;
  return video('tiktok', 'TikTok', `https://www.tiktok.com/embed/v2/${id}`, vertical);
};

const IG_CODE = /^[A-Za-z0-9_-]{5,40}$/;
const IG_KINDS = ['p', 'reel', 'reels', 'tv'];
const IG_RESERVED = new Set(['audio', 'explore', 'stories', 'accounts', 'direct']);

const instagram: Parser = (_u, segs) => {
  // /p/CODE/, /reel/CODE/ … or the newer /<user>/p/CODE/ form.
  const at = IG_KINDS.includes(segs[0] ?? '') ? 0 : IG_KINDS.includes(segs[1] ?? '') && !IG_RESERVED.has(segs[0]) ? 1 : -1;
  if (at < 0) return undefined;
  const code = segs[at + 1];
  const after = segs[at + 2];
  if (!code || !IG_CODE.test(code) || IG_RESERVED.has(code)) return undefined;
  if (after !== undefined && after !== 'embed' && after !== 'c') return undefined;
  const isVideo = segs[at] !== 'p';
  return {
    provider: 'instagram',
    label: 'Instagram',
    kind: 'post',
    src: `https://www.instagram.com/p/${code}/embed/captioned/`,
    height: 640,
    maxWidth: 540,
    allow: POST_ALLOW,
    vertical: isVideo || undefined,
  };
};

const TWEET_ID = /^\d{5,20}$/;
const X_USER = /^\w{1,15}$/;

const x: Parser = (_u, segs, opts) => {
  let id: string | undefined;
  if (segs[0] === 'i' && segs[1] === 'web' && segs[2] === 'status') id = segs[3];
  else if (segs[0] === 'i' && segs[1] === 'status') id = segs[2];
  else if (X_USER.test(segs[0] ?? '') && (segs[1] === 'status' || segs[1] === 'statuses')) id = segs[2];
  if (!id || !TWEET_ID.test(id)) return undefined;
  const theme = opts.theme === 'dark' ? '&theme=dark' : '';
  return {
    provider: 'x',
    label: 'X',
    kind: 'post',
    src: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true${theme}`,
    height: 520,
    maxWidth: 550,
    allow: POST_ALLOW,
  };
};

const THREADS_CODE = /^[A-Za-z0-9_-]{5,40}$/;
const THREADS_USER = /^@[\w.]{1,30}$/;

const threads: Parser = (_u, segs) => {
  const [user, post, code] = segs;
  if (!user || !THREADS_USER.test(user) || post !== 'post' || !code || !THREADS_CODE.test(code)) return undefined;
  return {
    provider: 'threads',
    label: 'Threads',
    kind: 'post',
    src: `https://www.threads.com/${user}/post/${code}/embed/`,
    height: 560,
    maxWidth: 540,
    allow: POST_ALLOW,
  };
};

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_TYPES = ['track', 'album', 'playlist', 'episode', 'show', 'artist'];

const spotify: Parser = (_u, raw) => {
  let segs = raw;
  if (/^intl-[a-z]{2}(?:-[a-z0-9]{2,4})?$/i.test(segs[0] ?? '')) segs = segs.slice(1);
  if (segs[0] === 'embed') segs = segs.slice(1);
  if (segs[0] === 'user' && segs[2] === 'playlist') segs = segs.slice(2);
  const [type, id] = segs;
  if (!type || !SPOTIFY_TYPES.includes(type) || !id || !SPOTIFY_ID.test(id)) return undefined;
  return {
    provider: 'spotify',
    label: 'Spotify',
    kind: 'audio',
    src: `https://open.spotify.com/embed/${type}/${id}`,
    height: type === 'track' || type === 'episode' ? 152 : 352,
    allow: `${AUDIO_ALLOW}; fullscreen; picture-in-picture`,
  };
};

const APPLE_IDS: Record<string, RegExp> = {
  album: /^\d{3,15}$/,
  song: /^\d{3,15}$/,
  'music-video': /^\d{3,15}$/,
  playlist: /^pl\.[\w-]{6,64}$/,
  station: /^ra\.[\w-]{3,64}$/,
};

const appleMusic: Parser = (u, segs) => {
  const [storefront, kind, ...rest] = segs;
  if (!storefront || !/^[a-z]{2}$/.test(storefront) || !kind || !APPLE_IDS[kind]) return undefined;
  if (rest.length < 1 || rest.length > 2) return undefined;
  const id = rest[rest.length - 1];
  if (!APPLE_IDS[kind].test(id)) return undefined;
  let slug = '';
  if (rest.length === 2) {
    try {
      const decoded = decodeURIComponent(rest[0]);
      if (!decoded || decoded.length > 200) return undefined;
      slug = `${enc(decoded)}/`;
    } catch {
      return undefined;
    }
  }
  const i = u.searchParams.get('i');
  const songId = i && /^\d{3,15}$/.test(i) ? i : undefined;
  const src = `https://embed.music.apple.com/${storefront}/${kind}/${slug}${id}${songId ? `?i=${songId}` : ''}`;
  if (kind === 'music-video') return video('apple-music', 'Apple Music', src);
  return {
    provider: 'apple-music',
    label: 'Apple Music',
    kind: 'audio',
    src,
    height: songId || kind === 'song' ? 175 : 450,
    allow: `${AUDIO_ALLOW}; fullscreen`,
  };
};

const SC_SEG = /^[\w-]{1,100}$/;
const SC_RESERVED = new Set([
  'discover', 'search', 'stream', 'you', 'upload', 'charts', 'settings', 'messages', 'notifications', 'pages',
  'jobs', 'imprint', 'terms-of-use', 'popular', 'people', 'mobile', 'signin', 'signup', 'tags', 'stations', 'feed',
]);

const soundcloud: Parser = (_u, segs) => {
  const [user, second, third, fourth] = segs;
  if (!user || !SC_SEG.test(user) || SC_RESERVED.has(user) || !second || !SC_SEG.test(second)) return undefined;
  let path: string;
  let isSet = false;
  if (second === 'sets') {
    if (!third || !SC_SEG.test(third)) return undefined;
    path = `${user}/sets/${third}`;
    isSet = true;
    if (fourth !== undefined) return undefined;
  } else {
    if (['likes', 'tracks', 'albums', 'reposts', 'followers', 'following', 'popular-tracks', 'comments'].includes(second)) return undefined;
    path = `${user}/${second}`;
    // Private tracks carry a secret token: /user/track/s-AbCdE
    if (third !== undefined) {
      if (!/^s-[A-Za-z0-9]{4,40}$/.test(third) || fourth !== undefined) return undefined;
      path += `/${third}`;
    }
  }
  return {
    provider: 'soundcloud',
    label: 'SoundCloud',
    kind: 'audio',
    src: `https://w.soundcloud.com/player/?url=${enc(`https://soundcloud.com/${path}`)}`,
    height: isSet ? 450 : 166,
    allow: AUDIO_ALLOW,
  };
};

const REDDIT_SUB = /^[A-Za-z0-9_]{2,21}$/;
const REDDIT_ID = /^[a-z0-9]{3,12}$/i;

const reddit: Parser = (_u, segs, opts) => {
  const [r, sub, comments, id] = segs;
  if (r !== 'r' || !sub || !REDDIT_SUB.test(sub) || comments !== 'comments' || !id || !REDDIT_ID.test(id)) return undefined;
  return {
    provider: 'reddit',
    label: 'Reddit',
    kind: 'post',
    src: `https://embed.reddit.com/r/${sub}/comments/${id}/?embed=true${opts.theme === 'dark' ? '&theme=dark' : ''}`,
    height: 480,
    maxWidth: 640,
    allow: POST_ALLOW,
  };
};

const PIN_ID = /^\d{5,25}$/;

const pinterest: Parser = (_u, segs) => {
  if (segs[0] !== 'pin' || !segs[1] || !PIN_ID.test(segs[1])) return undefined;
  return {
    provider: 'pinterest',
    label: 'Pinterest',
    kind: 'post',
    src: `https://assets.pinterest.com/ext/embed.html?id=${segs[1]}`,
    height: 600,
    maxWidth: 345,
    allow: 'clipboard-write; fullscreen',
  };
};

const FB_SEG = /^[\w.-]{1,120}$/;
const FB_NUM = /^\d{1,25}$/;
const FB_TOKEN = /^\w{1,120}$/;
const FB_POST_WIDTH = 350;

/** The canonical public URL of a Facebook post / video, rebuilt from validated parts. */
function facebookTarget(u: URL, segs: string[]): { href: string; kind: 'post' | 'video' | 'reel' } | undefined {
  const base = 'https://www.facebook.com';
  const q = (k: string) => u.searchParams.get(k) ?? '';
  const [a, b, c, d] = segs;
  if (!a) return undefined;
  if (a === 'permalink.php' || a === 'story.php') {
    const story = q('story_fbid');
    const id = q('id');
    return FB_TOKEN.test(story) && FB_NUM.test(id) ? { href: `${base}/permalink.php?story_fbid=${story}&id=${id}`, kind: 'post' } : undefined;
  }
  if (a === 'photo.php' || (a === 'photo' && !b)) {
    const fbid = q('fbid');
    return FB_NUM.test(fbid) ? { href: `${base}/photo.php?fbid=${fbid}`, kind: 'post' } : undefined;
  }
  if (a === 'watch' && !b) {
    const v = q('v');
    return FB_NUM.test(v) ? { href: `${base}/watch/?v=${v}`, kind: 'video' } : undefined;
  }
  if (a === 'video.php') {
    const v = q('v');
    return FB_NUM.test(v) ? { href: `${base}/watch/?v=${v}`, kind: 'video' } : undefined;
  }
  if (a === 'reel' && b && FB_NUM.test(b) && !c) return { href: `${base}/reel/${b}`, kind: 'reel' };
  if (a === 'groups' && b && FB_SEG.test(b) && (c === 'posts' || c === 'permalink') && d && FB_SEG.test(d) && segs.length === 4) {
    return { href: `${base}/groups/${b}/${c}/${d}`, kind: 'post' };
  }
  if (!FB_SEG.test(a) || a.endsWith('.php')) return undefined;
  if (b === 'posts' && c && FB_SEG.test(c) && segs.length === 3) return { href: `${base}/${a}/posts/${c}`, kind: 'post' };
  if (b === 'videos') {
    const id = segs[segs.length - 1];
    if (segs.length >= 3 && segs.length <= 4 && FB_NUM.test(id) && segs.every((s) => FB_SEG.test(s))) {
      return { href: `${base}/${a}/videos/${id}`, kind: 'video' };
    }
    return undefined;
  }
  if (b === 'photos' && segs.length >= 3 && segs.length <= 4 && segs.every((s) => FB_SEG.test(s))) {
    return { href: `${base}/${segs.join('/')}`, kind: 'post' };
  }
  return undefined;
}

const facebook: Parser = (u, segs) => {
  const target = facebookTarget(u, segs);
  if (!target) return undefined;
  const href = enc(target.href);
  if (target.kind === 'post') {
    return {
      provider: 'facebook',
      label: 'Facebook',
      kind: 'post',
      // 350 is the plugin's narrowest width, so the post still fits a phone-width card.
      src: `https://www.facebook.com/plugins/post.php?href=${href}&show_text=true&width=${FB_POST_WIDTH}`,
      height: 600,
      maxWidth: FB_POST_WIDTH,
      allow: POST_ALLOW,
    };
  }
  const src = `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false`;
  return video('facebook', 'Facebook', src, target.kind === 'reel' ? vertical : {});
};

const DM_ID = /^x[a-z0-9]{4,12}$/i;

const dailymotion: Parser = (u, segs) => {
  let id: string | undefined;
  if (u.hostname === 'dai.ly') id = segs[0];
  else if (segs[0] === 'video') id = segs[1]?.split('_')[0];
  else if (segs[0] === 'embed' && segs[1] === 'video') id = segs[2];
  if (!id || !DM_ID.test(id)) return undefined;
  const start = startOf(u, ['start', 't']);
  return video('dailymotion', 'Dailymotion', `https://www.dailymotion.com/embed/video/${id}${start ? `?start=${start}` : ''}`);
};

const loom: Parser = (u, segs) => {
  if (segs[0] !== 'share' && segs[0] !== 'embed') return undefined;
  const id = segs[1]?.match(/(?:^|-)([a-f0-9]{32})$/i)?.[1];
  if (!id || segs.length > 2) return undefined;
  const start = startOf(u, ['t']);
  return video('loom', 'Loom', `https://www.loom.com/embed/${id}${start ? `?t=${start}` : ''}`);
};

const TWITCH_CLIP = /^[A-Za-z0-9_-]{4,100}$/;
const TWITCH_VIDEO = /^\d{5,15}$/;
const TWITCH_CHANNEL = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_RESERVED = new Set([
  'directory', 'videos', 'settings', 'p', 'search', 'downloads', 'jobs', 'turbo', 'prime', 'subscriptions', 'inventory',
  'wallet', 'drops', 'friends', 'messages', 'login', 'signup', 'store', 'following', 'moderator', 'u', 'embed', 'clips',
]);
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const twitch: Parser = (u, segs, opts) => {
  const parent = opts.parentHost?.trim().toLowerCase();
  if (!parent || !HOSTNAME_RE.test(parent)) return undefined;
  const p = `parent=${enc(parent)}`;
  if (u.hostname === 'clips.twitch.tv') {
    const slug = segs[0] === 'embed' ? u.searchParams.get('clip') ?? '' : segs[0];
    return slug && TWITCH_CLIP.test(slug) && segs.length <= 1
      ? video('twitch', 'Twitch', `https://clips.twitch.tv/embed?clip=${slug}&${p}&autoplay=false`)
      : undefined;
  }
  const [a, b, c] = segs;
  if (a === 'videos' && b && TWITCH_VIDEO.test(b)) {
    const start = startOf(u, ['t']);
    const time = start ? `&time=${hms(start)}` : '';
    return video('twitch', 'Twitch', `https://player.twitch.tv/?video=v${b}&${p}&autoplay=false${time}`);
  }
  if (!a || !TWITCH_CHANNEL.test(a) || TWITCH_RESERVED.has(a.toLowerCase())) return undefined;
  if (b === 'clip' && c && TWITCH_CLIP.test(c)) {
    return video('twitch', 'Twitch', `https://clips.twitch.tv/embed?clip=${c}&${p}&autoplay=false`);
  }
  if (b === undefined) return video('twitch', 'Twitch', `https://player.twitch.tv/?channel=${a.toLowerCase()}&${p}&autoplay=false`);
  return undefined;
};

const PARSERS: Record<string, Parser> = {};
const register = (hosts: string[], parser: Parser) => hosts.forEach((h) => (PARSERS[h] = parser));

register(
  ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be', 'www.youtu.be'],
  youtube,
);
register(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'], vimeo);
register(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'], tiktok);
register(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am'], instagram);
register(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'], x);
register(['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'], threads);
register(['open.spotify.com'], spotify);
register(['music.apple.com'], appleMusic);
register(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'], soundcloud);
register(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com'], reddit);
register(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com', 'touch.facebook.com'], facebook);
register(['dailymotion.com', 'www.dailymotion.com', 'dai.ly'], dailymotion);
register(['loom.com', 'www.loom.com'], loom);
register(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'clips.twitch.tv'], twitch);

// pinterest.com, uk.pinterest.com, pinterest.co.uk, pinterest.com.au, pinterest.fr…
const PINTEREST_HOST = /^(?:www\.|[a-z]{2}\.)?pinterest\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

function parserFor(host: string): Parser | undefined {
  if (Object.hasOwn(PARSERS, host)) return PARSERS[host];
  if (PINTEREST_HOST.test(host)) return pinterest;
  return undefined;
}

/**
 * How to embed the original post / video / track behind a saved link, or undefined when
 * the platform isn't supported or the link doesn't point at one specific thing.
 * Accepts http(s) links only; the embed itself is always https.
 */
export function embedFor(url?: string, opts: EmbedOptions = {}): Embed | undefined {
  if (typeof url !== 'string') return undefined;
  const raw = url.trim();
  if (!/^https?:\/\//i.test(raw) || raw.length > 4096) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const parser = parserFor(host);
  if (!parser) return undefined;
  // Parsers compare u.hostname, so drop a trailing dot ("youtu.be.") there too.
  if (u.hostname !== host) u.hostname = host;
  const segs = u.pathname.split('/').filter(Boolean);
  try {
    return parser(u, segs, opts);
  } catch {
    return undefined;
  }
}

/** The app's current light / dark theme (from data-resolved-theme on <html>), for EmbedOptions.theme. */
export function resolvedTheme(): 'light' | 'dark' | undefined {
  if (typeof document === 'undefined') return undefined;
  const t = document.documentElement?.dataset?.resolvedTheme;
  return t === 'dark' || t === 'light' ? t : undefined;
}

/** Calls `cb` whenever the resolved theme changes, including when the system theme flips. Returns an unsubscribe. */
export function subscribeResolvedTheme(cb: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || !document.documentElement) return () => {};
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-resolved-theme'] });
  return () => mo.disconnect();
}

const AUTOPLAY: Record<string, [string, string]> = {
  youtube: ['autoplay', '1'],
  'youtube-music': ['autoplay', '1'],
  vimeo: ['autoplay', '1'],
  dailymotion: ['autoplay', '1'],
  twitch: ['autoplay', 'true'],
};

/** The same embed, set to start playing — for when the user tapped play on the preview. */
export function withAutoplay(embed: Embed): Embed {
  const param = AUTOPLAY[embed.provider];
  if (!param || embed.kind !== 'video') return embed;
  try {
    const u = new URL(embed.src);
    u.searchParams.set(param[0], param[1]);
    return { ...embed, src: u.toString() };
  } catch {
    return embed;
  }
}

/**
 * Height an embedded post asked to be resized to, from a postMessage it sent.
 * Callers must check the message came from the embed's own iframe and origin first.
 */
export function embedHeightFromMessage(provider: string, data: unknown): number | undefined {
  let msg: unknown = data;
  if (typeof msg === 'string') {
    if (msg.length > 20000 || !/^\s*[{[]/.test(msg)) return undefined;
    try {
      msg = JSON.parse(msg);
    } catch {
      return undefined;
    }
  }
  if (!msg || typeof msg !== 'object') return undefined;
  const o = msg as Record<string, unknown>;
  let h: unknown;
  if (provider === 'instagram' && o.type === 'MEASURE') {
    h = (o.details as Record<string, unknown> | undefined)?.height;
  } else if (provider === 'x') {
    const e = o['twttr.embed'] as Record<string, unknown> | undefined;
    const params = e?.method === 'twttr.private.resize' && Array.isArray(e.params) ? e.params : undefined;
    h = (params?.[0] as Record<string, unknown> | undefined)?.height;
  } else if (provider === 'reddit' && o.type === 'resize.embed') {
    h = o.data;
  }
  const n = typeof h === 'string' ? Number(h) : h;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(Math.min(2000, Math.max(80, n)));
}

// ---------------------------------------------------------------------------
// The shared text

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'url'; text: string; href: string; display: string }
  | { kind: 'tag'; text: string }
  | { kind: 'mention'; text: string };

// Stops at whitespace, quotes and CJK / full-width punctuation, like classify's extractUrl.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`　-〿＀-￯]+/gi;
const TAG_OR_MENTION_RE =
  /(^|[^\p{L}\p{N}_&/#＃@.])([#＃](?=[\p{N}_]*\p{L})[\p{L}\p{N}_]{1,60}|@[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?)(?![\p{L}\p{N}_@])/gu;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Drops punctuation that ended the sentence rather than the link, keeping balanced brackets. */
function trimUrl(raw: string): string {
  const counts: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (const ch of raw) if (ch in counts) counts[ch]++;
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    const opener = CLOSERS[ch];
    if (/[.,;:!?'"»”’*]/.test(ch)) end--;
    else if (opener && counts[ch] > counts[opener]) {
      counts[ch]--;
      end--;
    } else break;
  }
  return raw.slice(0, end);
}

// Invisible and direction-changing characters that could disguise a link's text.
const HIDDEN_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** "youtube.com/watch?v=dQw4w9…" — host and path, shortened for display. */
export function shortUrl(href: string, max = 36): string {
  let out: string;
  try {
    const u = new URL(href);
    let rest = `${u.pathname}${u.search}`;
    if (rest === '/') rest = '';
    try {
      rest = decodeURI(rest);
    } catch {
      /* keep it encoded */
    }
    out = `${u.hostname.replace(/^www\./, '')}${rest}`;
  } catch {
    out = href;
  }
  out = out.replace(HIDDEN_CHARS_RE, '');
  const chars = Array.from(out);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : out;
}

function pushText(out: TextPart[], text: string) {
  if (!text) return;
  const prev = out[out.length - 1];
  if (prev?.kind === 'text') prev.text += text;
  else out.push({ kind: 'text', text });
}

function splitTags(out: TextPart[], text: string) {
  let last = 0;
  for (const m of text.matchAll(TAG_OR_MENTION_RE)) {
    const start = (m.index ?? 0) + m[1].length;
    pushText(out, text.slice(last, start));
    out.push({ kind: m[2].startsWith('@') ? 'mention' : 'tag', text: m[2] });
    last = start + m[2].length;
  }
  pushText(out, text.slice(last));
}

/**
 * Splits shared text into plain text, links, #hashtags and @mentions, for rendering as
 * React elements (never HTML). Links are http(s) only; anything else stays plain text.
 */
export function textParts(text: string | undefined): TextPart[] {
  const out: TextPart[] = [];
  if (!text) return out;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimUrl(m[0]);
    const href = safeUrl(raw);
    if (!href) continue;
    const start = m.index ?? 0;
    splitTags(out, text.slice(last, start));
    out.push({ kind: 'url', text: raw, href, display: shortUrl(href) });
    last = start + raw.length;
  }
  splitTags(out, text.slice(last));
  return out;
}

const hasWords = (s: string) => /[\p{L}\p{N}]/u.test(s);
const stripUrls = (s: string) => s.replace(URL_RE, ' ');

/** The creator, when the link preview recorded one as "by Name". */
export function authorOf(item: Pick<Item, 'description'>): string | undefined {
  const m = item.description?.trim().match(/^by ([^\n]{1,80})$/);
  return m ? m[1].trim() || undefined : undefined;
}

/**
 * The words the save came with: exactly what was shared, or else the page's own
 * description. A share that was nothing but the link doesn't count.
 */
export function originalTextOf(item: Pick<Item, 'sharedText' | 'description'>): string | undefined {
  const shared = item.sharedText?.trim();
  if (shared && hasWords(stripUrls(shared))) return shared;
  const d = item.description?.trim();
  if (d && !authorOf(item) && hasWords(d)) return d;
  return undefined;
}

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const WORDISH = /[\p{L}\p{N}]/u;
// Scripts written without spaces between words, where any character can end a word.
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * Cuts `title` off the front of `s` when `s` starts with it (ignoring case, spaces and
 * punctuation), but only at the end of a word: "Rome" isn't cut from "Romeo and Juliet".
 */
function withoutLeadingTitle(s: string, title: string): string {
  const t = key(title);
  if (t.length < 3) return s;
  let k = '';
  let at = 0;
  let lastCh = '';
  for (const ch of s) {
    at += ch.length;
    k += key(ch);
    if (WORDISH.test(ch)) lastCh = ch;
    if (k.length >= t.length) break;
  }
  if (k !== t) return s;
  const rest = s.slice(at);
  const next = Array.from(rest.slice(0, 2))[0] ?? '';
  // "Rome's" carries on the word "Rome".
  const apostrophe = /^['’]\p{L}/u.test(rest);
  const wordEnds = !next || (!WORDISH.test(next) && !apostrophe) || NO_SPACES.test(next) || NO_SPACES.test(lastCh);
  return wordEnds ? rest : s;
}

/**
 * One tidy line of the original text for cards: no links or hashtags, whitespace
 * collapsed, and without repeating the item's title. Undefined when nothing's left.
 */
export function snippetText(text: string | undefined, title?: string, max = 280): string | undefined {
  if (!text) return undefined;
  let s = stripUrls(text)
    .replace(/(^|[^\p{L}\p{N}_&/])[#＃][\p{L}\p{N}_]+/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (title) {
    const cut = withoutLeadingTitle(s, title);
    if (cut !== s) s = cut;
    else {
      // "@chef Best pasta ever" still starts with the title "Best pasta ever".
      const lead = s.match(/^(?:@[\w.]+[\s,:]+)+/u)?.[0];
      if (lead) {
        const rest = s.slice(lead.length);
        const cutRest = withoutLeadingTitle(rest, title);
        if (cutRest !== rest) s = cutRest;
      }
    }
  }
  s = s.replace(/^[\s|:·•>»\-–—,;.!?)\]]+/u, '').trim();
  if (!hasWords(s)) return undefined;
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : s;
}
