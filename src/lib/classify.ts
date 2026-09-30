import type { ItemType, Place } from './types';

/**
 * On-device "smart sorting": works out what a save is (recipe, place, video…),
 * where it came from, a sensible title and some starter tags — from the URL and
 * whatever text was shared with it. No network or AI service needed.
 */

export interface SharedInput {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

export interface Classification {
  type: ItemType;
  source?: string;
  title: string;
  url?: string;
  note?: string;
  tags: string[];
  place?: Place;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/i;

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

interface DomainRule {
  domains: string[];
  type: ItemType;
  source?: string;
  path?: RegExp;
}

// Order matters: first match wins.
const DOMAIN_RULES: DomainRule[] = [
  { domains: ['google.com', 'google.co.uk'], path: /^\/maps/, type: 'place', source: 'google-maps' },
  { domains: ['maps.google.com', 'maps.app.goo.gl'], type: 'place', source: 'google-maps' },
  { domains: ['goo.gl'], path: /^\/maps/, type: 'place', source: 'google-maps' },
  { domains: ['maps.apple.com', 'maps.apple'], type: 'place', source: 'apple-maps' },
  { domains: ['openstreetmap.org'], type: 'place', source: 'openstreetmap' },
  {
    domains: [
      'yelp.com', 'yelp.co.uk', 'tripadvisor.com', 'tripadvisor.co.uk', 'opentable.com', 'opentable.co.uk',
      'resy.com', 'airbnb.com', 'airbnb.co.uk', 'booking.com', 'hotels.com', 'timeout.com', 'thefork.com',
      'sevenrooms.com', 'eater.com', 'theinfatuation.com', 'foursquare.com', 'alltrails.com',
    ],
    type: 'place',
  },
  { domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], type: 'video', source: 'youtube' },
  { domains: ['tiktok.com'], type: 'video', source: 'tiktok' },
  { domains: ['instagram.com'], path: /^\/(reel|reels|tv)\//, type: 'video', source: 'instagram' },
  { domains: ['instagram.com'], type: 'link', source: 'instagram' },
  { domains: ['vimeo.com'], type: 'video', source: 'vimeo' },
  { domains: ['twitch.tv'], type: 'video', source: 'twitch' },
  { domains: ['dailymotion.com'], type: 'video', source: 'dailymotion' },
  { domains: ['netflix.com', 'imdb.com', 'letterboxd.com', 'primevideo.com', 'disneyplus.com'], type: 'video' },
  { domains: ['pinterest.com', 'pinterest.co.uk', 'pin.it'], type: 'link', source: 'pinterest' },
  { domains: ['reddit.com', 'redd.it'], type: 'link', source: 'reddit' },
  { domains: ['x.com', 'twitter.com'], type: 'link', source: 'x' },
  { domains: ['threads.net', 'threads.com'], type: 'link', source: 'threads' },
  { domains: ['facebook.com', 'fb.watch'], type: 'link', source: 'facebook' },
  {
    domains: [
      'allrecipes.com', 'bbcgoodfood.com', 'seriouseats.com', 'cooking.nytimes.com', 'bonappetit.com',
      'epicurious.com', 'food52.com', 'delish.com', 'tasty.co', 'budgetbytes.com', 'recipetineats.com',
      'minimalistbaker.com', 'jamieoliver.com', 'simplyrecipes.com', 'halfbakedharvest.com', 'foodnetwork.com',
      'thekitchn.com', 'smittenkitchen.com', 'bbc.co.uk/food', 'deliciousmagazine.co.uk', 'olivemagazine.com',
      'nigella.com', 'ottolenghi.co.uk', 'kingarthurbaking.com', 'loveandlemons.com', 'cookieandkate.com',
      'pinchofyum.com', 'sallysbakingaddiction.com', 'hellofresh.com', 'mob.co.uk', 'mobkitchen.co.uk',
    ],
    type: 'recipe',
  },
  {
    domains: [
      'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.ca', 'amazon.com.au', 'amzn.to', 'amzn.eu', 'a.co',
      'etsy.com', 'ebay.com', 'ebay.co.uk', 'asos.com', 'zara.com', 'hm.com', 'uniqlo.com', 'ikea.com',
      'johnlewis.com', 'argos.co.uk', 'target.com', 'walmart.com', 'bestbuy.com', 'nike.com', 'adidas.com',
      'aliexpress.com', 'temu.com', 'shein.com', 'wayfair.com', 'wayfair.co.uk', 'sephora.com',
      'net-a-porter.com', 'farfetch.com', 'depop.com', 'vinted.com', 'vinted.co.uk', 'apple.com/shop',
    ],
    type: 'product',
  },
  {
    domains: ['open.spotify.com', 'spotify.com', 'spotify.link', 'music.apple.com', 'soundcloud.com', 'bandcamp.com', 'music.youtube.com', 'tidal.com', 'deezer.com'],
    type: 'music',
  },
  {
    domains: ['goodreads.com', 'books.google.com', 'bookshop.org', 'uk.bookshop.org', 'openlibrary.org', 'storygraph.com', 'thestorygraph.com', 'audible.com', 'audible.co.uk'],
    type: 'book',
  },
  {
    domains: [
      'medium.com', 'substack.com', 'nytimes.com', 'theguardian.com', 'bbc.co.uk', 'bbc.com', 'wikipedia.org',
      'theatlantic.com', 'newyorker.com', 'wired.com', 'theverge.com', 'economist.com', 'ft.com',
      'washingtonpost.com', 'bloomberg.com', 'vox.com', 'aeon.co', 'arstechnica.com', 'techcrunch.com',
      'news.ycombinator.com', 'dev.to',
    ],
    type: 'article',
  },
];

const SOURCE_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  dailymotion: 'Dailymotion',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  x: 'X',
  threads: 'Threads',
  facebook: 'Facebook',
  'google-maps': 'Google Maps',
  'apple-maps': 'Apple Maps',
  openstreetmap: 'OpenStreetMap',
};

export function sourceLabel(source: string | undefined): string | undefined {
  return source ? SOURCE_NAMES[source] ?? source : undefined;
}

function matchDomain(url: string): DomainRule | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = hostOf(url);
  const hostPath = `${host}${u.pathname}`;
  for (const rule of DOMAIN_RULES) {
    for (const d of rule.domains) {
      const ok = d.includes('/') ? hostPath.startsWith(d) || hostPath.startsWith(`www.${d}`) : hostMatches(host, d);
      if (ok && (!rule.path || rule.path.test(u.pathname))) return rule;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Keyword signals

interface Signal {
  re: RegExp;
  weight: number;
  tag?: string;
}

const w = (words: string, weight: number, tag?: string): Signal => ({
  re: new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words})(?=$|[^\\p{L}\\p{N}])`, 'iu'),
  weight,
  tag,
});

const SIGNALS: Partial<Record<ItemType, Signal[]>> = {
  recipe: [
    w('recipes?|recipe ideas?', 3),
    w('ingredients?|tbsp|tsp|tablespoons?|teaspoons?|preheat|simmer|marinade|how to make', 3),
    w('cook(?:ing)?|bak(?:e|ing)|oven|stir[- ]fry|one[- ]pot|meal ?prep', 2),
    w('air ?fryer', 2, 'air-fryer'),
    w('desserts?|cakes?|cookies|brownies?|cheesecake', 2, 'dessert'),
    w('pasta|spaghetti|lasagne|lasagna|carbonara|gnocchi', 2, 'pasta'),
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
    w('foodtok|foodie|dinner ideas?|lunch ideas?', 2),
  ],
  workout: [
    w('workouts?|work out|exercises?|training|routine', 3),
    w('hiit|tabata|circuit|emom|amrap', 3, 'hiit'),
    w('abs|core', 2, 'core'),
    w('glutes?|booty|leg day|legs', 2, 'legs'),
    w('yoga|vinyasa|asanas?', 3, 'yoga'),
    w('pilates|reformer', 3, 'pilates'),
    w('stretch(?:es|ing)?|mobility|flexibility', 2, 'mobility'),
    w('cardio|running|run club|5k|10k|marathon', 2, 'cardio'),
    w('strength|dumbbells?|kettlebells?|barbell|squats?|deadlifts?|push[- ]?ups?|pull[- ]?ups?|reps|sets', 2, 'strength'),
    w('gym|gymtok|fitness|fitspo', 2),
    w('full body|upper body|lower body|at home workout|no equipment', 2),
  ],
  place: [
    w('restaurants?|bistro|trattoria|eatery|diner', 3, 'restaurant'),
    w('caf[eé]s?|coffee shop|coffee spot|espresso bar', 3, 'coffee'),
    w('bars?|pubs?|cocktails?|speakeasy|rooftop|wine bar', 2, 'drinks'),
    w('brunch', 2, 'brunch'),
    w('bakery|patisserie', 2, 'bakery'),
    w('hidden gems?|must[- ]visit|must[- ]try|bucket list|places to|spots? in|things to do|where to eat|best .{0,20} in', 3),
    w('travel|trip|itinerary|holiday|vacation|getaway|weekend in|days in', 2, 'travel'),
    w('hotels?|hostel|resort|cabin|airbnb|stay at', 2, 'stay'),
    w('beach(?:es)?|island|coast', 2, 'beach'),
    w('hikes?|hiking|trails?|walks? in|national park|mountains?', 2, 'outdoors'),
    w('museums?|galler(?:y|ies)|exhibitions?', 2, 'culture'),
    w('markets?|food hall', 1, 'market'),
  ],
  product: [
    w('buy|shop(?:ping)?|on sale|discount|deal|promo code|wishlist|add to cart|in stock', 2),
    w('amazon finds?|tiktok made me buy|haul|must[- ]haves?|gift ideas?', 3, 'wishlist'),
    w('[$£€]\\s?\\d+(?:[.,]\\d{2})?', 1),
  ],
  book: [
    w('books?|novels?|reading list|booktok|bookstagram|tbr|paperback|hardback|audiobooks?', 3),
  ],
  music: [w('songs?|albums?|playlists?|tracks?|spotify|mixtape', 2)],
  article: [w('article|essay|op-ed|newsletter|longread|long read', 2)],
};

const OVERRIDABLE = new Set<ItemType>(['link', 'video', 'note']);

const IGNORED_HASHTAGS = new Set([
  'fyp', 'foryou', 'foryoupage', 'fy', 'fypシ', 'viral', 'trending', 'reels', 'reel', 'tiktok', 'explore',
  'explorepage', 'instagood', 'instagram', 'xyzbca', 'capcut', 'youtube', 'shorts', 'ytshorts', 'duet',
  'stitch', 'foryoupageofficiall', 'viralvideo', 'trend', 'follow', 'like',
]);

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

export function hashtags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_]{2,40})/gu)) {
    const t = normalizeTag(m[1]);
    if (t && !IGNORED_HASHTAGS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

function scoreText(text: string) {
  const scores = new Map<ItemType, number>();
  const tags = new Map<ItemType, string[]>();
  for (const [type, signals] of Object.entries(SIGNALS) as [ItemType, Signal[]][]) {
    let score = 0;
    const found: string[] = [];
    for (const s of signals) {
      if (s.re.test(text)) {
        score += s.weight;
        if (s.tag && !found.includes(s.tag)) found.push(s.tag);
      }
    }
    if (score > 0) scores.set(type, score);
    if (found.length) tags.set(type, found);
  }
  return { scores, tags };
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

function prettifySlug(segment: string): string | undefined {
  let s = decodeURIComponent(segment).replace(/\.(html?|php|aspx?)$/i, '');
  // Drop trailing numeric ids like "-123456".
  s = s.replace(/[-_]\d{3,}$/, '');
  if (!/[a-z]/i.test(s)) return undefined;
  const words = s.split(/[-_+]+/).filter(Boolean);
  if (words.length < 2) return undefined; // single words are usually ids or sections
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

function defaultTitle(url: string | undefined, source: string | undefined, type: ItemType, placeName?: string): string {
  if (placeName) return placeName;
  if (!url) return 'Untitled';
  const label = sourceLabel(source);
  if (source === 'youtube') return 'YouTube video';
  if (source === 'tiktok') {
    const handle = url.match(/tiktok\.com\/@([\w.]+)/)?.[1];
    return handle ? `TikTok by @${handle}` : 'TikTok video';
  }
  if (source === 'instagram') return type === 'video' ? 'Instagram reel' : 'Instagram post';
  const fromSlug = titleFromUrl(url);
  if (fromSlug !== hostOf(url)) return fromSlug;
  return label ?? fromSlug;
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

export function classify(input: SharedInput): Classification {
  const { url, title, note } = parseShared(input);
  const rule = url ? matchDomain(url) : undefined;
  let type: ItemType = url ? rule?.type ?? 'link' : 'note';
  const source = rule?.source;

  const mapInfo = url ? parsePlaceFromUrl(url) : {};
  if (url?.startsWith('geo:')) type = 'place';

  const text = [title, note, url ? safePath(url) : ''].filter(Boolean).join('\n');
  const { scores, tags: signalTags } = scoreText(text);

  if (OVERRIDABLE.has(type)) {
    let best: ItemType | undefined;
    let bestScore = 0;
    for (const [t, s] of scores) {
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    // A clear signal re-files a generic link / video / note, e.g. a TikTok pasta recipe → recipe.
    if (best && bestScore >= 3 && !(type === 'video' && (best === 'music' || best === 'article'))) type = best;
  }

  const tags: string[] = [];
  const add = (t: string) => {
    const n = normalizeTag(t);
    if (n && !tags.includes(n)) tags.push(n);
  };
  hashtags(text).slice(0, 4).forEach(add);
  (signalTags.get(type) ?? []).forEach(add);

  return {
    type,
    source,
    url,
    title: title ?? defaultTitle(url, source, type, mapInfo.name),
    note,
    tags: tags.slice(0, 6),
    place: mapInfo.place,
  };
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
