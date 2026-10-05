import type { ItemType, Place } from './types';

/**
 * On-device "smart sorting": works out what a save is (recipe, place, event, video…),
 * where it came from, a clean title and some starter tags — from the URL and
 * whatever text was shared with it — and explains why. No network or AI service needed.
 */

export interface SharedInput {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Classification {
  type: ItemType;
  source?: string;
  title: string;
  url?: string;
  note?: string;
  tags: string[];
  place?: Place;
  /** Exactly what was shared or pasted (title, text and link), so the original post stays recognisable. */
  sharedText?: string;
  /** Who posted it, when the share says so, e.g. "@chef". */
  author?: string;
  /** Short human evidence for the chosen type, strongest first, e.g. "bbcgoodfood.com is a recipe site". */
  reasons: string[];
  confidence: Confidence;
  /** Other plausible types, best first (max 3), never including `type`. */
  alternatives: ItemType[];
}

// Stops at whitespace, quotes and CJK / full-width punctuation ("…/abc，复制本条信息").
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`\u3000-\u303F\uFF00-\uFFEF]+/i;

export function extractUrl(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(URL_RE);
  if (!m) return undefined;
  // Trailing punctuation is almost never part of a shared link.
  return normalizeUrl(m[0].replace(/[.,;:!?)\]}»”’]+$/, ''));
}

export function normalizeUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim();
  if (!s) return undefined;
  if (/^www\./i.test(s)) s = `https://${s}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    // Looks like "example.com/path" — treat as a web address.
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) s = `https://${s}`;
    else return undefined;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'geo:') return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Only http(s) links are ever rendered as hrefs or images — never javascript:, data: etc. */
export function safeUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const u = normalizeUrl(raw);
  return u && /^https?:/i.test(u) ? u : undefined;
}

/** Per-sharer tracking parameters platforms add to links (Instagram igsh / stkn, YouTube si, TikTok _t, utm_*…). */
export const TRACKING_PARAMS =
  /^(?:utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igsh|igshid|stkn|si|feature|mibextid|ref_src|ref_url|_branch_match_id|share_source|xmt|_t|_r|is_from_webapp|sender_device|web_id|share_app_id|share_link_id|u_code|tt_from)$/i;

// Instagram posts, reels and IGTV ("/p/…", "/reel/…", "/user/reel/…", "/share/p/…").
const IG_POST_PATH = /^\/(?:[\w.]+\/)?(?:p|reels?|tv)\/[\w-]+/;

/**
 * Whether `key` is only tracking on this link: a known tracking parameter, or on an Instagram post anything but
 * img_index (which photo of a carousel), since the rest are per-share tokens that keep changing.
 */
export function isTrackingParam(url: URL, key: string): boolean {
  if (TRACKING_PARAMS.test(key)) return true;
  if (key === 'img_index') return false;
  const host = url.hostname.toLowerCase();
  return (hostMatches(host, 'instagram.com') || hostMatches(host, 'instagr.am')) && IG_POST_PATH.test(url.pathname);
}

/** The link without tracking parameters (unchanged, character for character, when it has none). */
export function stripTracking(raw: string): string {
  if (!/[?&]/.test(raw)) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
  const drop = [...new Set(u.searchParams.keys())].filter((k) => isTrackingParam(u, k));
  if (!drop.length) return raw;
  for (const k of drop) u.searchParams.delete(k);
  return u.toString();
}

const URL_RE_ALL = new RegExp(URL_RE.source, 'gi');

/** Text with the tracking parameters taken out of every link in it. */
export function stripTrackingInText(text: string): string {
  return text.replace(URL_RE_ALL, (m) => {
    const [, core, tail] = /^(.*?)([.,;:!?)\]}»”’]*)$/s.exec(m)!;
    return stripTracking(core) + tail;
  });
}

export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^(www\.|m\.|mobile\.)/, '').toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Domains

interface DomainRule {
  /** "site.com", "site.*" (any country TLD) or "site.com/path" prefixes. */
  domains: string[];
  type: ItemType;
  source?: string;
  path?: RegExp;
  /** Evidence shown to the user. Defaults to e.g. "bbcgoodfood.com is a recipe site". */
  reason?: string;
  tags?: string[];
  /** Fallback title when the link has no readable slug. */
  title?: string;
}

const PODCAST: Pick<DomainRule, 'type' | 'reason' | 'tags'> = { type: 'music', reason: 'Podcast', tags: ['podcast'] };

// Order matters: first match wins.
const DOMAIN_RULES: DomainRule[] = [
  // Maps
  { domains: ['google.*', 'maps.google.*'], path: /^\/maps/, type: 'place', source: 'google-maps', reason: 'Google Maps link' },
  { domains: ['maps.google.*', 'maps.app.goo.gl'], type: 'place', source: 'google-maps', reason: 'Google Maps link' },
  { domains: ['goo.gl'], path: /^\/maps/, type: 'place', source: 'google-maps', reason: 'Google Maps link' },
  { domains: ['maps.apple.com', 'maps.apple'], type: 'place', source: 'apple-maps', reason: 'Apple Maps link' },
  { domains: ['openstreetmap.org', 'osm.org'], type: 'place', source: 'openstreetmap', reason: 'OpenStreetMap link' },
  { domains: ['waze.com'], type: 'place', source: 'waze', reason: 'Waze link' },

  // Events & activities
  { domains: ['eventbrite.*'], type: 'event', source: 'eventbrite' },
  { domains: ['ticketmaster.*'], type: 'event', source: 'ticketmaster' },
  { domains: ['dice.fm'], type: 'event', source: 'dice' },
  { domains: ['ra.co', 'residentadvisor.net'], type: 'event', source: 'resident-advisor' },
  { domains: ['meetup.com'], type: 'event', source: 'meetup' },
  { domains: ['lu.ma', 'luma.com'], type: 'event', source: 'luma' },
  { domains: ['partiful.com'], type: 'event', source: 'partiful' },
  { domains: ['facebook.com'], path: /^\/events\//, type: 'event', source: 'facebook', reason: 'Facebook event' },
  { domains: ['fb.me'], path: /^\/e\//, type: 'event', source: 'facebook', reason: 'Facebook event' },
  { domains: ['airbnb.*'], path: /^\/experiences\//, type: 'event', reason: 'Airbnb Experience', title: 'Airbnb Experience' },
  { domains: ['calendar.google.com'], type: 'event', reason: 'Calendar invite', title: 'Calendar invite' },
  {
    domains: [
      'livenation.*', 'songkick.com', 'bandsintown.com', 'seetickets.com', 'seetickets.us', 'skiddle.com', 'universe.com',
      'eventim.*', 'axs.com', 'feverup.com', 'designmynight.com', 'headout.com', 'tickettailor.com', 'humanitix.com',
      'allevents.in', 'tixr.com', 'stubhub.*', 'viagogo.*', 'ticketek.*', 'eventfinda.*', 'ticketweb.*', 'billetto.*',
      'peatix.com', 'kktix.com', 'cityline.com', 'urbtix.hk', 'hkticketing.com', 'klook.com', 'kkday.com',
      'getyourguide.*', 'viator.com', 'posh.vip', 'fatsoma.com', 'shotgun.live', 'wegottickets.com', 'ents24.com',
      'gigantic.com',
    ],
    type: 'event',
  },

  // Places
  {
    domains: [
      'yelp.*', 'tripadvisor.*', 'opentable.*', 'resy.com', 'airbnb.*', 'booking.com', 'hotels.com', 'timeout.com',
      'thefork.com', 'sevenrooms.com', 'eater.com', 'theinfatuation.com', 'foursquare.com', 'alltrails.com',
      'openrice.com', 'dianping.com', 'tabelog.com', 'guide.michelin.com', 'agoda.com', 'trip.com', 'expedia.*',
      'hostelworld.com', 'wanderlog.com', 'map.naver.com', 'map.kakao.com', 'amap.com', 'map.baidu.com',
    ],
    type: 'place',
  },

  // Video & social
  { domains: ['music.youtube.com'], type: 'music', source: 'youtube-music', reason: 'YouTube Music link' },
  { domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], type: 'video', source: 'youtube', reason: 'YouTube video' },
  { domains: ['tiktok.com'], path: /\/photo\//, type: 'link', source: 'tiktok', reason: 'TikTok photo post' },
  { domains: ['tiktok.com'], type: 'video', source: 'tiktok', reason: 'TikTok video' },
  { domains: ['douyin.com', 'iesdouyin.com'], type: 'video', source: 'douyin', reason: 'Douyin video' },
  { domains: ['instagram.com'], path: /^\/(?:[\w.]+\/)?(?:reels?|tv)\//, type: 'video', source: 'instagram', reason: 'Instagram reel' },
  { domains: ['instagram.com', 'instagr.am'], type: 'link', source: 'instagram', reason: 'Instagram post' },
  { domains: ['vimeo.com'], type: 'video', source: 'vimeo', reason: 'Vimeo video' },
  { domains: ['twitch.tv'], type: 'video', source: 'twitch', reason: 'Twitch stream' },
  { domains: ['kick.com'], type: 'video', source: 'kick', reason: 'Kick stream' },
  { domains: ['dailymotion.com', 'dai.ly'], type: 'video', source: 'dailymotion', reason: 'Dailymotion video' },
  { domains: ['snapchat.com'], path: /^\/spotlight\//, type: 'video', source: 'snapchat', reason: 'Snapchat Spotlight' },
  { domains: ['snapchat.com'], type: 'link', source: 'snapchat', reason: 'Snapchat link' },
  { domains: ['fb.watch'], type: 'video', source: 'facebook', reason: 'Facebook video' },
  { domains: ['facebook.com'], path: /^\/(?:watch|reel|share\/[rv])\b/, type: 'video', source: 'facebook', reason: 'Facebook video' },
  { domains: ['letterboxd.com', 'boxd.it'], type: 'video', source: 'letterboxd', reason: 'Letterboxd film', title: 'Film on Letterboxd' },
  { domains: ['imdb.com', 'imdb.to'], type: 'video', source: 'imdb', reason: 'IMDb title', title: 'IMDb title' },
  { domains: ['netflix.com', 'primevideo.com', 'disneyplus.com', 'tv.apple.com', 'hulu.com', 'max.com', 'bbc.co.uk/iplayer'], type: 'video' },
  { domains: ['pinterest.*', 'pin.it'], type: 'link', source: 'pinterest', reason: 'Pinterest pin' },
  { domains: ['reddit.com', 'redd.it'], type: 'link', source: 'reddit', reason: 'Reddit post' },
  { domains: ['x.com', 'twitter.com'], type: 'link', source: 'x', reason: 'X post' },
  { domains: ['threads.net', 'threads.com'], type: 'link', source: 'threads', reason: 'Threads post' },
  { domains: ['bsky.app'], type: 'link', source: 'bluesky', reason: 'Bluesky post' },
  { domains: ['linkedin.com', 'lnkd.in'], type: 'link', source: 'linkedin', reason: 'LinkedIn post' },
  { domains: ['xiaohongshu.com', 'xhslink.com'], type: 'link', source: 'rednote', reason: 'RedNote post' },
  { domains: ['lemon8-app.com', 'lemon8.app'], type: 'link', source: 'lemon8', reason: 'Lemon8 post' },
  { domains: ['facebook.com'], type: 'link', source: 'facebook', reason: 'Facebook post' },

  // Recipes
  {
    domains: [
      'allrecipes.com', 'bbcgoodfood.com', 'seriouseats.com', 'cooking.nytimes.com', 'bonappetit.com',
      'epicurious.com', 'food52.com', 'delish.com', 'tasty.co', 'budgetbytes.com', 'recipetineats.com',
      'minimalistbaker.com', 'jamieoliver.com', 'simplyrecipes.com', 'halfbakedharvest.com', 'foodnetwork.com',
      'thekitchn.com', 'smittenkitchen.com', 'bbc.co.uk/food', 'deliciousmagazine.co.uk', 'olivemagazine.com',
      'nigella.com', 'ottolenghi.co.uk', 'kingarthurbaking.com', 'loveandlemons.com', 'cookieandkate.com',
      'pinchofyum.com', 'sallysbakingaddiction.com', 'hellofresh.com', 'mob.co.uk', 'mobkitchen.co.uk',
      'thewoksoflife.com', 'justonecookbook.com', 'maangchi.com', 'cookpad.com', 'xiachufang.com',
    ],
    type: 'recipe',
  },

  // Shopping
  { domains: ['music.amazon.*'], type: 'music' },
  { domains: ['store.steampowered.com', 'steampowered.com', 's.team'], type: 'product', source: 'steam', reason: 'Steam store page', title: 'Game on Steam' },
  {
    domains: [
      'amazon.*', 'amzn.to', 'amzn.eu', 'amzn.asia', 'a.co', 'etsy.com', 'ebay.*', 'asos.com', 'zara.com', 'hm.com',
      'uniqlo.com', 'ikea.com', 'johnlewis.com', 'argos.co.uk', 'target.com', 'walmart.com', 'bestbuy.com', 'nike.com',
      'adidas.com', 'aliexpress.com', 'temu.com', 'shein.com', 'wayfair.com', 'wayfair.co.uk', 'sephora.com',
      'net-a-porter.com', 'farfetch.com', 'depop.com', 'vinted.com', 'vinted.co.uk', 'apple.com/shop', 'taobao.com',
      'tmall.com', 'shopee.*', 'lazada.*', 'rakuten.*', 'hktvmall.com', 'muji.com', 'lego.com', 'zalando.*',
    ],
    type: 'product',
  },

  // Music & podcasts
  { domains: ['open.spotify.com'], path: /^\/(?:intl-[\w-]+\/)?(?:episode|show)\//, ...PODCAST, source: 'spotify', reason: 'Podcast on Spotify' },
  { domains: ['podcasts.apple.com'], ...PODCAST, source: 'apple-podcasts' },
  { domains: ['overcast.fm', 'pca.st', 'pocketcasts.com', 'castbox.fm', 'podbean.com'], ...PODCAST },
  { domains: ['open.spotify.com', 'spotify.com', 'spotify.link'], type: 'music', source: 'spotify' },
  { domains: ['music.apple.com', 'soundcloud.com', 'bandcamp.com', 'tidal.com', 'deezer.com'], type: 'music' },

  // Books
  {
    domains: ['goodreads.com', 'books.google.com', 'bookshop.org', 'uk.bookshop.org', 'openlibrary.org', 'storygraph.com', 'thestorygraph.com', 'audible.com', 'audible.co.uk'],
    type: 'book',
  },

  // Articles
  { domains: ['substack.com'], type: 'article', source: 'substack', reason: 'Substack post' },
  {
    domains: [
      'medium.com', 'nytimes.com', 'theguardian.com', 'bbc.co.uk', 'bbc.com', 'wikipedia.org',
      'theatlantic.com', 'newyorker.com', 'wired.com', 'theverge.com', 'economist.com', 'ft.com',
      'washingtonpost.com', 'bloomberg.com', 'vox.com', 'aeon.co', 'arstechnica.com', 'techcrunch.com',
      'news.ycombinator.com', 'dev.to', 'scmp.com',
    ],
    type: 'article',
  },
];

const ICS_RULE: DomainRule = { domains: [], type: 'event', reason: 'Calendar file', title: 'Calendar event' };

type HostTest = (host: string, hostPath: string) => boolean;

function compileDomain(d: string): HostTest {
  if (d.includes('/')) return (_h, hp) => hp.startsWith(d) || hp.startsWith(`www.${d}`);
  if (d.endsWith('.*')) {
    // "eventbrite.*" → eventbrite.com, eventbrite.co.uk, eventbrite.com.au…
    const re = new RegExp(`(?:^|\\.)${escapeRe(d.slice(0, -2))}\\.[a-z]{2,3}(?:\\.[a-z]{2})?$`);
    return (h) => re.test(h);
  }
  return (h) => hostMatches(h, d);
}

const COMPILED_RULES = DOMAIN_RULES.map((rule) => ({ rule, tests: rule.domains.map(compileDomain) }));

const SOURCE_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  'youtube-music': 'YouTube Music',
  tiktok: 'TikTok',
  douyin: 'Douyin',
  instagram: 'Instagram',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  kick: 'Kick',
  dailymotion: 'Dailymotion',
  snapchat: 'Snapchat',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  x: 'X',
  threads: 'Threads',
  bluesky: 'Bluesky',
  linkedin: 'LinkedIn',
  rednote: 'RedNote',
  lemon8: 'Lemon8',
  facebook: 'Facebook',
  letterboxd: 'Letterboxd',
  imdb: 'IMDb',
  spotify: 'Spotify',
  'apple-podcasts': 'Apple Podcasts',
  substack: 'Substack',
  steam: 'Steam',
  eventbrite: 'Eventbrite',
  ticketmaster: 'Ticketmaster',
  dice: 'DICE',
  'resident-advisor': 'Resident Advisor',
  meetup: 'Meetup',
  luma: 'Luma',
  partiful: 'Partiful',
  'google-maps': 'Google Maps',
  'apple-maps': 'Apple Maps',
  openstreetmap: 'OpenStreetMap',
  waze: 'Waze',
};

export function sourceLabel(source: string | undefined): string | undefined {
  if (!source) return undefined;
  // Own keys only: a source like "__proto__" or "constructor" (e.g. from a crafted share) must stay plain text.
  return Object.hasOwn(SOURCE_NAMES, source) ? SOURCE_NAMES[source] : source;
}

/** What a source id looks like ("youtube", "google-maps"); anything else from outside is dropped. */
export const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function matchDomain(url: string): { rule: DomainRule; host: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = hostOf(url);
  if (!host) return undefined;
  if (/\.ics$/i.test(u.pathname)) return { rule: ICS_RULE, host };
  const hostPath = `${host}${u.pathname}`;
  for (const { rule, tests } of COMPILED_RULES) {
    if (tests.some((t) => t(host, hostPath)) && (!rule.path || rule.path.test(u.pathname))) return { rule, host };
  }
  return undefined;
}

const SITE_KIND: Record<ItemType, string> = {
  link: 'link',
  video: 'is a video site',
  recipe: 'is a recipe site',
  place: 'is a places site',
  product: 'is a shop',
  article: 'publishes articles',
  workout: 'is a fitness site',
  book: 'is a books site',
  music: 'is a music site',
  event: 'is an events site',
  note: 'note',
};

function domainReason(rule: DomainRule, host: string): string {
  if (rule.reason) return rule.reason;
  const site = sourceLabel(rule.source) ?? host;
  return rule.type === 'link' ? `${site} post` : `${site} ${SITE_KIND[rule.type]}`;
}

// ---------------------------------------------------------------------------
// Keyword signals

interface Signal {
  re: RegExp;
  weight: number;
  tag?: string;
}

const w = (words: string, weight: number, tag?: string): Signal => ({
  re: new RegExp(`(?:^|[^\\p{L}\\p{N}])(${words})(?=$|[^\\p{L}\\p{N}])`, 'iu'),
  weight,
  tag,
});

// Built on first use, not at load: making these Unicode regexes takes a while on a phone, and nothing needs them
// before the first analysis (or the warm-up).
let signals: Partial<Record<ItemType, Signal[]>> | undefined;
const keywordSignals = (): Partial<Record<ItemType, Signal[]>> => (signals ??= {
  recipe: [
    w('recipes?|recipe ideas?', 3),
    w('ingredients?|tbsp|tsp|tablespoons?|teaspoons?|preheat|simmer|marinade|how to make', 3),
    w('cook(?:ing)?|bak(?:e|ing)|oven|stir[- ]fry|one[- ]pot|meal ?prep', 2),
    w('air ?fryer', 2, 'air-fryer'),
    w('desserts?|cakes?|cookies|brownies?|cheesecake', 2, 'dessert'),
    w('pasta|spaghetti|lasagne|lasagna|carbonara|gnocchi|orzo', 2, 'pasta'),
    w('breakfast|pancakes?|oats|granola', 1, 'breakfast'),
    w('soups?|stews?', 2, 'soup'),
    w('curry|curries|dhal|dal', 2, 'curry'),
    w('salads?', 1, 'salad'),
    w('chicken', 1, 'chicken'),
    w('vegan', 1, 'vegan'),
    w('vegetarian|veggie', 1, 'vegetarian'),
    w('healthy|high protein|low cal(?:orie)?', 1, 'healthy'),
    w('easy|quick|15[- ]?min(?:ute)?s?|20[- ]?min(?:ute)?s?|weeknight', 1, 'quick'),
    w('bread|sourdough|focaccia', 2, 'baking'),
    w('foodtok|foodie|dinner ideas?|lunch ideas?|dinnerideas|lunchideas|recipeoftheday|easyrecipes?|homecooking|cookingtok|bakingtok|whatieatinaday|healthyrecipes', 2),
  ],
  workout: [
    w('workouts?|work out|exercises?|training|routine', 3),
    w('hiit|tabata|circuit|emom|amrap', 3, 'hiit'),
    w('abs|core', 2, 'core'),
    w('glutes?|booty|leg day|legday|legs', 2, 'legs'),
    w('yoga|vinyasa|asanas?', 3, 'yoga'),
    w('pilates|reformer', 3, 'pilates'),
    w('stretch(?:es|ing)?|mobility|flexibility', 2, 'mobility'),
    w('cardio|running|run club|5k|10k|marathon', 2, 'cardio'),
    w('strength|dumbbells?|kettlebells?|barbell|squats?|deadlifts?|push[- ]?ups?|pull[- ]?ups?|reps|sets', 2, 'strength'),
    w('gym|gymtok|fittok|fitness|fitspo|fitnessmotivation|workoutmotivation|homeworkout', 2),
    w('full body|upper body|lower body|at home workout|no equipment', 2),
  ],
  place: [
    w('restaurants?|bistro|trattoria|eatery|diner', 3, 'restaurant'),
    w('caf[eé]s?|coffee shop|coffee spot|espresso bar', 3, 'coffee'),
    w('bars?|pubs?|cocktails?|speakeasy|rooftop|wine bar', 2, 'drinks'),
    w('brunch', 2, 'brunch'),
    w('bakery|patisserie', 2, 'bakery'),
    w('hidden gems?|must[- ]visit|must[- ]try|bucket list|places to|spots? in|things to do|where to eat|best .{0,20} in', 3),
    w('traveltok|traveltiktok|travelgram|placestovisit|hiddengems?|bucketlist|cafehopping|foodspots?', 2),
    w('travel(?:l?(?:ers?|ing))?|trips?|road ?trips?|itinerar(?:y|ies)|holidays?|vacations?|getaways?|weekend in|days in', 2, 'travel'),
    w('travel (?:tips|guide)|first[- ]time (?:visitors?|travell?ers?)|get(?:ting)? around|routes?|directions|how to get there|getting there|opening (?:hours|times)|address(?=\\s*[:：])', 2),
    w('hotels?|hostel|resort|cabin|airbnb|stay at', 2, 'stay'),
    w('beach(?:es)?|islands?|coast', 2, 'beach'),
    w('hikes?|hiking|trails?|walks? in|national park|mountains?|summits?|lookouts?|viewpoints?|waterfalls?', 2, 'outdoors'),
    w('museums?|galler(?:y|ies)|exhibitions?', 2, 'culture'),
    w('markets?|food hall', 1, 'market'),
  ],
  product: [
    w('buy|shop(?:ping)?|on sale|discount|deal|promo code|wishlist|add to cart|in stock|perfumes?|fragrances?|colognes?|skincare|lipsticks?|sneakers', 2),
    w('amazon finds?|tiktok made me buy|haul|must[- ]haves?|gift ideas?|amazonfinds|tiktokmademebuyit|founditonamazon|amazonmusthaves|giftideas|giftguide', 3, 'wishlist'),
    w('[$£€]\\s?\\d+(?:[.,]\\d{2})?', 1),
  ],
  book: [
    w('books?|novels?|reading list|booktok|bookstagram|tbr|paperback|hardback|audiobooks?', 3),
    w('book ?lists?|book recs?|book recommendations?|books? (?:to|you should|you need to) read|must[- ]reads?|currently reading', 2),
  ],
  music: [
    w('songs?|albums?|playlists?|tracks?|spotify|mixtape', 2),
    w('podcasts?', 2, 'podcast'),
  ],
  article: [w('article|essay|op-ed|newsletter|longread|long read', 2)],
  event: [
    w('concerts?|gigs?|live music|livemusic|live at|in concert|tour dates?|world tour|dj sets?|headlin(?:e|er|ers|ing)|support acts?|line[- ]?ups?|jazz night|live jazz|concerttok|gigtok', 3, 'live-music'),
    w('festivals?|festivaltok|festival season', 3, 'festival'),
    w('tickets?|ticket link|presale|pre-sale|early bird|rsvp|guest ?list|free entry|save the date|register now|book your (?:spot|place|seat|tickets?)', 3),
    w('doors open|doors at|doors from|pop-ups?|popups?|pop up (?:shop|bar|restaurant|event|store)|launch party|opening night|opening party|grand opening|exhibition opening|private view|vernissage|open mic|meetups?|conference|expo|convention|hackathon|webinar|parade|fireworks|carnival|book (?:launch|signing)', 3),
    w('premieres?|screenings?|film club|film festival|outdoor cinema', 3, 'film'),
    w('christmas markets?|xmas markets?|makers markets?|craft fairs?|flea markets?|market this weekend|pop[- ]up markets?', 3, 'market'),
    w('night markets?', 2, 'market'),
    w('workshops?|masterclass(?:es)?|wine tasting|tasting (?:session|evening|night)|supper club', 3, 'workshop'),
    w('(?:cooking|pottery|dance|art|salsa|life drawing|ceramics|painting|yoga|pilates|spin|barre|boxing) class(?:es)?', 3, 'class'),
    w('comedy (?:show|night|club|special|gig)|stand[- ]?up (?:show|comedy|set)|quiz night|karaoke night', 3, 'comedy'),
    w('club night|afterparty|after party|nye party|halloween party|dj night|techno night|silent disco', 3, 'nightlife'),
    w('raves?|ravetok|(?:walking|food|guided|boat|bus) tours?|now showing|last chance to see|final (?:week|weekend|days)|runs until|on until|matchday|match day|kick[- ]?off', 2),
    w('events?|whats on|what.s on|happening|party|parties', 1),
  ],
});

/** Ways to book or turn up. On a video they mean "go to this", not just "watch this". */
const BOOKING_RE = w(
  'tickets?|ticket link|presale|pre-sale|early bird|rsvp|guest ?list|free entry|register now|sign up now|on sale|book (?:now|your (?:spot|place|seat|table|tickets?))|doors open|doors at|doors from|limited (?:spaces|spots|tickets)',
  0,
).re;
/** A recording of, or how-to about, an event rather than the event itself. */
const RECAP_RE = w(
  'highlights?|recap|aftermovie|after movie|full (?:set|show|concert|performance|episode|match|video)|concert film|documentary|vlog|tutorial|how to|reaction|throwback|tbt|official (?:music |lyric )?video|music video|lyric video|ted talk|keynote',
  0,
).re;

// ---------------------------------------------------------------------------
// CJK keyword signals
//
// Chinese and Japanese don't put spaces between words, so word-boundary regexes never match there. These terms
// are found as plain substrings instead, in one pass over the text with a table keyed on each term's first
// character, which costs the same however many terms there are. Terms are written in Traditional Chinese (the
// Simplified spelling is added from T2S); Japanese and Korean spellings are listed as they are.

interface CjkSignal {
  type?: ItemType;
  weight: number;
  tag?: string;
  /** A way to book or turn up (like BOOKING_RE), or a recording / how-to (like RECAP_RE). */
  flag?: 'booking' | 'recap';
  /** The term only counts with this closing mark soon after, and is quoted whole ("《書名》"). */
  close?: string;
}

// Traditional → Simplified, for the characters used in the terms below.
const T2S =
  '處处訪访遊游隱隐點点邊边兒儿裡里絕绝觀观勝胜標标記记駕驾環环島岛國国機机飯饭館馆營营訂订廳厅麵面鍋锅樂乐覓觅餅饼灘滩凍冻潛潜頂顶' +
  '陽阳峽峡園园紅红葉叶楓枫賞赏櫻樱廟庙宮宫蹟迹術术藝艺場场開开時时間间業业麼么東东戶户橫横濱滨輕轻澤泽沖冲繩绳岡冈長长廣广爾尔濟济' +
  '邁迈內内檳槟順顺門门蓮莲墾垦蘭兰慶庆雲云麗丽歐欧倫伦羅罗馬马義义臘腊聖圣亞亚紐纽約约磯矶譜谱學学調调醃腌預预熱热湯汤爐炉氣气電电' +
  '燉炖勻匀攪搅種种濃浓簡简單单懶懒敗败減减廚厨當当運运動动訓训練练鍛锻鍊炼煉炼習习強强線线撐撑頸颈軟软啞哑鈴铃壺壶槓杠壓压著着體体' +
  '態态勢势圓圆駝驼貴贵無无會会騷骚節节華华購购搶抢鳥鸟劇剧話话棟栋篤笃閃闪覽览驗验講讲檔档對对報报顧顾溫温買买齊齐網网團团碼码優优' +
  '價价錢钱幣币鏡镜頭头護护膚肤妝妆錶表聯联書书評评讀读後后說说薦荐繪绘閱阅專专輯辑詞词題题鋼钢結结彈弹烏乌編编欄栏論论導导寶宝療疗' +
  '煙烟郵邮員员納纳試试黃黄傳传統统';

type CjkGroup = [signal: CjkSignal | null, terms: string];

const cg = (type: ItemType | undefined, weight: number, terms: string, tag?: string, flag?: CjkSignal['flag']): CjkGroup => [
  { type, weight, tag, flag },
  terms,
];

/** Each group counts once, like a word signal. A null signal marks words that only look like a term ("運動員"). */
const CJK_GROUPS = (): CjkGroup[] => [
  // Places & travel
  cg('place', 3, '好去處 必去 必訪 必遊 秘境 隱世 避世 寶藏 去邊玩 去哪玩 去哪兒 去哪裡 值得一去 絕景 穴場 가볼만한곳 핫플'),
  cg('place', 2, '打卡 景點 觀光 観光 名勝 地標 勝地 명소 관광'),
  cg('place', 2, '旅行 旅遊 自由行 遊記 行程 自駕遊 自駕 一日遊 度假 渡假 出走 小旅行 環島 打工度假 北上 背包客 出國 機票 旅程 🗺 ✈ 🧳 여행', 'travel'),
  cg('place', 2, '酒店 住宿 民宿 飯店 旅館 度假村 渡假村 露營 營地 入住 退房 訂房 住一晚 🏨 ホテル 호텔 숙소', 'stay'),
  cg('place', 3, '餐廳 食店 茶餐廳 餐館 麵店 居酒屋 火鍋店 レストラン 식당 맛집', 'restaurant'),
  cg('place', 2, '美食 必食 必吃 必試 抵食 吃喝玩樂 搵食 覓食 探店 宵夜 食好西 グルメ'),
  cg('place', 2, '早午餐 ブランチ 브런치', 'brunch'),
  cg('place', 3, '咖啡店 咖啡廳 咖啡館 甜品店 茶室 カフェ 喫茶店 카페', 'coffee'),
  cg('place', 2, '酒吧 清吧', 'drinks'),
  cg('place', 2, '麵包店 餅店 ベーカリー 빵집', 'bakery'),
  cg('place', 2, '海灘 沙灘 海邊 海景 島 果凍海 浮潛 🏖 🏝 ⛱ ビーチ 해변 바다', 'beach'),
  cg('place', 2, '行山 登山 山頂 瀑布 郊野 郊遊 日落 夕陽 日出 觀星 峽谷 公園 花海 紅葉 楓葉 賞花 櫻花 등산', 'outdoors'),
  cg('place', 2, '神社 寺廟 寺 廟 神宮 八幡宮 教堂 古蹟 老城 博物館 美術館 藝術館 城堡 宮殿 ⛩ 박물관', 'culture'),
  cg('place', 2, '溫泉 泡湯 湯泉 水療 スパ 온천'),
  cg('place', 2, '夜市 街市 傳統市場 商店街', 'market'),
  cg('place', 2, '📍 地址 地點 住所 주소'),
  cg('place', 2, '開放時間 營業時間 定休日 休館 點去 怎麼去 怎麼走 交通方式 交通指南 前往方法 如何前往 アクセス'),
  // Somewhere people travel to (not home countries, which turn up in every kind of post).
  cg(
    'place',
    2,
    '北海道 札幌 小樽 函館 富良野 青森 東京 大阪 京都 奈良 神戶 神戸 名古屋 橫濱 横浜 箱根 輕井澤 軽井沢 富士山 沖繩 沖縄 福岡 九州 宮崎 ' +
      '鹿兒島 鹿児島 熊本 長崎 廣島 広島 四國 金澤 金沢 仙台 首爾 서울 釜山 부산 濟州 제주 曼谷 清邁 布吉 普吉 芭堤雅 峇里 巴厘島 峴港 河內 ' +
      '胡志明 新加坡 吉隆坡 檳城 深圳 廣州 珠海 惠州 南澳 順德 澳門 台北 台中 台南 高雄 花蓮 墾丁 宜蘭 九份 上海 北京 成都 重慶 西安 杭州 ' +
      '桂林 雲南 大理 麗江 歐洲 巴黎 倫敦 羅馬 意大利 義大利 法國 南法 瑞士 冰島 西班牙 巴塞隆拿 巴塞隆納 土耳其 希臘 伊斯坦堡 聖托里尼 杜拜 ' +
      '澳洲 雪梨 悉尼 墨爾本 黃金海岸 塔斯曼尼亞 紐西蘭 新西蘭 紐約 洛杉磯 夏威夷',
  ),

  // Recipes
  cg('recipe', 3, '食譜 菜譜 煮法 教煮 料理教學 レシピ 作り方 레시피'),
  cg('recipe', 3, '材料 用料 調味料 醃 預熱 湯匙 茶匙 下鍋 爆香 焗爐 烤箱 電飯煲 재료'),
  cg('recipe', 2, '氣炸鍋 ノンフライヤー 에어프라이어', 'air-fryer'),
  cg('recipe', 2, '做法 煮 焗 燉 炆 小炒 清蒸 炒香 煎香 炸至 煎至 拌勻 攪拌 下廚 家常菜 自煮 便當 만들기'),
  cg('recipe', 2, '甜品 甜點 蛋糕 曲奇 布甸 布丁 スイーツ 디저트', 'dessert'),
  cg('recipe', 2, '麵包 酸種 烘焙 吐司', 'baking'),
  cg('recipe', 2, '煲湯 湯水 老火湯 濃湯', 'soup'),
  cg('recipe', 2, '咖喱 咖哩 カレー', 'curry'),
  cg('recipe', 1, '減脂餐 健康餐 低卡 高蛋白', 'healthy'),
  cg('recipe', 1, '簡單 簡単 快手 懶人 零失敗 簡易', 'quick'),

  // Workouts
  cg('workout', 3, '運動 健身 訓練 鍛鍊 鍛煉 健身房 居家運動 重訓 筋トレ トレーニング 운동 홈트'),
  cg('workout', 3, '高強度間歇', 'hiit'),
  cg('workout', 2, '腹肌 核心肌群 馬甲線 小腹 平板支撐 腹筋 복근', 'core'),
  cg('workout', 2, '臀 瘦腿 練腿 美腿 하체', 'legs'),
  cg('workout', 3, '瑜伽 瑜珈 ヨガ 요가', 'yoga'),
  cg('workout', 3, '皮拉提斯 普拉提 彼拉提斯 ピラティス 필라테스', 'pilates'),
  cg('workout', 2, '拉筋 拉伸 伸展 舒展 筋膜 肩頸 柔軟度 ストレッチ 스트레칭', 'mobility'),
  cg('workout', 2, '跑步 有氧 慢跑 燃脂 跳繩 馬拉松', 'cardio'),
  cg('workout', 2, '肌肉 肌群 增肌 啞鈴 壺鈴 槓鈴 深蹲 硬拉 掌上壓 伏地挺身', 'strength'),
  cg('workout', 2, '動作 跟著做 跟住做 跟練 一起練 在家練習 居家練習 徒手 免器材 不需要器材 無需器材'),
  cg('workout', 2, '體態 姿勢 圓肩 駝背 寒背 富貴包'),

  // Events
  cg('event', 3, '演唱會 音樂會 開騷 ライブ 콘서트', 'live-music'),
  cg('event', 3, '音樂節 嘉年華 フェス 페스티벌', 'festival'),
  cg('event', 3, '門票 購票 訂票 售票 搶票 公售 開售 預售 早鳥 入場券 チケット 티켓 예매', undefined, 'booking'),
  cg('event', 3, '音樂劇 舞台劇 話劇 劇場 演出 首演 公演 棟篤笑 沉浸式劇場 沉浸式演出 ミュージカル 뮤지컬 공연'),
  cg('event', 3, '快閃 限定店 期間限定 煙花 巡遊 花火大会 ポップアップ 팝업'),
  cg('event', 3, '展覽 特展 藝術展 展出 開幕 漫展 書展 博覽會 展覧会 展示会 전시'),
  cg('event', 3, '工作坊 體驗班 手作班 講座 分享會 ワークショップ 워크숍 원데이클래스', 'workshop'),
  cg('event', 3, '首映 放映 電影節 影展', 'film'),
  cg('event', 2, '展期 演期 檔期'),
  cg('event', 2, '市集', 'market'),
  cg('event', 1, '派對 盛事 節目 イベント 이벤트'),
  cg(undefined, 0, '報名 預約 預訂 立即登記', undefined, 'booking'),
  cg(undefined, 0, '回顧 精華 花絮 重溫 教學 教程', undefined, 'recap'),

  // Products
  cg('product', 2, '購買 購入 買齊 買到 入手 下單 網購 團購 免運 包郵 優惠碼 折扣碼 優惠券 減價 特價 折扣 買一送一 訂購 🛒 구매 할인'),
  cg('product', 3, '好物 開箱 種草 敗家 必買 開封 언박싱', 'wishlist'),
  cg('product', 1, '價格 價錢 售價 定價 原價 港幣'),
  cg('product', 2, '相機 鏡頭 耳機 香水 護膚品 化妝品 口紅 唇膏 面霜 乳霜 精華液 手袋 包包 波鞋 球鞋 運動鞋 運動服 手錶 コスメ 향수'),
  cg('product', 2, '品牌 牌子 聯名 新品 新色 限量'),

  // Books
  cg('book', 3, '書單 好書 書評 讀後感 推薦書 必讀 讀書會 読書 おすすめ本 독서 책추천'),
  cg('book', 2, '小說 新書 繪本 書籍 書店 出版社 小説'),
  cg('book', 2, '閱讀 讀書 看書 讀完'),

  // Music & podcasts
  cg('music', 2, '音樂 歌曲 新歌 單曲 專輯 歌單 歌詞 翻唱 主題曲 播放清單 歌 音楽 プレイリスト 노래 음악 🎵 🎶'),
  cg('music', 2, '鋼琴 結他 吉他 和弦 樂理 自彈自唱 樂器 烏克麗麗 作曲 編曲 節奏 節奏訓練 爵士鼓 ピアノ ギター 피아노 🎹 🎸'),
  cg('music', 2, '播客 電台節目 ポッドキャスト 팟캐스트', 'podcast'),

  // Articles
  cg('article', 2, '文章 全文 專欄 長文 社論 報導 報道 記事 기사 칼럼'),

  [null, '運動員 運動會 社會運動 動作片 歌舞伎 島國'],
];

const BOOK_TITLE: CjkSignal = { type: 'book', weight: 1, close: '》' };

// Built on first use (or by the warm-up), like the word signals.
type CjkTable = Map<number, [term: string, signal: CjkSignal | null][]>;
let cjkTable: CjkTable | undefined;
function cjkTerms(): CjkTable {
  if (cjkTable) return cjkTable;
  const t2s = new Map<string, string>();
  for (let i = 0; i + 1 < T2S.length; i += 2) t2s.set(T2S[i], T2S[i + 1]);
  const table: CjkTable = new Map();
  const added = new Set<string>();
  const add = (term: string, signal: CjkSignal | null) => {
    if (added.has(term)) return;
    added.add(term);
    const bucket = table.get(term.charCodeAt(0));
    if (bucket) bucket.push([term, signal]);
    else table.set(term.charCodeAt(0), [[term, signal]]);
  };
  for (const [signal, terms] of [...CJK_GROUPS(), [BOOK_TITLE, '《'] as CjkGroup]) {
    for (const term of terms.split(' ')) {
      add(term, signal);
      let simplified = '';
      for (let k = 0; k < term.length; k++) simplified += t2s.get(term[k]) ?? term[k];
      if (simplified !== term) add(simplified, signal);
    }
  }
  // Longest first, so "居家運動" wins over "運動" and "廣島" over "島".
  for (const bucket of table.values()) if (bucket.length > 1) bucket.sort((x, y) => y[0].length - x[0].length);
  return (cjkTable = table);
}

/** Everything below this is Latin, Greek, Cyrillic, symbols…: no term starts there (✈ U+2708 is the lowest). */
const CJK_SCAN_FROM = 0x2600;

/** Adds the CJK terms found in `text` to `ev`, and reports any booking or recap words. */
function scanCjk(text: string, ev: Map<ItemType, Evidence>): { booking: boolean; recap: boolean } {
  let table: CjkTable | undefined; // only built once there's something it could match
  const seen = new Set<CjkSignal>();
  let booking = false;
  let recap = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < CJK_SCAN_FROM) continue;
    const bucket = (table ??= cjkTerms()).get(code);
    if (!bucket) continue;
    for (const [term, signal] of bucket) {
      if (!text.startsWith(term, i)) continue;
      let found = term;
      if (signal?.close) {
        const end = text.indexOf(signal.close, i + 1);
        if (end < 0 || end - i > 40) continue;
        found = text.slice(i, end + 1);
      }
      i += found.length - 1;
      if (signal && !seen.has(signal)) {
        seen.add(signal);
        if (signal.flag === 'booking') booking = true;
        if (signal.flag === 'recap') recap = true;
        if (signal.type && signal.weight) {
          const e = ev.get(signal.type) ?? { score: 0, terms: [], tags: [] };
          e.score += signal.weight;
          e.terms.push({ term: found, weight: signal.weight });
          if (signal.tag && !e.tags.includes(signal.tag)) e.tags.push(signal.tag);
          ev.set(signal.type, e);
        }
      }
      break;
    }
  }
  return { booking, recap };
}

// Kana, CJK ideographs and Hangul. Word signals read the text with each run of these as one space: "去cafe打卡"
// then reads "cafe", and a long Chinese caption leaves them only its few Latin words to scan.
const CJK_RUN_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

/** Keyword types in tie-break order; event goes last so ties never produce a surprise event. */
const KEYWORD_ORDER: ItemType[] = ['recipe', 'workout', 'place', 'product', 'book', 'music', 'article', 'event'];
const TYPE_ORDER: ItemType[] = [...KEYWORD_ORDER, 'video', 'note', 'link'];

const OVERRIDABLE = new Set<ItemType>(['link', 'video', 'note']);

/** Place words that describe somewhere an event could happen. */
const VENUE_TAGS = new Set(['restaurant', 'coffee', 'drinks', 'brunch', 'bakery', 'culture', 'market']);

const IGNORED_HASHTAGS = new Set([
  'fyp', 'foryou', 'foryoupage', 'fy', 'fypシ', 'viral', 'trending', 'reels', 'reel', 'tiktok', 'explore',
  'explorepage', 'instagood', 'instagram', 'xyzbca', 'capcut', 'youtube', 'shorts', 'ytshorts', 'duet',
  'stitch', 'foryoupageofficiall', 'viralvideo', 'trend', 'follow', 'like', 'foryourpage', 'fypage',
  'viraltiktok', 'reelsinstagram', 'instadaily', 'photooftheday', 'picoftheday', 'reelitfeelit', 'trendingreels',
  'youtubeshorts', 'shortsvideo', 'xhs', '小红书', 'rednote', 'lemon8', 'douyin', '抖音',
]);

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^[#＃]+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

export function hashtags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_&/#＃])[#＃]([\p{L}\p{N}_]{2,40})/gu)) {
    if (!/\p{L}/u.test(m[1])) continue; // "#1" is a ranking, not a tag
    const t = normalizeTag(m[1]);
    if (t && !IGNORED_HASHTAGS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

interface Term {
  term: string;
  weight: number;
}

interface Evidence {
  score: number;
  terms: Term[];
  tags: string[];
}

interface Scored {
  ev: Map<ItemType, Evidence>;
  /** Words for booking or turning up, and for a recording or how-to (see eventAllowed). */
  booking: boolean;
  recap: boolean;
}

function scoreText(text: string): Scored {
  const out = new Map<ItemType, Evidence>();
  const latin = text.replace(CJK_RUN_RE, ' ');
  for (const type of KEYWORD_ORDER) {
    const e: Evidence = { score: 0, terms: [], tags: [] };
    for (const s of keywordSignals()[type] ?? []) {
      const m = s.re.exec(latin);
      if (!m) continue;
      e.score += s.weight;
      e.terms.push({ term: m[1].toLowerCase().replace(/\s+/g, ' ').trim(), weight: s.weight });
      if (s.tag && !e.tags.includes(s.tag)) e.tags.push(s.tag);
    }
    if (e.score > 0) out.set(type, e);
  }
  const cjk = scanCjk(text, out);
  return { ev: out, booking: cjk.booking || BOOKING_RE.test(latin), recap: cjk.recap || RECAP_RE.test(latin) };
}

/** A letter, digit or "_" for hashtag purposes, by code unit: ASCII, kana, CJK ideographs, Hangul. */
const isWordCode = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 ||
  (c >= 0x3040 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff);

/** Whether a CJK term is a hashtag of its own: "#自由行", not "#日本自由行" or "#自由行日記". */
function cjkHashtag(text: string, term: string): boolean {
  for (const mark of ['#', '＃']) {
    const tag = mark + term;
    for (let i = text.indexOf(tag); i >= 0; i = text.indexOf(tag, i + 1)) {
      if ((i === 0 || !isWordCode(text.charCodeAt(i - 1))) && !isWordCode(text.charCodeAt(i + tag.length))) return true;
    }
  }
  return false;
}

/** Matches that are patterns rather than words, described instead of quoted ("best pasta in" → a list). */
const PATTERN_TERMS: [RegExp, string][] = [[/^best .+ in$/, 'reads like a “best … in” list']];

/**
 * "mentions ingredients, oven" and "#pasta #dinnerideas" from the matched keywords, strongest first.
 * `human` is the shared text without the URL; `pathWords` allows words found only in the URL.
 */
function termReasons(terms: Term[], human: string, pathWords: boolean): string[] {
  const words: string[] = [];
  const tags: string[] = [];
  const phrases: string[] = [];
  let wordWeight = 0;
  let tagWeight = 0;
  const text = human.toLowerCase().replace(/\s+/g, ' ');
  const shown = terms.filter(({ term }) => pathWords || text.includes(term)).sort((a, b) => b.weight - a.weight);
  const top = shown[0]?.weight ?? 0;
  // CJK terms have no spaces around them: "旅遊" is inside "旅遊攻略" as it is.
  const within = (inner: string, outer: string) =>
    inner.charCodeAt(0) >= CJK_SCAN_FROM ? outer.includes(inner) : ` ${outer} `.includes(` ${inner} `);
  for (const { term, weight } of shown) {
    // Modifiers like "quick" or "15 minute" only explain a guess when nothing stronger does.
    if (weight < 2 && top >= 2) continue;
    const phrase = PATTERN_TERMS.find(([re]) => re.test(term))?.[1];
    if (phrase) {
      if (!phrases.includes(phrase)) phrases.push(phrase);
      continue;
    }
    const isTag =
      term.charCodeAt(0) >= CJK_SCAN_FROM
        ? cjkHashtag(text, term)
        : new RegExp(`(?:^|[^\\p{L}\\p{N}_])[#＃]${escapeRe(term)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
    if (isTag) {
      if (!tags.includes(`#${term}`)) tags.push(`#${term}`);
      tagWeight = Math.max(tagWeight, weight);
      continue;
    }
    // "festival" and "film festival" say the same thing: keep the more specific one, in place.
    if (words.some((w) => within(term, w))) continue;
    const i = words.findIndex((w) => within(w, term));
    if (i < 0) words.push(term);
    else {
      words[i] = term;
      for (let j = words.length - 1; j > i; j--) if (within(words[j], term)) words.splice(j, 1);
    }
    wordWeight = Math.max(wordWeight, weight);
  }
  const mentions = words.length
    ? `mentions ${words.slice(0, 3).map((t) => (t.length > 28 ? `${t.slice(0, 27)}…` : t)).join(', ')}`
    : '';
  const hashes = tags.slice(0, 3).join(' ');
  const out = tagWeight > wordWeight ? [hashes, mentions] : [mentions, hashes];
  return [...out, ...phrases].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Time hints — a light check for "is this happening at a particular time?".
// Proper date parsing lives elsewhere; this only needs to spot the phrase.

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTHS_NO_MAY = MONTHS.replace('|may|', '|');
const DAYS = '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)day';
const DAYS_SHORT = 'mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun';
const ORD = '(?:st|nd|rd|th)?';
const WD_PREFIX = `(?:(?:${DAYS}|(?:${DAYS_SHORT})\\.?),?\\s+)?`;
const NOT_QUANTITY = '(?![.:]\\d|\\s*(?:%|k\\b|km|mi\\b|miles?|mins?|minutes?|hrs?|hours?|g\\b|kg|ml|cups?|tbsp|tsp|lbs?|oz))';

const STRONG_HINTS: RegExp[] = [
  new RegExp(`\\b${WD_PREFIX}\\d{1,2}${ORD}(?:\\s*[-–]\\s*\\d{1,2}${ORD})?\\s+(?:of\\s+)?(?:${MONTHS})\\b\\.?(?:\\s+20\\d{2})?`, 'gi'),
  new RegExp(`\\b${WD_PREFIX}(?:${MONTHS_NO_MAY})\\.?\\s+\\d{1,2}${ORD}\\b${NOT_QUANTITY}`, 'gi'),
  new RegExp(`\\bMay\\s+\\d{1,2}${ORD}\\b${NOT_QUANTITY}`, 'g'), // case-sensitive: "may" is usually a verb
  new RegExp(`\\b(?:${MONTHS})\\s+20\\d{2}\\b`, 'gi'),
  /\b20\d{2}-[01]\d-[0-3]\d\b/g,
  /\b[0-3]?\d[/.][01]?\d[/.](?:20)?\d{2}\b/g,
  /\b(?:tonight|tonite|tmrw|tomorrow(?:\s+(?:night|evening|morning|afternoon))?)\b/gi,
  new RegExp(`\\b(?:this|next|coming)\\s+(?:weekend|week|month|${DAYS}|${DAYS_SHORT})\\b`, 'gi'),
  new RegExp(`\\bon\\s+${DAYS}\\b`, 'gi'),
  new RegExp(`\\b${DAYS}\\s+(?:night|evening|(?:at\\s+)?\\d{1,2}(?::[0-5]\\d)?\\s*(?:am|pm))\\b`, 'gi'),
  // "10月3日", "9月5日至11月20日", "10月3-9", "日期：3/12", "Dates: 3/12"
  /\d{1,2}月\d{1,2}(?:[日號号]?\s*[-–~～至到]\s*(?:\d{1,2}月)?\d{1,2}[日號号]?|[日號号])|(?:日期|展期|檔期|档期|演期|\bdates?)\s*[:：]\s*\d{1,2}\s*[/.月]\s*\d{1,2}(?:\s*[-–~～至到]\s*\d{1,2}\s*[/.月]\s*\d{1,2})?/gi,
];

const WEAK_HINTS: RegExp[] = [
  /\b\d{1,2}(?::[0-5]\d)?\s?(?:am|pm)\b/gi,
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/g,
  /\b(?:this|next)\s+(?:spring|summer|autumn|fall|winter)\b/gi,
];

// Opening hours and routines aren't events: "open Saturday", "every Friday night".
const RECURRING_BEFORE = /\b(?:every|open|closed)\s+(?:on\s+)?$/i;
// When a post went up, not a date in it: "1,234 likes, 5 comments - chef on August 1, 2026: …" (handles are lowercase).
const POSTED_BEFORE = /^(?:[\d.,]+\s*[KkMm]?\s+likes?,\s*[\d.,]+\s*[KkMm]?\s+comments?\s*[-–—]\s*)?[a-z0-9._]{1,30} on $/;
const POSTED_AFTER = /^,\s*\d{4}(?::|\s*(?:\n|$))/;

interface TimeHint {
  phrase: string;
  strong: boolean;
}

function findTimeHint(text: string): TimeHint | undefined {
  if (!text) return undefined;
  const find = (patterns: RegExp[]) => {
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const at = m.index ?? 0;
        const before = text.slice(Math.max(0, at - 16), at);
        if (RECURRING_BEFORE.test(before)) continue;
        const line = text.lastIndexOf('\n', at - 1) + 1;
        const end = at + m[0].length;
        if (at - line < 120 && POSTED_BEFORE.test(text.slice(line, at)) && POSTED_AFTER.test(text.slice(end, end + 12))) continue;
        return m[0].replace(/\s+/g, ' ').trim().slice(0, 40);
      }
    }
    return undefined;
  };
  const strong = find(STRONG_HINTS);
  if (strong) return { phrase: strong, strong: true };
  const weak = find(WEAK_HINTS);
  return weak ? { phrase: weak, strong: false } : undefined;
}

/**
 * A time-bound phrase makes an event likelier: strongly when event words are there
 * already, and enough to beat a venue ("exhibition at the Tate this Saturday").
 * Returns the venue evidence it leaned on, if any.
 */
function applyTimeHint(ev: Map<ItemType, Evidence>, hint: TimeHint | undefined): Evidence | undefined {
  if (!hint) return undefined;
  const event = ev.get('event') ?? { score: 0, terms: [], tags: [] };
  const place = ev.get('place');
  const venueTerms = place && place.tags.some((t) => VENUE_TAGS.has(t)) ? place : undefined;
  let boost = 0;
  let leaned: Evidence | undefined;
  if (hint.strong) {
    if (event.score > 0) boost = 3;
    else if (venueTerms) {
      boost = Math.min(venueTerms.score + 1, 4);
      leaned = venueTerms;
    } else boost = 1;
  } else if (event.score > 0) boost = 1;
  if (boost) ev.set('event', { ...event, score: event.score + boost });
  return leaned;
}

/**
 * Whether keywords may re-file a link, video or note as an event. A gig video, festival recap
 * or workshop tutorial is still a video: it needs a date or a way to book, and recap words
 * ("highlights", "full set", "tutorial") rule it out unless it has both.
 */
function eventAllowed(baseType: ItemType, hint: TimeHint | undefined, { booking, recap }: Scored): boolean {
  const dated = !!hint?.strong;
  if (baseType === 'video') return (dated || booking) && (!recap || (dated && booking));
  return !recap || dated || booking;
}

// ---------------------------------------------------------------------------
// Places

export function parseLatLng(s: string | null | undefined): Place | undefined {
  if (!s) return undefined;
  const m = s.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return undefined;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  return { lat, lng };
}

/** Pulls coordinates and a place name out of Google / Apple / OSM map links and geo: URIs. */
export function parsePlaceFromUrl(url: string | undefined): { place?: Place; name?: string } {
  if (!url) return {};
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return {};
  }

  if (u.protocol === 'geo:') {
    const [coords] = decodeURIComponent(u.pathname).split(';');
    const q = u.searchParams.get('q') ?? undefined;
    const qName = q?.match(/\(([^)]+)\)\s*$/)?.[1];
    const place = parseLatLng(coords) ?? parseLatLng(q?.replace(/\(.*$/, ''));
    return { place: place && (place.lat !== 0 || place.lng !== 0) ? place : undefined, name: qName ?? (q && !parseLatLng(q) ? q : undefined) };
  }

  const path = decodeURIComponent(u.pathname);
  let place: Place | undefined;
  let name: string | undefined;

  const pin = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pin) place = { lat: Number(pin[1]), lng: Number(pin[2]) };
  if (!place) {
    const at = path.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (at) place = { lat: Number(at[1]), lng: Number(at[2]) };
  }
  for (const key of ['ll', 'q', 'query', 'center', 'destination', 'daddr', 'sll', 'coordinate']) {
    if (place) break;
    place = parseLatLng(u.searchParams.get(key));
  }
  if (!place && u.hash) {
    // openstreetmap.org/#map=16/51.5/-0.12
    const osm = u.hash.match(/map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
    if (osm) place = { lat: Number(osm[1]), lng: Number(osm[2]) };
  }

  const named = path.match(/\/(?:place|search)\/([^/@]+)/);
  if (named) name = named[1].replace(/\+/g, ' ').trim();
  if (!name) {
    for (const key of ['q', 'query', 'name', 'address']) {
      const v = u.searchParams.get(key);
      if (v && !parseLatLng(v)) {
        name = v.replace(/\+/g, ' ').trim();
        break;
      }
    }
  }
  return { place, name: name || undefined };
}

// ---------------------------------------------------------------------------
// Titles

export function youtubeId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const host = hostOf(url);
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || undefined;
    if (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v) return v;
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return undefined;
}

// Locale folders ("/intl-de/", "/en-gb/") aren't titles.
const LOCALE_SEGMENT_RE = /^(?:intl-[a-z]{2}(?:[-_][a-z]{2})?|[a-z]{2}[-_][a-z]{2})$/i;

function prettifySlug(segment: string, allowSingleWord = false): string | undefined {
  let s: string;
  try {
    s = decodeURIComponent(segment);
  } catch {
    s = segment;
  }
  s = s.replace(/\.(html?|php|aspx?)$/i, '');
  if (LOCALE_SEGMENT_RE.test(s)) return undefined;
  // Drop trailing numeric ids like "-123456".
  s = s.replace(/[-_]\d{3,}$/, '');
  if (!/[a-z]/i.test(s)) return undefined;
  const words = s.split(/[-_+]+/).filter(Boolean);
  if (words.length < (allowSingleWord ? 1 : 2)) return undefined; // single words are usually ids or sections
  const digitShare = s.replace(/\D/g, '').length / s.length;
  if (digitShare > 0.3) return undefined;
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function titleFromUrl(url: string): string {
  const host = hostOf(url);
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const t = prettifySlug(segments[i]);
      if (t) return t;
    }
  } catch {
    /* fall through */
  }
  return host || url;
}

const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const SITE_NAMES = [
  'YouTube Music', 'YouTube', 'TikTok', 'Instagram', 'Facebook', 'Pinterest', 'Reddit', 'X', 'Twitter', 'Threads',
  'LinkedIn', 'Bluesky', 'Vimeo', 'Twitch', 'Kick', 'Spotify', 'Apple Music', 'Apple Podcasts', 'SoundCloud',
  'Bandcamp', 'Eventbrite', 'Ticketmaster', 'Meetup', 'Luma', 'Partiful', 'DICE', 'Resident Advisor', 'Songkick',
  'Bandsintown', 'Skiddle', 'Fever', 'Google Maps', 'Apple Maps', 'Letterboxd', 'IMDb', 'Goodreads', 'Etsy', 'eBay',
  'Substack', 'Medium', 'Lemon8', 'RedNote', '小红书', 'Douyin', '抖音', 'Snapchat', 'Tripadvisor', 'Yelp', 'OpenTable',
  'Airbnb', 'Booking.com', 'Wikipedia', 'Steam', 'BBC Good Food', 'Allrecipes', 'OpenRice',
]
  .map(escapeRe)
  .concat(['Amazon(?:\\.[a-z]{2,3}(?:\\.[a-z]{2})?)?', 'Time Out[\\p{L} ]{0,20}'])
  .join('|');

const SITE_SUFFIX_RE = new RegExp(`\\s*(?:[|·•]|\\s[-–—:/])\\s*(?:${SITE_NAMES})(?:\\s*[-–—]\\s*[^|]{0,30})?\\s*$`, 'iu');
const ON_SITE_RE = /\s+on\s+(?:TikTok|Instagram|YouTube|Pinterest|RedNote|Lemon8|Steam|Spotify|Apple Music|Apple Podcasts|Letterboxd)\s*$/iu;
const SITE_ONLY_RE = new RegExp(`^(?:${SITE_NAMES})$`, 'iu');
const EVENT_SITE_SUFFIX_RE =
  /(?:[|·•]|\s[-–—])\s*(?:Eventbrite|Ticketmaster|DICE|Resident Advisor|Songkick|Bandsintown|Skiddle|Fever|See Tickets|Eventim|AXS|Live Nation|Ticket Tailor|Humanitix)\b[^|]{0,30}$/iu;
const TICKETS_BEFORE_DATE_RE = /\s+Tickets(?=,\s+(?:\d|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))/u;
const JUNK_TITLE_RE =
  /^(?:just a moment\.*|attention required!?(?:\s*\|\s*cloudflare)?|access denied|(?:403 )?forbidden|(?:404 )?not found|404|page not found|error|log ?in|sign ?in|sign up|log in or sign up(?: to view)?|log into facebook|robot check|are you a robot\??|captcha|redirecting\.*|loading\.*|untitled|tiktok\s*[-–·|]\s*make your day|reddit\s*[-–]\s*dive into anything)$/i;

const PLATFORMS = 'instagram|tiktok|youtube|facebook|pinterest|rednote|lemon8|snapchat|threads';
const ON_PLATFORM = `\\s+on\\s+(?:${PLATFORMS}|x|twitter|douyin|小红书)`;
const POST_WORDS = 'video|post|reel|tiktok|pin|note|photo|profile|live|story|clip|short|carousel';
const HANDLE = '@[\\w.]{1,30}';

/** Share-sheet wrappers: "Check out @chef's video!", "Watch this reel by @x on Instagram". */
const CHECK_OUT_NAMED = new RegExp(
  `^(?:check out|watch|see|look at|view)\\s+(${HANDLE}|[^\\s!?.'’][^!?\\n'’]{0,38}?)['’]s\\s+(?:(?:${PLATFORMS})\\s+)?(?:${POST_WORDS})s?\\b(?:${ON_PLATFORM})?(?:\\s*[!.:]+|(?=\\s*(?:[#＃@]|$)))`,
  'iu',
);
const CHECK_OUT_BY = new RegExp(
  `^(?:check out|watch|see|look at|view)\\s+(?:(?:this|the|my|a)\\s+)?(?:(?:${PLATFORMS})\\s+)?(?:${POST_WORDS})s?\\b(?:\\s+(?:by|from)\\s+(${HANDLE}|[^\\s!?.•·|]+(?:\\s[^\\s!?.•·|]+){0,3}?))?(?:${ON_PLATFORM})?\\s*(?:[!.:]+|\\s*[•·|].*$|$)`,
  'iu',
);

interface Stripped {
  text: string;
  author?: string;
}

/** Removes platform boilerplate around a title. `strict` also drops login walls and bare site names. */
function stripBoilerplate(input: string, strict: boolean): Stripped {
  let s = input.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim();
  let author: string | undefined;
  const found = (who: string | undefined) => {
    const a = who?.trim().replace(/[:,]+$/, '');
    if (a && !author) author = a;
  };
  /** Replaces the whole title with a captured group (nothing if `keep` is omitted), remembering the author. */
  const extract = (re: RegExp, keep?: number, who?: number): boolean => {
    const m = s.match(re);
    if (!m) return false;
    if (who !== undefined) found(m[who]);
    s = keep === undefined ? '' : (m[keep] ?? '').trim();
    return true;
  };
  /** Cuts the matched part out, remembering the author. */
  const cut = (re: RegExp, who?: number): boolean => {
    const m = s.match(re);
    if (!m) return false;
    if (who !== undefined) found(m[who]);
    s = s.replace(re, ' ').replace(/\s+/g, ' ').trim();
    return true;
  };

  if (strict && JUNK_TITLE_RE.test(s)) return { text: '' };

  // RedNote / Douyin share codes and copy instructions.
  cut(/😆\s*[A-Za-z0-9]+\s*😆/u);
  cut(/[，,]?\s*复制(?:此|本条)(?:链接|信息)[^\n]*$/u);
  cut(/^[\d.]*\s*复制打开抖音[，,]?\s*看看/u);
  cut(/【([^】]{1,30})的作品】/u, 1);
  cut(/^[^\n]{0,30}?发布了一篇小红书笔记[，,]?\s*快来看吧[！!]?/u);
  if (/^【[^】]+】$/u.test(s)) s = s.slice(1, -1).trim();
  if (!extract(/^(.*?)\s+-\s+[^-|]{1,30}\s*\|\s*小红书.*$/u, 1)) cut(/\s*[-|]\s*小红书.*$/u);

  // Captions wrapped in page titles / descriptions; the first that matches wins.
  const wrappers: [RegExp, number, number?][] = [
    // '1,234 likes, 56 comments - chef on January 1, 2024: "Caption"'
    [/^[\d.,]+\s*[KkMm]?\s+likes?,\s*[\d.,]+\s*[KkMm]?\s+comments?\s*[-–—]\s*([\w.]+)\s+on\s+[^:]{3,40}:\s*["“](.*?)["”]?\s*\.?$/iu, 2, 1],
    // 'TikTok video from Chef (@chef): "Caption". original sound'
    [/^(?:[\d.,]+\s*[KkMm]?\s+likes?,\s*[\d.,]+\s*[KkMm]?\s+comments?\.\s*)?tiktok video from\s+[^(]{1,60}?\s*\((@[\w.]+)\)\s*:\s*["“](.*?)["”]\.?.*$/iu, 2, 1],
    // 'Chef on Instagram: "Caption"', 'Name on X: "Post" / X'
    [/^(.{1,60}?)\s+on\s+(?:instagram|tiktok|x|twitter|threads|bluesky|linkedin|facebook|lemon8|rednote)\s*:\s*["“](.*?)["”]?\s*(?:\/\s*(?:x|twitter))?$/iu, 2, 1],
    [/^(.{1,60}?)\s+on\s+(?:linkedin|x|twitter|threads|bluesky)\s*:\s+(.+)$/iu, 2, 1],
    // 'Watch "Title" on YouTube'
    [/^watch\s+["“](.+?)["”]\s+on\s+youtube\b.*$/iu, 1],
  ];
  wrappers.some(([re, keep, who]) => extract(re, keep, who));

  // Share-sheet wrappers.
  if (!cut(CHECK_OUT_NAMED, 1)) cut(CHECK_OUT_BY, 1);
  cut(/\s*\((@[\w.]+)\)\s*[•·]\s*instagram photos and videos\s*$/iu, 1);
  extract(/^instagram\s+(?:post|photo|video|reel)s?\s+(?:by|from)\s+([^•·]{1,60}?)\s*(?:[•·].*)?$/iu, undefined, 1);

  // Site names and trailers ("Title - Channel - YouTube" can stack).
  const fromEventSite = EVENT_SITE_SUFFIX_RE.test(s);
  for (let i = 0; i < 3; i++) if (!cut(SITE_SUFFIX_RE) && !cut(ON_SITE_RE)) break;
  cut(/\s*\b(?:shared|sent)\s+(?:via|from|using)\s+(?:the\s+|my\s+)?[\p{L}\p{N} .'’-]{2,30}?(?:\s+app)?\s*[.!]?\s*$/iu);
  cut(/\s*\bvia\s+@[\w.]+\s*$/iu);
  cut(/\s*♬.*$/u);
  cut(/\s*\|\s*\d[\d.,]*\s*[KkMm]?\s+comments?\s*$/iu);
  cut(/\s*:\s*r\/\w+\s*$/iu);
  cut(/^r\/\w+\s*[-–:]\s+/iu);
  cut(/\s*\((@[\w.]+)\)\s*$/u, 1);
  // Ticket sites: "Jazz Night Tickets, Sat 12 Oct", "Jazz Night Tickets | Eventbrite" — not "Buy Glastonbury Tickets".
  if (s.split(' ').length > 2) s = s.replace(fromEventSite ? /\s+Tickets(?=$|,\s)/u : TICKETS_BEFORE_DATE_RE, '');
  if (strict && SITE_ONLY_RE.test(s)) s = '';
  return { text: s, author };
}

function ignoredHashtagRe(): RegExp {
  const words = [...IGNORED_HASHTAGS].map(escapeRe).join('|');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])[#＃](?:${words})(?![\\p{L}\\p{N}_])`, 'giu');
}
const IGNORED_HASHTAG_RE = ignoredHashtagRe();

/** Shortens to about `max` characters at a word boundary, with an ellipsis. */
function capTitle(s: string, max = 100): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  const base = space >= cut.length * 0.6 ? cut.slice(0, space) : cut;
  return `${base.replace(/[\s,;:.!?·•|/–—-]+$/u, '')}…`;
}

export interface TitleInfo {
  /** The cleaned title, or "" when nothing meaningful is left. */
  title: string;
  /** Creator named in the boilerplate, e.g. "@chef". */
  author?: string;
}

export interface CleanTitleOptions {
  /** Maximum length before it's shortened with an ellipsis (default 100). */
  max?: number;
  /** Also treat login walls ("Just a moment…") and bare site names ("Instagram") as empty (default true). */
  strict?: boolean;
}

const MAX_TITLE_INPUT = 600;

/** Cleans a shared or fetched title and reports any creator it named. */
export function analyzeTitle(raw: string | null | undefined, opts: CleanTitleOptions = {}): TitleInfo {
  return tidyTitle(raw, opts, false);
}

/**
 * `typed` is for text with no link — the user's own words. Then only hashtags are tidied
 * (they become tags); site names, @mentions and "Tickets" stay, since they aren't boilerplate there.
 */
function tidyTitle(raw: string | null | undefined, opts: CleanTitleOptions, typed: boolean): TitleInfo {
  if (!raw) return { title: '' };
  const { max = 100, strict = true } = opts;
  // Only the start can end up in a title; clipping keeps huge pastes cheap.
  const clipped = raw.length > MAX_TITLE_INPUT ? Array.from(raw).slice(0, MAX_TITLE_INPUT).join('') : raw;
  const stripped: Stripped = typed
    ? { text: clipped.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim() }
    : stripBoilerplate(clipped, strict);
  let s = stripped.text;
  let author = stripped.author;

  s = s.replace(IGNORED_HASHTAG_RE, '$1');
  // Clusters of hashtags, and hashtags / @mention clusters trailing off the end, are noise…
  s = s.replace(/(^|\s)(?:[#＃][\p{L}\p{N}_]+[\s,]*){2,}/gu, '$1');
  if (typed) s = s.replace(/(?:^|\s+)[#＃](?=[\p{N}_]*\p{L})[\p{L}\p{N}_]+\s*$/u, '');
  else {
    s = s.replace(/(?:^|(?:\s+@[\w.]+)*\s+)[#＃](?=[\p{N}_]*\p{L})[\p{L}\p{N}_]+(?:\s+@[\w.]+)*\s*$/u, '');
    s = s.replace(/(?:\s+(?:with|w\/|ft\.?|feat\.?|by|and|&))?(?:\s+@[\w.]+,?){2,}\s*$/iu, '');
    const lead = s.match(/^(?:@[\w.]+[\s,:]+)+/u);
    if (lead && /[\p{L}\p{N}]/u.test(s.slice(lead[0].length))) {
      author ??= lead[0].match(/@[\w.]+/u)?.[0];
      s = s.slice(lead[0].length);
    }
  }
  // …a lone hashtag inside a sentence reads as a word.
  s = s.replace(/(^|[^\p{L}\p{N}_&/])[#＃]((?=[\p{N}_]*\p{L})[\p{L}\p{N}_]+)/gu, '$1$2');
  if (!typed) s = s.replace(/(^|\s)(?:(?:with|w\/|ft\.?|feat\.?)\s+)?(?:@[\w.]+[\s,&]*){2,}/giu, '$1');

  s = s
    .replace(/\(\s*\)|\[\s*\]|【\s*】/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s|:·•>»\-–—,;]+|[\s|:·•>»\-–—,;]+$/gu, '')
    .trim();
  const quoted = s.match(/^["“]([^"“”]+)["”]$/u);
  if (quoted) s = quoted[1].trim();
  if (!/[\p{L}\p{N}]/u.test(s)) s = '';
  return { title: s ? capTitle(s, max) : '', author };
}

/** A clean title: no hashtags, @mention clusters or "| TikTok"-style boilerplate, shortened to ~100 chars. */
export function cleanTitle(raw: string | null | undefined, opts: CleanTitleOptions = {}): string {
  return analyzeTitle(raw, opts).title;
}

const SHARE_FOOTER_RE = /^(?:shared|sent)\s+(?:via|from|using)\s+(?:the\s+|my\s+)?[\p{L}\p{N} .'’-]{2,30}?(?:\s+app)?\s*[.!]?$/iu;

/**
 * A line that's nothing but share-sheet boilerplate, e.g. "Shared via Google Maps".
 * Without a link only share footers count, so a typed "• Medium" list item survives.
 */
function isBoilerplateLine(line: string, withLink: boolean): boolean {
  const t = line.replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (!withLink) return SHARE_FOOTER_RE.test(t);
  if (t.length > 300) return false;
  const { text } = stripBoilerplate(t, true);
  return text !== t && !/[\p{L}\p{N}]/u.test(text);
}

/** Whether a typed line's words all made it into its title, apart from hashtags kept as tags (or ignored as noise). */
function keepsWords(line: string, title: string, tags: string[]): boolean {
  const have = new Set(title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  for (const m of line.matchAll(/([#＃])?([\p{L}\p{N}_]+)/gu)) {
    const word = m[2].toLowerCase();
    if (have.has(word)) continue;
    const tag = normalizeTag(word);
    if (m[1] && (tags.includes(tag) || IGNORED_HASHTAGS.has(tag))) continue;
    return false;
  }
  return true;
}

// First path segments on instagram.com that are app pages, not usernames ("/share/p/…" is a share link).
const IG_NOT_USERS = new Set(['share', 'explore', 'stories', 'accounts', 'direct', 'reels', 'reel', 'p', 'tv', 'about', 'legal']);

function handleFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = hostOf(url);
    const p = u.pathname;
    let m = p.match(/\/@([\w.-]{2,40})(?:\/|$)/);
    if (m) return `@${m[1]}`;
    if (hostMatches(host, 'x.com') || hostMatches(host, 'twitter.com')) m = p.match(/^\/(\w{1,15})\/status\//);
    else if (hostMatches(host, 'bsky.app')) m = p.match(/^\/profile\/([\w.:-]+)\//);
    else if (hostMatches(host, 'instagram.com')) m = p.match(/^\/([\w.]{2,30})\/(?:p|reels?)\//);
    if (m && !(hostMatches(host, 'instagram.com') && IG_NOT_USERS.has(m[1].toLowerCase()))) return `@${m[1]}`;
  } catch {
    /* not a URL */
  }
  return undefined;
}

const SPOTIFY_KINDS: Record<string, string> = { track: 'track', album: 'album', playlist: 'playlist', artist: 'artist', episode: 'episode', show: 'podcast' };

function defaultTitle(url: string | undefined, rule: DomainRule | undefined, type: ItemType, placeName?: string, author?: string): string {
  if (placeName) return capTitle(placeName);
  if (!url) return 'Untitled';
  if (url.startsWith('geo:')) return 'Dropped pin';
  const source = rule?.source;
  const label = sourceLabel(source);
  const by = author ?? handleFromUrl(url);
  const path = new URL(url).pathname;
  if (source === 'youtube') return by ? `YouTube video by ${by}` : 'YouTube video';
  if (source === 'tiktok') {
    // The photo-post rule files them as links; everything else on TikTok is a video.
    if (rule?.type === 'link') return by ? `TikTok photo post by ${by}` : 'TikTok photo post';
    return by ? `TikTok by ${by}` : 'TikTok video';
  }
  if (source === 'instagram') {
    const kind = type === 'video' ? 'Instagram reel' : 'Instagram post';
    return by ? `${kind} by ${by}` : kind;
  }
  if (source === 'spotify') {
    // Paths are ids ("/intl-de/episode/4uLU…"), so the kind is the best title there is.
    const segment = path.split('/').filter((s) => s && !s.startsWith('intl-'))[0] ?? '';
    if (Object.hasOwn(SPOTIFY_KINDS, segment)) return `Spotify ${SPOTIFY_KINDS[segment]}`;
  }
  if (source === 'letterboxd') {
    const film = path.match(/^\/(?:[\w.-]+\/)?film\/([^/]+)/)?.[1];
    const name = film ? prettifySlug(film, true) : undefined;
    if (name) return name;
  }
  const fromSlug = titleFromUrl(url);
  if (fromSlug !== hostOf(url)) return type === 'event' ? fromSlug.replace(/\s+tickets?$/i, '') || fromSlug : fromSlug;
  if (rule?.title && type === rule.type) return rule.title;
  if (!label) return fromSlug;
  if (type === 'place') return `Place on ${label}`;
  if (type === 'link' || type === 'video' || type === 'event') {
    const noun = type === 'link' ? 'post' : type;
    return by ? `${label} ${noun} by ${by}` : `${label} ${noun}`;
  }
  return label;
}

/**
 * Picks the first meaningful title from the shared title or text lines, and tidies the note.
 * The line that became the title leaves the note unless the title had to be shortened, or
 * (for typed text, with no link) tidying dropped words that didn't become tags.
 */
function pickTitle(rawTitle: string | undefined, rawNote: string | undefined, withLink: boolean, tags: string[]) {
  let author: string | undefined;
  const clean = (s: string) => {
    const r = tidyTitle(s, { strict: withLink, max: Infinity }, !withLink);
    author ??= r.author;
    return r.title;
  };
  const noteLines = rawNote ? rawNote.split('\n') : [];
  let title = '';
  let lines: string[];
  if (withLink) {
    lines = noteLines;
    if (rawTitle) {
      const full = clean(rawTitle);
      title = capTitle(full);
      if (title !== full) lines.unshift(rawTitle.trim());
    }
    for (let i = 0; !title && i < lines.length; i++) {
      const full = clean(lines[i]);
      if (!full) continue;
      title = capTitle(full);
      if (title === full) lines.splice(i, 1);
    }
  } else {
    // The user's own words: the first line with words in it, else the first line as written.
    lines = rawTitle ? [rawTitle, ...noteLines] : noteLines;
    let at = -1;
    let full = '';
    for (let i = 0; at < 0 && i < lines.length; i++) {
      if (isBoilerplateLine(lines[i], false)) continue;
      full = clean(lines[i]);
      if (full) at = i;
    }
    if (at < 0) {
      at = lines.findIndex((l) => !isBoilerplateLine(l, false));
      full = at >= 0 ? lines[at].replace(/\s+/g, ' ').trim() : '';
    }
    if (at >= 0) {
      title = capTitle(full);
      if (title === full && keepsWords(lines[at], full, tags)) lines.splice(at, 1);
    }
  }
  const note = lines.filter((l) => !isBoilerplateLine(l, withLink)).join('\n') || undefined;
  return { title, note, author };
}

// ---------------------------------------------------------------------------

/**
 * Turns whatever was shared or pasted into a URL, title and note.
 * Share sheets are inconsistent: many apps put the link inside `text`.
 */
export function parseShared(input: SharedInput): { url?: string; title?: string; note?: string } {
  const rawText = (input.text ?? '').trim();
  const url = normalizeUrl(input.url ?? undefined) ?? extractUrl(rawText) ?? extractUrl(input.title ?? undefined);
  let leftover = rawText;
  if (url) {
    const found = rawText.match(URL_RE)?.[0];
    if (found) leftover = rawText.replace(found, ' ');
  }
  leftover = leftover
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  let title = (input.title ?? '').trim();
  if (title && url && extractUrl(title) === url) title = '';
  let note: string | undefined;
  if (!title && leftover) {
    const [first, ...rest] = leftover.split('\n');
    if (first.length <= 140) {
      title = first;
      note = rest.join('\n') || undefined;
    } else {
      note = leftover;
    }
  } else if (leftover && leftover !== title) {
    note = leftover;
  }
  return { url, title: title || undefined, note };
}

const MAX_SHARED_TEXT = 10000;

/** Everything that was shared, as given: title, text and link on separate lines, without repeats. */
export function sharedTextOf(input: SharedInput): string | undefined {
  const parts = [input.title, input.text].map((s) => s?.trim()).filter((s): s is string => !!s);
  const url = input.url?.trim();
  if (url && !parts.some((p) => p.includes(url))) parts.push(url);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i && !parts.some((q, j) => j !== i && q !== p && q.includes(p)));
  const out = unique.join('\n');
  return out ? out.slice(0, MAX_SHARED_TEXT) : undefined;
}

const lf = (s: string) => s.replace(/\r\n?/g, '\n');

/**
 * The original post to keep with a save made in the Save sheet: text another app handed over (the share sheet,
 * the clipboard, a paste or a drop) that is still in the box — never words typed in it, which may be private
 * ("for Anna's birthday, don't tell her") and would otherwise travel with every share of the save.
 */
export function handedText(box: string, handed: readonly string[]): string | undefined {
  const text = lf(box);
  const kept: string[] = [];
  for (const h of handed) {
    const t = lf(h).trim();
    if (!t || !text.includes(t) || kept.some((k) => k.includes(t))) continue;
    // A bigger paste that contains an earlier one replaces it.
    for (let i = kept.length - 1; i >= 0; i--) if (t.includes(kept[i])) kept.splice(i, 1);
    kept.push(t);
  }
  const out = kept.join('\n');
  return out ? out.slice(0, MAX_SHARED_TEXT) : undefined;
}

/** How much the link itself says about the base type. */
function baseEvidence(baseType: ItemType, rule: DomainRule | undefined, isGeo: boolean): number {
  if (isGeo || (rule && !OVERRIDABLE.has(rule.type))) return 8;
  if (baseType === 'video') return 3;
  if (baseType === 'note') return 2;
  return rule ? 1 : 0;
}

export function classify(input: SharedInput): Classification {
  const parsed = parseShared(input);
  const { url } = parsed;
  const isGeo = !!url?.startsWith('geo:');
  const match = url && !isGeo ? matchDomain(url) : undefined;
  const rule = match?.rule;
  const baseType: ItemType = isGeo ? 'place' : url ? rule?.type ?? 'link' : 'note';
  const source = rule?.source;
  const mapInfo = url ? parsePlaceFromUrl(url) : {};

  const human = [parsed.title, parsed.note].filter(Boolean).join('\n');
  const text = [human, url ? safePath(url) : ''].filter(Boolean).join('\n');
  const scored = scoreText(text);
  const { ev } = scored;
  const hint = findTimeHint(human);
  const venue = applyTimeHint(ev, hint);
  const eventOk = !OVERRIDABLE.has(baseType) || eventAllowed(baseType, hint, scored);
  const blockedEvent = eventOk ? undefined : ev.get('event');
  // Still worth offering as a second guess, but not enough to make the base type look unsure.
  if (blockedEvent) ev.set('event', { ...blockedEvent, score: Math.min(blockedEvent.score, 2) });

  let type = baseType;
  if (OVERRIDABLE.has(baseType)) {
    let best: ItemType | undefined;
    let bestScore = 0;
    for (const t of KEYWORD_ORDER) {
      if (t === 'event' && !eventOk) continue;
      const s = ev.get(t)?.score ?? 0;
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    // A clear signal re-files a generic link / video / note, e.g. a TikTok pasta recipe → recipe.
    if (best && bestScore >= 3 && !(baseType === 'video' && (best === 'music' || best === 'article'))) type = best;
  }

  // Scores for every candidate: keyword evidence, plus what the link itself says.
  const scores = new Map<ItemType, number>();
  for (const [t, e] of ev) scores.set(t, e.score);
  scores.set(baseType, Math.max(scores.get(baseType) ?? 0, baseEvidence(baseType, rule, isGeo)));
  const chosen = scores.get(type) ?? 0;
  let runnerUp = 0;
  for (const [t, s] of scores) if (t !== type) runnerUp = Math.max(runnerUp, s);
  const margin = chosen - runnerUp;
  let confidence: Confidence = chosen >= 6 && margin >= 3 ? 'high' : chosen >= 3 && margin >= 1 ? 'medium' : 'low';
  // Plain text with nothing pointing elsewhere is very likely just a note.
  if (type === 'note') confidence = runnerUp >= 2 ? 'low' : 'medium';
  const alternatives = [...scores]
    .filter(([t, s]) => t !== type && s >= 2)
    .sort((a, b) => b[1] - a[1] || TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0]))
    .slice(0, 3)
    .map(([t]) => t);

  const leaned = type === 'event' ? venue : undefined;
  const reasons: string[] = [];
  const byDomain = type === baseType && !!match;
  if (byDomain) reasons.push(domainReason(match.rule, match.host));
  if (type === 'place' && isGeo) reasons.push('map coordinates');
  if (type === 'event' && hint) reasons.push(`${hint.strong ? 'has a date' : 'has a time'}: ${hint.phrase}`);
  // When the site already decided, words from its URL path ("/events/123") are noise.
  const pathWords = !byDomain || OVERRIDABLE.has(baseType);
  reasons.push(...termReasons([...(ev.get(type)?.terms ?? []), ...(leaned?.terms ?? [])], human, pathWords));
  if (type === 'place' && mapInfo.place && !isGeo) reasons.push('has map coordinates');
  if (type === 'note' && !reasons.length) reasons.push('just text, no link');

  const tags: string[] = [];
  const add = (t: string) => {
    const n = normalizeTag(t);
    if (n && !tags.includes(n)) tags.push(n);
  };
  hashtags(text).slice(0, 4).forEach(add);
  (ev.get(type)?.tags ?? []).forEach(add);
  (leaned?.tags ?? []).forEach(add);
  if (type === baseType) (rule?.tags ?? []).forEach(add);

  const finalTags = tags.slice(0, 6);
  const picked = pickTitle(parsed.title, parsed.note, !!url, finalTags);
  const title =
    picked.title ||
    (!url && parsed.title ? capTitle(parsed.title) : '') ||
    defaultTitle(url, rule, type, mapInfo.name, picked.author);

  return {
    type,
    source,
    url,
    title,
    note: picked.note,
    tags: finalTags,
    place: mapInfo.place,
    sharedText: sharedTextOf(input),
    author: picked.author,
    reasons: reasons.slice(0, 4),
    confidence,
    alternatives,
  };
}

/** The parts of a classification that belong on a saved item (leaves out the explanation fields). */
export function itemFieldsFrom(c: Classification): Pick<Classification, 'type' | 'title' | 'url' | 'source' | 'note' | 'tags' | 'place' | 'sharedText'> {
  const { type, title, url, source, note, tags, place, sharedText } = c;
  return { type, title, url, source, note, tags, place, sharedText };
}

/** The URL's path and query as plain words, so "/recipes/easy-chicken-curry" counts as text. */
function safePath(url: string): string {
  try {
    const u = new URL(url);
    const raw = `${u.pathname} ${u.search}`;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      /* malformed escape — use as is */
    }
    return decoded.replace(/[-_/+=&?]/g, ' ');
  } catch {
    return '';
  }
}

/**
 * The keyword and title regexes, keyword signals first, so warmup.ts can compile them ahead of time (a regex
 * compiles on its first runs, which takes a while for the big Unicode ones on a phone).
 */
export function warmRegExps(): RegExp[] {
  cjkTerms(); // not regexes, but built here too so the first analysis doesn't have to
  return [
    ...Object.values(keywordSignals()).flatMap((list) => (list ?? []).map((s) => s.re)),
    BOOKING_RE,
    RECAP_RE,
    CJK_RUN_RE,
    ...STRONG_HINTS,
    ...WEAK_HINTS,
    RECURRING_BEFORE,
    POSTED_BEFORE,
    POSTED_AFTER,
    IG_POST_PATH,
    URL_RE,
    URL_RE_ALL,
    IGNORED_HASHTAG_RE,
    INVISIBLE_RE,
    SITE_SUFFIX_RE,
    ON_SITE_RE,
    SITE_ONLY_RE,
    EVENT_SITE_SUFFIX_RE,
    TICKETS_BEFORE_DATE_RE,
    JUNK_TITLE_RE,
    CHECK_OUT_NAMED,
    CHECK_OUT_BY,
    SHARE_FOOTER_RE,
    LOCALE_SEGMENT_RE,
    ...DOMAIN_RULES.flatMap((r) => (r.path ? [r.path] : [])),
  ];
}
