import { reverseGeocode } from './geo';
import { TYPE_INFO, type Item, type Place } from './types';

/**
 * Where saves are: flags, country names, tidy place labels, grouping by country,
 * and offline guesses at places mentioned in shared text. Only
 * resolvePlaceDetails touches the network.
 */

// ---------------------------------------------------------------------------
// Country codes, flags and names

const ISO_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );
// Kosovo isn't in ISO 3166 yet, but OpenStreetMap and emoji flags use XK.
const VALID_CODES = new Set([...ISO_CODES, 'XK']);

/** Upper-cased ISO 3166-1 alpha-2 code, or undefined if it isn't one ("uk" → "GB"). */
export function normalizeCountryCode(code?: string | null): string | undefined {
  if (typeof code !== 'string') return undefined;
  const c = code.trim().toUpperCase();
  if (c === 'UK') return 'GB';
  return VALID_CODES.has(c) ? c : undefined;
}

/** 🇵🇹 for "PT". Returns `fallback` (🌐 by default) for a missing or unknown code. */
export function flagEmoji(countryCode?: string, fallback = '🌐'): string {
  const c = normalizeCountryCode(countryCode);
  if (!c) return fallback;
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

function defaultLocale(): string {
  try {
    return (typeof navigator !== 'undefined' && navigator.language) || 'en';
  } catch {
    return 'en';
  }
}

const namers = new Map<string, Intl.DisplayNames>();
// Where the short form reads better than the long one ("Hong Kong", not "Hong Kong SAR China").
const SHORT_NAMES = new Set(['HK', 'MO', 'MM', 'PS']);

function regionNamer(locale?: string, style: 'long' | 'short' = 'long'): Intl.DisplayNames | undefined {
  const loc = locale || defaultLocale();
  const cacheKey = `${loc}|${style}`;
  const hit = namers.get(cacheKey);
  if (hit) return hit;
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return undefined;
  for (const tag of [loc, 'en']) {
    try {
      const namer = new Intl.DisplayNames([tag], { type: 'region', style });
      namers.set(cacheKey, namer);
      return namer;
    } catch {
      /* not a valid language tag */
    }
  }
  return undefined;
}

/** "Portugal" for "PT", in the given (or the device's) language. Falls back to the code itself. */
export function countryName(code?: string, locale?: string): string {
  const raw = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!raw) return '';
  const c = normalizeCountryCode(raw) ?? raw;
  try {
    const name = regionNamer(locale, SHORT_NAMES.has(c) ? 'short' : 'long')?.of(c);
    if (name && name.toUpperCase() !== c && name !== 'Unknown Region') return name;
  } catch {
    /* not a region code */
  }
  return c;
}

// ---------------------------------------------------------------------------
// Text normalisation

const SPECIAL_LETTERS: Record<string, string> = {
  ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', æ: 'ae', Æ: 'Ae', œ: 'oe', Œ: 'Oe', ß: 'ss', đ: 'd', Đ: 'D', þ: 'th', Þ: 'Th', ı: 'i',
};

/** Accent-free, keeps case: "São Tomé & Príncipe" → "Sao Tome and Principe", "U.S.A." → "USA". */
function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[øØłŁæÆœŒßđĐþÞı]/g, (c) => SPECIAL_LETTERS[c])
    .replace(/[’‘`´]/g, "'")
    .replace(/\b(?:[A-Za-z]\.){2,}/g, (m) => m.replace(/\./g, ''))
    .replace(/\b(St|Ste|Mt|Ft)\./gi, '$1')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/(?<=\p{L})[-‐‑–](?=\p{L})/gu, ' ');
}

/** Lower-case comparison form that keeps apostrophes (used to build patterns). */
function norm(s: string): string {
  return fold(s)
    .toLowerCase()
    .replace(/\bsaint\b/g, 'st')
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .trim();
}

/** Map key: norm() without apostrophes, so "Xi'an" and "Xian" meet. */
function keyOf(s: string): string {
  return norm(s).replace(/'/g, '');
}

const stripUrls = (s: string) => s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
// Enough for any caption or note; keeps the scans cheap on pasted essays.
const MAX_TEXT = 6000;
const clean = (s: string | undefined) => s?.replace(/\s+/g, ' ').trim() || '';

// ---------------------------------------------------------------------------
// Offline gazetteer: countries, aliases, major cities & regions, demonyms.
// A trailing * means "only as a capitalised proper noun mid-sentence" (Nice, Turkey),
// ^ means "only in capitals" (UK, NYC), and ! means "only in capitals, and only where a
// place fits" (US, LA: not "follow US", "LA LA Land" or "LA VIE EN ROSE").
// "Alias=Label" shows Label for the alias.

const ALIASES: Record<string, string> = {
  GB: 'UK^|United Kingdom|Great Britain|Britain|England|Scotland|Wales|Northern Ireland',
  US: 'USA^|US!|United States|United States of America|America*',
  AE: 'UAE^|United Arab Emirates',
  NL: 'Holland|The Netherlands|Netherlands',
  KR: 'South Korea|Korea|Republic of Korea',
  KP: 'North Korea',
  CZ: 'Czech Republic|Czechia',
  TR: 'Turkey*|Türkiye',
  CI: 'Ivory Coast',
  SZ: 'Swaziland',
  MK: 'Macedonia|North Macedonia',
  MM: 'Burma|Myanmar',
  TL: 'East Timor',
  VA: 'Vatican',
  CV: 'Cabo Verde|Cape Verde',
  PS: 'Palestine',
  MO: 'Macau|Macao',
  HK: 'Hong Kong',
  CD: 'DR Congo|DRC^|Democratic Republic of the Congo|Congo',
  CG: 'Republic of the Congo',
  VN: 'Vietnam|Viet Nam',
  RU: 'Russia|Russian Federation',
  GS: 'South Georgia',
  KN: 'St Kitts',
  TT: 'Trinidad|Tobago',
  BA: 'Bosnia',
  XK: 'Kosovo',
  IE: 'Republic of Ireland|Ireland',
};

const CITIES: Record<string, string> = {
  GB: 'London|Manchester|Liverpool|Birmingham|Edinburgh|Glasgow|Bristol|Oxford*|Cambridge|Brighton|York|Bath*|Cardiff|Belfast|Leeds|Newcastle|Inverness|Canterbury',
  IE: 'Dublin|Galway|Cork*|Killarney',
  FR: 'Paris|Lyon|Marseille|Nice*|Bordeaux|Strasbourg|Toulouse|Montpellier|Lille|Nantes|Cannes|Avignon|Annecy|Chamonix|Mont Saint-Michel|Versailles|Saint-Tropez|Biarritz|Colmar|Reims',
  ES: 'Barcelona|Madrid|Seville|Sevilla=Seville|Valencia|Granada|Malaga|Bilbao|San Sebastian|Marbella|Cadiz|Palma de Mallorca|Salamanca|Zaragoza',
  PT: 'Lisbon|Lisboa=Lisbon|Porto|Sintra|Faro|Funchal|Coimbra|Cascais|Evora|Braga|Aveiro|Nazare',
  IT: 'Rome|Roma=Rome|Milan|Milano=Milan|Florence*|Firenze=Florence|Venice|Venezia=Venice|Naples|Napoli=Naples|Turin|Torino=Turin|Bologna*|Verona|Pisa|Siena|Genoa|Palermo|Positano|Matera|Bergamo|Lucca|Sorrento|Taormina|Catania',
  DE: 'Berlin|Munich|München=Munich|Hamburg|Frankfurt|Cologne*|Köln=Cologne|Dresden|Heidelberg|Stuttgart|Düsseldorf|Leipzig|Nuremberg|Nürnberg=Nuremberg|Bremen',
  NL: 'Amsterdam|Rotterdam|The Hague|Utrecht|Eindhoven|Haarlem|Delft',
  BE: 'Brussels*|Bruges|Brugge=Bruges|Antwerp|Ghent|Gent=Ghent',
  CH: 'Zurich|Geneva|Genève=Geneva|Lucerne|Luzern=Lucerne|Interlaken|Zermatt|Bern|Basel|Lausanne|Lugano|Grindelwald',
  AT: 'Vienna|Wien=Vienna|Salzburg|Innsbruck|Hallstatt',
  CZ: 'Prague|Praha=Prague|Cesky Krumlov',
  HU: 'Budapest',
  PL: 'Krakow|Warsaw|Gdansk|Wroclaw',
  DK: 'Copenhagen|København=Copenhagen|Aarhus',
  SE: 'Stockholm|Gothenburg|Malmo',
  NO: 'Oslo|Bergen|Tromso',
  FI: 'Helsinki|Rovaniemi',
  IS: 'Reykjavik',
  GR: 'Athens|Thessaloniki|Oia',
  HR: 'Dubrovnik|Split*|Zagreb',
  SI: 'Ljubljana|Bled*',
  ME: 'Kotor|Budva',
  TR: 'Istanbul|Antalya|Bodrum|Izmir|Ankara|Goreme',
  RU: 'Moscow|St Petersburg',
  EE: 'Tallinn',
  LV: 'Riga',
  LT: 'Vilnius',
  MA: 'Marrakech|Marrakesh=Marrakech|Fes|Fez*|Chefchaouen|Casablanca|Essaouira|Tangier',
  EG: 'Cairo|Luxor|Giza|Aswan|Alexandria|Sharm el-Sheikh',
  ZA: 'Cape Town|Johannesburg|Durban',
  KE: 'Nairobi|Mombasa',
  TZ: 'Dar es Salaam|Arusha',
  AE: 'Dubai|Abu Dhabi',
  QA: 'Doha',
  IL: 'Tel Aviv|Jerusalem',
  JO: 'Petra*|Amman',
  LB: 'Beirut',
  OM: 'Muscat',
  SA: 'Riyadh|Jeddah',
  IN: 'Mumbai|Delhi|New Delhi|Jaipur|Bangalore|Bengaluru|Kolkata|Chennai|Agra|Udaipur|Varanasi|Hyderabad|Rishikesh',
  LK: 'Colombo|Kandy|Galle',
  NP: 'Kathmandu|Pokhara',
  CN: 'Beijing|Shanghai|Shenzhen|Guangzhou|Chengdu|Xi\'an|Hangzhou|Guilin|Chongqing',
  HK: 'Kowloon',
  TW: 'Taipei|Tainan|Taichung|Kaohsiung',
  JP: 'Tokyo|Kyoto|Osaka|Nara|Hiroshima|Sapporo|Fukuoka|Nagoya|Yokohama|Kobe|Hakone|Nikko|Kanazawa|Kamakura|Takayama|Shibuya|Shinjuku',
  KR: 'Seoul|Busan|Incheon',
  TH: 'Bangkok|Chiang Mai|Chiang Rai|Phuket|Krabi|Pattaya|Ayutthaya|Hua Hin',
  VN: 'Hanoi|Ho Chi Minh City|Saigon|Hoi An|Da Nang|Sapa|Nha Trang|Da Lat',
  KH: 'Siem Reap|Phnom Penh',
  LA: 'Luang Prabang|Vientiane',
  MM: 'Yangon|Bagan|Mandalay',
  MY: 'Kuala Lumpur|Malacca|Melaka',
  ID: 'Jakarta|Ubud|Yogyakarta|Seminyak|Canggu|Uluwatu',
  PH: 'Manila|Cebu|El Nido|Makati',
  AU: 'Sydney*|Melbourne|Brisbane|Perth|Adelaide|Gold Coast|Cairns*|Hobart|Byron Bay|Canberra|Noosa',
  NZ: 'Auckland|Wellington*|Queenstown|Christchurch|Rotorua|Wanaka',
  US: 'New York City|New York|NYC^=New York|Manhattan|Brooklyn|Los Angeles|LA!=Los Angeles|San Francisco|Chicago|Miami|Las Vegas|Seattle|Boston|Washington DC|New Orleans|Nashville|Austin*|Portland|San Diego|Philadelphia|Atlanta|Denver|Honolulu|Orlando*|Houston|Dallas|Phoenix*|Detroit|Santa Barbara|Malibu|Key West|Charleston|Salt Lake City|Minneapolis|Palm Springs|Jersey City|San Antonio|Sedona|Aspen|Anchorage|Pittsburgh|Baltimore|St Louis|Kansas City|Memphis|Santa Fe|Tucson|Napa',
  CA: 'Toronto|Vancouver|Montreal|Quebec City|Calgary|Ottawa|Banff|Whistler|Niagara Falls|Edmonton',
  MX: 'Mexico City|CDMX^=Mexico City|Cancun|Tulum|Oaxaca|Playa del Carmen|Guadalajara|Puerto Vallarta|Los Cabos|Cabo San Lucas|San Miguel de Allende|Monterrey',
  CU: 'Havana',
  DO: 'Punta Cana|Santo Domingo',
  JM: 'Montego Bay',
  BR: 'Rio de Janeiro|Sao Paulo|Florianopolis|Brasilia',
  AR: 'Buenos Aires|Mendoza|Bariloche|Ushuaia',
  CL: 'Valparaiso|Santiago de Chile',
  PE: 'Lima*|Cusco|Cuzco=Cusco|Arequipa',
  CO: 'Bogota|Medellin|Cartagena',
  EC: 'Quito|Guayaquil',
  UY: 'Montevideo',
  PA: 'Panama City',
};

const REGIONS: Record<string, string> = {
  GB: 'Cornwall|Cotswolds|Lake District|Isle of Skye|Scottish Highlands|Yorkshire|Devon',
  FR: 'Provence|Normandy|Brittany|French Riviera|Corsica|Alsace|Loire Valley|Dordogne',
  ES: 'Ibiza|Mallorca|Majorca=Mallorca|Menorca|Tenerife|Gran Canaria|Lanzarote|Canary Islands|Andalusia|Costa Brava',
  PT: 'Algarve|Madeira|Azores|Douro Valley',
  IT: 'Sicily|Sardinia|Tuscany|Amalfi Coast|Amalfi|Capri|Cinque Terre|Lake Como|Dolomites|Puglia|Lake Garda',
  DE: 'Bavaria|Black Forest',
  GR: 'Santorini|Mykonos|Crete|Rhodes*|Corfu|Naxos|Paros|Zakynthos|Milos',
  HR: 'Hvar',
  TR: 'Cappadocia',
  TZ: 'Zanzibar|Serengeti|Kilimanjaro',
  IN: 'Goa|Kerala|Rajasthan',
  JP: 'Hokkaido|Okinawa|Mount Fuji|Mt Fuji=Mount Fuji',
  KR: 'Jeju',
  TH: 'Koh Samui|Koh Phangan|Koh Tao|Koh Lanta|Phi Phi',
  VN: 'Ha Long Bay|Halong Bay=Ha Long Bay',
  KH: 'Angkor Wat',
  MY: 'Penang|Langkawi',
  ID: 'Bali|Lombok|Komodo|Gili Islands',
  PH: 'Palawan|Boracay|Siargao',
  AU: 'Tasmania|Great Barrier Reef|Uluru|Queensland|New South Wales|Western Australia',
  US: 'Hawaii|Maui|Oahu|Kauai|Yosemite|Grand Canyon|Yellowstone|Napa Valley|Big Sur|Jersey Shore|Florida Keys|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Idaho|Illinois|Indiana*|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia*|Washington*|West Virginia|Wisconsin|Wyoming',
  CA: 'Ontario|Quebec|British Columbia|Alberta|Nova Scotia',
  MX: 'Yucatan|Baja California',
  PE: 'Machu Picchu|Sacred Valley',
  EC: 'Galapagos',
  NO: 'Lofoten',
  FI: 'Lapland',
};

const DEMONYMS: Record<string, string> = {
  GB: 'British|English|Scottish|Welsh',
  IE: 'Irish',
  US: 'American|Hawaiian',
  CA: 'Canadian',
  MX: 'Mexican',
  BR: 'Brazilian',
  AR: 'Argentinian|Argentine',
  PE: 'Peruvian',
  CL: 'Chilean',
  CO: 'Colombian',
  VE: 'Venezuelan',
  CU: 'Cuban',
  JM: 'Jamaican',
  PR: 'Puerto Rican',
  FR: 'French|Parisian',
  DE: 'German|Bavarian',
  IT: 'Italian|Tuscan|Sicilian|Neapolitan|Venetian',
  ES: 'Spanish|Catalan',
  PT: 'Portuguese',
  NL: 'Dutch',
  BE: 'Belgian',
  CH: 'Swiss',
  AT: 'Austrian',
  SE: 'Swedish',
  NO: 'Norwegian',
  DK: 'Danish',
  FI: 'Finnish',
  IS: 'Icelandic',
  PL: 'Polish',
  CZ: 'Czech',
  HU: 'Hungarian',
  RO: 'Romanian',
  BG: 'Bulgarian',
  GR: 'Greek',
  HR: 'Croatian',
  RS: 'Serbian',
  TR: 'Turkish',
  RU: 'Russian',
  UA: 'Ukrainian',
  GE: 'Georgian*',
  AM: 'Armenian',
  MA: 'Moroccan',
  TN: 'Tunisian',
  DZ: 'Algerian',
  EG: 'Egyptian',
  ET: 'Ethiopian',
  NG: 'Nigerian',
  GH: 'Ghanaian',
  SN: 'Senegalese',
  KE: 'Kenyan',
  ZA: 'South African',
  LB: 'Lebanese',
  SY: 'Syrian',
  IL: 'Israeli',
  PS: 'Palestinian',
  JO: 'Jordanian',
  IR: 'Iranian|Persian',
  AE: 'Emirati',
  SA: 'Saudi',
  AF: 'Afghan',
  IN: 'Indian',
  PK: 'Pakistani',
  NP: 'Nepalese|Nepali',
  LK: 'Sri Lankan',
  CN: 'Chinese',
  JP: 'Japanese',
  KR: 'Korean',
  TW: 'Taiwanese',
  TH: 'Thai',
  VN: 'Vietnamese',
  KH: 'Cambodian',
  LA: 'Laotian',
  MM: 'Burmese',
  PH: 'Filipino',
  ID: 'Indonesian|Balinese',
  MY: 'Malaysian',
  SG: 'Singaporean',
  AU: 'Australian',
  MN: 'Mongolian',
};

// Phrases that contain a place word but aren't about the place.
const BLOCKED =
  'South America|Latin America|Central America|North America|South American|Latin American|Central American|North American|Dutch oven|French fries|French toast|French press|French horn|French kiss|French braid|French manicure|Swiss roll|Swiss cheese|Swiss army|English muffin|English breakfast|Danish pastry|Turkish delight|Russian roulette|Russian dressing|German shepherd|Mexican wave|Chinese whispers|Indian summer|Greek yogurt|Greek yoghurt|Brazil nut|Brazil nuts|Brussels sprout|Brussels sprouts|Panama hat|Bermuda shorts|Bermuda triangle|Guinea pig|Guinea pigs|Guinea fowl|Air Jordan|Air Jordans|Michael Jordan|Bone China|Fine China|Scotch egg|Irish coffee|Thai basil|Boston terrier|Boston cream|Philly cheesesteak|Chicago style|New York style|Buffalo wings|Hawaiian pizza|Turkish towel';

// Names that are also everyday words: rejected when food / product words are nearby.
const CONTEXT_BLOCK: Record<string, RegExp> = {
  turkey: /\b(recipe|roast(ed)?|sandwich(es)?|burgers?|breast|meatballs?|ground|thanksgiving|stuffing|gravy|bacon|mince|chili|leftovers?|smoked|brine[ds]?|carv(e|ing)|oven|bake[ds]?|dinner|wrap|club|legs?|crown|deli|slices?|sliders?|soup|stew|casserole|lasagna|tacos?|pie)\b/,
  chile: /\b(recipe|relleno|rellenos|verde|con|carne|powder|flakes|sauce|peppers?|green|red|hatch|ancho|chipotle|guajillo|oil|salsa|roasted)\b/,
  china: /\b(plates?|cabinet|dinnerware|porcelain|tea ?set|pattern|dishes|cups?|teapot|vintage|antique)\b/,
  jersey: /\b(shirt|kit|football|soccer|basketball|hockey|nba|nfl|fabric|knit|dress|cotton|number|signed)\b/,
  jordan: /\b(sneakers?|shoes?|retro|nike|kicks|basketball|nba|high|low)\b/,
  cologne: /\b(perfume|fragrances?|scent|eau|spray|notes)\b/,
  bologna: /\b(sausage|sandwich|slices?)\b/,
  panama: /\b(hats?)\b/,
};

type Kind = 'country' | 'city' | 'region' | 'demonym' | 'block';
type Caps = 'proper' | 'upper' | 'strict' | 'title';

interface Entry {
  code: string;
  label: string;
  kind: Kind;
  caps?: Caps;
  context?: RegExp;
}

interface Gazetteer {
  byKey: Map<string, Entry>;
  re: RegExp;
}

/**
 * A table built in small steps: all at once when something first needs it, or a step at a time from the
 * idle-time warm-up (warmup.ts). Either way it ends up the same.
 */
interface Stepped<T> {
  get(): T;
  /** Does one step; true once it's built. */
  step(): boolean;
  /** The table if it's built, without building it. */
  peek(): T | undefined;
}

function stepped<T>(start: () => Iterator<void, T>): Stepped<T> {
  let value: T | undefined;
  let steps: Iterator<void, T> | undefined;
  const step = () => {
    if (value !== undefined) return true;
    steps ??= start();
    const r = steps.next();
    if (!r.done) return false;
    value = r.value;
    steps = undefined;
    return true;
  };
  return {
    get: () => {
      while (!step());
      return value!;
    },
    step,
    peek: () => value,
  };
}

// Names added per step when the gazetteer is built in idle time.
const NAMES_PER_STEP = 32;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex source for a norm()'d name: flexible spacing, optional apostrophes, St/Saint. */
function namePattern(n: string): string {
  return n
    .split(' ')
    .map((tok) => (tok === 'st' ? '(?:st|saint)' : escapeRe(tok).replace(/'/g, "'?")))
    .join('\\s+');
}

/** Builds the gazetteer, pausing every few dozen names (see stepped). */
function* buildGazetteer(): Generator<void, Gazetteer> {
  const byKey = new Map<string, Entry>();
  const patterns = new Map<string, string>();

  const add = (raw: string, code: string, kind: Kind, caps?: Caps) => {
    let [name, label] = raw.split('=');
    if (name.endsWith('*')) {
      caps = 'proper';
      name = name.slice(0, -1);
    } else if (name.endsWith('^')) {
      caps = 'upper';
      name = name.slice(0, -1);
    } else if (name.endsWith('!')) {
      caps = 'strict';
      name = name.slice(0, -1);
    }
    const n = norm(name);
    const k = n.replace(/'/g, '');
    if (!k || byKey.has(k)) return;
    byKey.set(k, { code, label: label ?? name, kind, caps, context: CONTEXT_BLOCK[k] });
    patterns.set(k, namePattern(n));
  };
  let added = 0;
  const pause = () => ++added % NAMES_PER_STEP === 0;
  function* addAll(table: Record<string, string>, kind: Kind, caps?: Caps): Generator<void> {
    for (const [code, list] of Object.entries(table)) {
      for (const name of list.split('|')) {
        add(name, code, kind, caps);
        if (pause()) yield;
      }
    }
  }

  for (const phrase of BLOCKED.split('|')) {
    add(phrase, '', 'block');
    if (pause()) yield;
  }
  yield* addAll(ALIASES, 'country');
  yield* addAll(CITIES, 'city');
  yield* addAll(REGIONS, 'region');
  const en = regionNamer('en');
  yield;
  if (en) {
    for (const code of ISO_CODES) {
      let name: string | undefined;
      try {
        name = en.of(code);
      } catch {
        name = undefined;
      }
      if (!name || name === code) continue;
      // "Myanmar (Burma)" → "Myanmar"; "Hong Kong SAR China" stays and is also aliased.
      add(name.replace(/\s*\([^)]*\)/g, ''), code, 'country', PROPER_NAMES.has(keyOf(name)) ? 'proper' : undefined);
      if (pause()) yield;
    }
  }
  yield* addAll(DEMONYMS, 'demonym', 'title');
  yield;

  // Longest first, so "New South Wales" wins over "Wales" at the same position.
  const sources = [...patterns.entries()].sort((a, b) => b[0].length - a[0].length).map(([, p]) => p);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${sources.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return { byKey, re };
}

// Official country names that are also common words or first names.
const PROPER_NAMES = new Set([
  'chad', 'jersey', 'georgia', 'jordan', 'guinea', 'china', 'chile', 'niger', 'mali', 'guernsey', 'panama', 'bermuda', 'reunion',
  'curacao', 'togo', 'dominica', 'christmas island', 'norfolk island',
]);

const gazetteer = stepped(buildGazetteer);

function getGazetteer(): Gazetteer {
  return gazetteer.get();
}

interface Hit {
  entry: Entry;
  index: number;
}

/** True when position i starts a sentence or line ("Nice view!" vs "a week in Nice"). */
function atSentenceStart(s: string, i: number): boolean {
  const before = s.slice(Math.max(0, s.lastIndexOf('\n', i - 1) + 1), i);
  const t = before.replace(/[\s"'“”‘’(\[*_~•·|#-]+$/u, '');
  return !t || /[.!?]$/.test(t);
}

const WORD_BEFORE = /(\p{L}[\p{L}\p{M}'’]*)[ \t\u00A0]+$/u;
const WORD_AFTER = /^[ \t\u00A0]+(\p{L}[\p{L}\p{M}'’]*)/u;

/** The word just before `index` in the same clause (only spaces between), if any. */
function wordBefore(s: string, index: number): string | undefined {
  return WORD_BEFORE.exec(s.slice(Math.max(0, index - 40), index))?.[1];
}

function wordAfter(s: string, index: number): string | undefined {
  return WORD_AFTER.exec(s.slice(index, index + 40))?.[1];
}

const isShouted = (w: string | undefined) => !!w && w.length > 1 && w === w.toUpperCase() && /\p{Lu}/u.test(w);

// Words before a place: "in LA", "moving to LA", "across the US".
const PLACE_BEFORE = new Set(['in', 'at', 'to', 'from', 'near', 'around', 'across', 'visiting', 'exploring', 'the', 'into']);
// "us" is also a pronoun, so "to US", "from US" and "at US" don't count.
const US_BEFORE = new Set(['in', 'the', 'across', 'around', 'visiting', 'exploring']);

/**
 * Context for short aliases that are also words ("US", "LA"): not next to itself ("LA LA
 * Land"), after a place word when one comes before ("in the US", not "follow US"), and not
 * at the start of an all-caps run ("LA VIE EN ROSE", "US OPEN").
 */
function strictContextOk(match: string, s: string, index: number): boolean {
  const w = match.toLowerCase();
  const prev = wordBefore(s, index);
  const next = wordAfter(s, index + match.length);
  if (prev?.toLowerCase() === w || next?.toLowerCase() === w) return false;
  if (prev) {
    if ((w === 'us' ? US_BEFORE : PLACE_BEFORE).has(prev.toLowerCase())) return true;
    // "I love LA" is fine; "I LOVE LA" and "DM US" aren't.
    return w !== 'us' && !isShouted(prev);
  }
  return !isShouted(next);
}

function capsOk(entry: Entry, match: string, s: string, index: number): boolean {
  switch (entry.caps) {
    case 'upper':
      return match === match.toUpperCase();
    case 'strict':
      return match === match.toUpperCase() && strictContextOk(match, s, index);
    case 'title':
      return /^\p{Lu}/u.test(match);
    case 'proper':
      return /^\p{Lu}/u.test(match) && !atSentenceStart(s, index);
    default:
      return true;
  }
}

/** Whether a matched name reads as the place here: capitalisation, context, nearby food words… */
function entryFits(entry: Entry, match: string, s: string, index: number): boolean {
  if (!capsOk(entry, match, s, index)) return false;
  if (!entry.context) return true;
  const window = s.slice(Math.max(0, index - 32), index + match.length + 32).toLowerCase();
  return !entry.context.test(window);
}

/** Every known place name in (already folded) text, in order. */
function scan(folded: string): Hit[] {
  const { byKey, re } = getGazetteer();
  const hits: Hit[] = [];
  for (const m of folded.matchAll(re)) {
    const entry = byKey.get(keyOf(m[0]));
    if (!entry || entry.kind === 'block') continue;
    if (!entryFits(entry, m[0], folded, m.index)) continue;
    hits.push({ entry, index: m.index });
  }
  return hits;
}

/** A whole string that is a known country, city or region ("kyoto" → Kyoto). */
function exactPlace(s: string): Entry | undefined {
  const e = getGazetteer().byKey.get(keyOf(s));
  return e && (e.kind === 'country' || e.kind === 'city' || e.kind === 'region') ? e : undefined;
}

/** Country names in a language → code ("Deutschland" → DE), pausing every few dozen names (see stepped). */
function* buildCountryNames(locale: string): Generator<void, Map<string, string>> {
  const map = new Map<string, string>();
  const namer = regionNamer(locale);
  yield;
  if (namer) {
    for (let i = 0; i < ISO_CODES.length; i++) {
      const code = ISO_CODES[i];
      try {
        const name = namer.of(code);
        if (name && name !== code) map.set(keyOf(name.replace(/\s*\([^)]*\)/g, '')), code);
      } catch {
        /* skip */
      }
      if ((i + 1) % NAMES_PER_STEP === 0) yield;
    }
  }
  return map;
}

const localNameMaps = new Map<string, Stepped<Map<string, string>>>();

function countryNamesIn(locale: string): Stepped<Map<string, string>> {
  let names = localNameMaps.get(locale);
  if (!names) {
    names = stepped(() => buildCountryNames(locale));
    localNameMaps.set(locale, names);
  }
  return names;
}

function localCountryNames(locale: string): Map<string, string> {
  return countryNamesIn(locale).get();
}

/** ISO code for a country name ("Portugal", "UK", "Deutschland" in a German locale), or undefined. */
export function countryCodeFor(name?: string, locale?: string): string | undefined {
  if (typeof name !== 'string') return undefined;
  const k = keyOf(name);
  if (!k) return undefined;
  const e = getGazetteer().byKey.get(k);
  if (e?.kind === 'country') return e.code;
  const local = localCountryNames(locale || defaultLocale()).get(k);
  if (local) return local;
  return /^[A-Za-z]{2}$/.test(name.trim()) ? normalizeCountryCode(name) : undefined;
}

// ---------------------------------------------------------------------------
// guessCountry

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '),
);
const CA_PROVINCES = new Set('ON QC BC AB MB SK NS NB NL PE YT NT NU'.split(' '));

// Two-letter words that are more often English (or chat) than a place after a comma: "Thanks, DM me".
const AMBIGUOUS_ABBR = new Set('OK OR IN ME HI ID NO AM PM BY TO SO AS AT BE DO IS MY PS CV FM DM TV AI IT ON GO'.split(' '));

/** "Austin, TX" → US, "Toronto, QC" → CA, "Lisbon, PT" → PT. */
function codeAfterComma(abbr: string): string | undefined {
  if (AMBIGUOUS_ABBR.has(abbr)) return undefined;
  if (US_STATES.has(abbr)) return 'US';
  if (CA_PROVINCES.has(abbr)) return 'CA';
  return normalizeCountryCode(abbr);
}

const WEIGHT: Record<Kind, number> = { country: 3, city: 3, region: 3, demonym: 1, block: 0 };

export interface GuessOptions {
  /** Count words like "Japanese" or "Italian" as weak evidence. Default true. */
  demonyms?: boolean;
  locale?: string;
}

/**
 * Best offline guess at the country a text is about, from country names and
 * aliases, ~300 well-known cities and regions, flag emoji, "City, ST" and
 * (weakly) demonyms. No network.
 */
export function guessCountry(text: string, opts: GuessOptions = {}): { code: string; name: string } | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const s = fold(stripUrls(text.slice(0, MAX_TEXT).normalize('NFC')));
  const scores = new Map<string, { score: number; first: number }>();
  const bump = (code: string, weight: number, at: number) => {
    const cur = scores.get(code);
    if (cur) cur.score += weight;
    else scores.set(code, { score: weight, first: at });
  };

  for (const hit of scan(s)) {
    if (hit.entry.kind === 'demonym' && opts.demonyms === false) continue;
    bump(hit.entry.code, WEIGHT[hit.entry.kind], hit.index);
  }
  for (const m of s.matchAll(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)) {
    const code = normalizeCountryCode(String.fromCharCode(...[...m[0]].map((c) => c.codePointAt(0)! - 0x1f1e6 + 65)));
    if (code) bump(code, 3, m.index);
  }
  for (const m of s.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'.-]+),[ \t]?([A-Z]{2})(?![\p{L}\p{N}])/gu)) {
    // "Boston, MA", but not "Hi, MA here".
    if (STOP.has(stopKey(m[1])) || GREETINGS.has(stopKey(m[1]))) continue;
    const code = codeAfterComma(m[2]);
    if (code) bump(code, 2, m.index);
  }

  let best: { code: string; score: number; first: number } | undefined;
  for (const [code, v] of scores) {
    if (!best || v.score > best.score || (v.score === best.score && v.first < best.first)) best = { code, ...v };
  }
  return best && { code: best.code, name: countryName(best.code, opts.locale) };
}

// ---------------------------------------------------------------------------
// extractLocationHints

const CONNECTORS = new Set([
  'de', 'da', 'do', 'dos', 'das', 'del', 'della', 'di', 'du', 'des', 'la', 'le', 'les', 'el', 'al', 'of', 'the', 'on', 'upon',
  'am', 'an', 'im', 'y', 'van', 'von', 'der', 'den', 'sur', 'en', 'e',
]);

// Capitalised words that end a place name ("Lisbon This Weekend") or can't start one.
const STOP = new Set(
  (
    'a an and or but nor so yet for with without within to from by on off up down out over under into onto about after before between through during per via vs versus than then as if ' +
    'is are was were be been am has have had do does did will would can could should may might must shall it its this that these those there here what which who whom whose where when why how ' +
    'i im ive you your youre he she we were they theyre me my our us them their his her all any each every some most more less many much few other another such own same just only also very really too not no yes now ' +
    'best top great good amazing awesome favorite favourite perfect ultimate easy quick simple delicious healthy cheap free hidden secret famous beautiful cute cozy cosy first last next full complete official live hd part episode ep vol ' +
    'day days night nights week weeks weekend weekends month months year years time times today tonight tomorrow yesterday morning afternoon evening minute minutes min mins hour hours hr hrs second seconds ' +
    'summer winter spring autumn fall january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec ' +
    'monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thurs fri sat sun ' +
    'guide tips tour tours trip travel travels vlog food foods eats recipe recipes video videos reel reels story stories review reviews things ways places spots ideas edition style vibes ' +
    'please thanks thank love like follow subscribe save share comment dm link bio click check watch see try get go make made eat drink book booking open opens closed ft feat x ' +
    'visiting visit exploring explore discovering discover welcome greetings hello hi hey wow omg lol oh well sure okay ok cheers bye sorry guys everyone friends folks ' +
    'holiday holidays vacation vacay honeymoon living moving moved went going flying flight flights stay staying stayed back arrived landed pm'
  ).split(' '),
);
const JUNK = new Set(
  (
    'home love town bed work school office oven fridge freezer kitchen microwave stock store stores shop shops general total least fact particular bulk case order public private person detail depth short advance touch mind hand ' +
    'description comments cart checkout moderation charge trouble action pieces half season class vogue end world life heaven real ' +
    'amazon target walmart costco ikea aldi lidl tesco sephora etsy ebay netflix youtube spotify instagram tiktok facebook google apple app ' +
    'english french spanish german italian portuguese japanese chinese korean arabic hindi russian dutch greek turkish thai vietnamese'
  ).split(' '),
);
// Not a place on their own ("Best in Show", "in Room 4", "in Excel"), though fine inside a longer name ("Court Street Grocers").
const SOLO_JUNK = new Set(
  (
    'noon midnight concert concerts show shows room stage court theaters theatres cinemas game games progress motion bloom color colour ' +
    'minecraft fortnite roblox excel word powerpoint sheets docs notion figma canva photoshop lightroom procreate capcut blender discord slack teams zoom ' +
    'whatsapp telegram snapchat twitter reddit pinterest twitch threads linkedin gmail outlook chatgpt chrome firefox windows macos ios android iphone ipad python javascript'
  ).split(' '),
);
// Words before a comma that make "X, MA" a greeting or sign-off rather than a place.
const GREETINGS = new Set('yo dear hiya howdy sup ciao hola bonjour aloha love xoxo mom mum dad hun babe'.split(' '));
const ABBREVIATION = /^(?:St|Ste|Mt|Dr|Ave|Rd|Blvd|Ft|Pt|No)\.$/i;
const TOKEN = /[ \t\u00A0]*([\p{L}\p{N}][\p{L}\p{M}\p{N}'’.&-]*)/uy;

const isCapWord = (w: string) => w.length > 1 && /^\p{Lu}/u.test(w);
const stopKey = (w: string) => w.toLowerCase().replace(/['’]/g, '');

/** Capitalised words starting at `from`: "Borough Market" in "at Borough Market, London". */
function capRun(s: string, from: number, max = 6): { words: string[]; end: number } {
  const words: string[] = [];
  const ends: number[] = [];
  let pos = from;
  while (words.length < max) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(s);
    if (!m) break;
    let w = m[1];
    let last = false;
    if (w.endsWith('.') && !ABBREVIATION.test(w)) {
      w = w.replace(/\.+$/, '');
      last = true;
    } else if (/['’]s$/.test(w) && (words.length > 0 || exactPlace(w.slice(0, -2)))) {
      // "Kyoto's best temples", "Borough Market's stalls": the name stops here.
      // (A leading "McDonald's" or "Joe's Pizza" keeps its 's.)
      w = w.slice(0, -2);
      last = true;
    }
    const cap = isCapWord(w);
    const connector = !cap && words.length > 0 && CONNECTORS.has(w.toLowerCase());
    if (!cap && !connector) break;
    if (cap && words.length > 0 && STOP.has(stopKey(w))) break;
    words.push(w);
    ends.push(TOKEN.lastIndex - (m[1].length - w.length));
    pos = TOKEN.lastIndex;
    if (last) break;
  }
  while (words.length && !isCapWord(words[words.length - 1])) {
    words.pop();
    ends.pop();
  }
  return { words, end: ends.length ? ends[ends.length - 1] : from };
}

/** Rejects "Home", "The Oven", "English", "Noon", "Q4"… as the start of a place name. */
function goodStart(all: string[]): boolean {
  // "5th Avenue": judge the name after the number.
  const words = all.length > 1 && isNumberLead(all[0]) ? all.slice(1) : all;
  if (!words.length) return false;
  const [first, second] = words.map(stopKey);
  if (first === 'the') {
    return !!second && !STOP.has(second) && !JUNK.has(second) && !(words.length === 2 && SOLO_JUNK.has(second));
  }
  if (STOP.has(first) || JUNK.has(first)) return false;
  if (words.length === 1 && (SOLO_JUNK.has(first) || /^\p{L}{1,2}\d+$/u.test(words[0]))) return false;
  const e = getGazetteer().byKey.get(keyOf(words.join(' ')));
  return !(e && (e.kind === 'demonym' || e.kind === 'block'));
}

/** A house number or ordinal that starts a street name: "5th" Avenue, "221B" Baker Street. */
function isNumberLead(w: string): boolean {
  return /^\d{1,4}(?:st|nd|rd|th|[a-z])?$/i.test(w) && !/^(?:19|20)\d\d$/.test(w);
}

/** "5th Avenue", "10 Downing Street" — but not "Top 10 Paris" or "2nd Place". */
function numberLeadOk(num: string, words: string[]): boolean {
  return words.length > 0 && isNumberLead(num) && STREET_RE.test(words.join(' '));
}

/** Longest leading run of words that's a known place: "Kyoto Japan" → "Kyoto". */
function knownPrefix(words: string[], kinds?: Kind[]): { text: string; entry: Entry } | undefined {
  for (let n = Math.min(words.length, 5); n > 0; n--) {
    const text = words.slice(0, n).join(' ');
    const entry = exactPlace(text);
    if (entry && (!kinds || kinds.includes(entry.kind))) return { text, entry };
  }
  return undefined;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s,(/-])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase())
    .replace(/(?<=\s)(\p{L}+)(?=\s)/gu, (w) => (CONNECTORS.has(w.toLowerCase()) ? w.toLowerCase() : w));
}

function tidyHint(raw: string): string | undefined {
  let s = raw
    .replace(/@(?=\p{L})/gu, '')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim()
    .replace(/^[\s:：\-–—,.;!?"'“”‘’()\[\]{}*_~]+/u, '')
    .replace(/[\s:：\-–—,;!?"'“”‘’()\[\]{}*_~.]+$/u, '');
  if (s.length < 2 || s.length > 80 || !/\p{L}/u.test(s)) return undefined;
  const known = exactPlace(s);
  if (known) return known.label;
  if (!/\p{Ll}/u.test(s) && s.replace(/[^\p{L}]/gu, '').length > 3) s = titleCase(s);
  return s;
}

/** The useful start of a "📍 …" or "Location: …" value. */
function cutValue(v: string): string {
  let s = v;
  const stop = s.search(/\s#|^#|[|•·]|https?:|www\.|\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u);
  if (stop >= 0) s = s.slice(0, stop);
  const end = s.search(/(?<!\b(?:St|Ste|Mt|Dr|Ave|Rd|Blvd|No|Ft|Pt))[.!?](?:\s|$)/u);
  if (end >= 0) s = s.slice(0, end);
  s = s.replace(/\s+[—–-]\s+/g, ', ');
  // "Kyoto (Japan)" → "Kyoto, Japan"; other asides ("(closed Mondays)") are dropped.
  s = s.replace(/\s*\(([^()]*)\)/g, (_, inner: string) => (exactPlace(inner.trim()) ? `, ${inner.trim()}` : ''));
  s = s.replace(/\s*[()].*$/, '');
  s = s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(', ');
  if (s.length > 80) s = s.slice(0, 80).replace(/[\s,]+[^\s,]*$/, '');
  return s;
}

/** "X, Portugal" / "X, TX" / "X, Amalfi Coast" — the known right-hand side of a comma, if any. */
function knownAfterComma(s: string, at: number, leftIsCity: boolean): string | undefined {
  const abbr = /^[ \t]?([A-Z]{2})(?![\p{L}\p{N}])/u.exec(s.slice(at, at + 4));
  if (abbr && codeAfterComma(abbr[1])) return abbr[1];
  const right = capRun(s, at, 5);
  const kinds: Kind[] = leftIsCity ? ['country', 'region'] : ['country', 'region', 'city'];
  return knownPrefix(right.words, kinds)?.text;
}

/**
 * Capitalised words just before `end` (walking left): "Paris" in "Visiting Paris, France",
 * "5th Avenue" in "at 5th Avenue, New York". `start` is where the first word begins.
 */
function capRunBefore(s: string, end: number): { words: string[]; start: number } {
  const lineStart = Math.max(s.lastIndexOf('\n', end - 1) + 1, end - 120);
  const tokens = [...s.slice(lineStart, end).matchAll(/[^ \t\u00A0]+/g)];
  const words: string[] = [];
  const starts: number[] = [];
  for (let i = tokens.length - 1; i >= 0 && words.length < 5; i--) {
    const raw = tokens[i][0];
    const w = raw.replace(/^[^\p{L}\p{N}]+/u, '');
    if (!w || /[^\p{L}\p{M}\p{N}'’.&-]/u.test(w)) break;
    // "…in Kyoto. Kyoto, Japan": a full stop ends the previous sentence.
    if (words.length && w.endsWith('.') && !ABBREVIATION.test(w)) break;
    const at = lineStart + tokens[i].index + raw.length - w.length;
    const cap = isCapWord(w);
    if (cap && STOP.has(stopKey(w))) break;
    if (!cap && numberLeadOk(w, words)) {
      words.unshift(w);
      starts.unshift(at);
      break;
    }
    if (!cap && !(words.length && CONNECTORS.has(w.toLowerCase()))) break;
    words.unshift(w);
    starts.unshift(at);
    if (w !== raw) break; // "📍Lisbon" or "(Lisbon": nothing more on the left belongs to it
  }
  while (words.length && !isCapWord(words[0]) && !(words.length > 1 && isNumberLead(words[0]))) {
    words.shift();
    starts.shift();
  }
  return { words, start: starts.length ? starts[0] : end };
}

const STRICT_PREPS = new Set(['in', 'at', 'near']);
const KNOWN_PREPS = new Set(['to', 'from', 'visiting', 'visit', 'around', 'across', 'explore', 'exploring', 'discover', 'discovering']);
// "Recipe by Jamie Oliver, London": a person before the comma, not a place.
const PERSON_BEFORE = new Set(['by', 'with', 'feat', 'ft', 'featuring', 'starring', 'credit', 'credits', 'thanks', 'via', 'cc']);
// Values of "📍 …" / "Where: …" that aren't places.
const VALUE_STOP = new Set('my our your his her their its a an this that these those some any see check dm link click tap message text call email ask'.split(' '));
const PLACEHOLDER =
  /^(?:tbd|tba|tbc|n ?a|none|unknown|secret|various|multiple|online|virtual|zoom|everywhere|anywhere|somewhere|nowhere|home|coming soon|soon|below|above|bio|in bio|comments|link in bio|see (?:below|bio|comments|link)|dm(?: me| us)?(?: for .*)?)$/;

/** A "📍 …" or "Where: …" value worth searching for. Labels also need a capital letter or a known place. */
function goodValue(v: string, label: boolean): boolean {
  const k = keyOf(v);
  if (!k || PLACEHOLDER.test(k) || VALUE_STOP.has(k.split(' ')[0])) return false;
  return !label || /\p{Lu}/u.test(v) || scan(fold(v)).some((h) => h.entry.kind !== 'demonym');
}

/**
 * Likely location mentions in free text, best first (max 5), for one-tap place
 * search: "📍 Lisbon, Portugal", "Location: …", "Paris, France", "at Borough
 * Market, London", "in Kyoto", a trailing " — Lisbon", "(Lisbon)", and known
 * city / country names. Offline; skips things like "in 15 minutes" or "at home".
 */
export function extractLocationHints(text: string): string[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  const s = stripUrls(text.slice(0, MAX_TEXT).normalize('NFC'));
  const found: string[] = [];
  const push = (raw: string | undefined) => {
    const h = raw && tidyHint(raw);
    if (h) found.push(h);
  };

  // 1. Pins: "📍 Lisbon, Portugal"
  for (const m of s.matchAll(/(?:\u{1F4CD}|\u{1F4CC})\uFE0F?[ \t]*[:：\-–—]?[ \t]*([^\n]*)/gu)) {
    const value = cutValue(m[1]);
    if (goodValue(value, false)) push(value);
  }

  // 2. Labels: "Location: Shoreditch, London"
  for (const m of s.matchAll(/(?<![\p{L}])(?:location|address|where|venue|spot|place|located at|find us at|find it at)[ \t]*[:：][ \t]*([^\n]+)/giu)) {
    const value = cutValue(m[1]);
    if (goodValue(value, true)) push(value);
  }

  // 3. "Paris, France", "Austin, TX", "Positano, Amalfi Coast"
  for (const m of s.matchAll(/,[ \t]?/g)) {
    const left = capRunBefore(s, m.index);
    if (!left.words.length || !goodStart(left.words)) continue;
    const before = wordBefore(s, left.start);
    if (before && PERSON_BEFORE.has(before.toLowerCase())) continue;
    const leftText = left.words.join(' ');
    const right = knownAfterComma(s, m.index + 1, exactPlace(leftText)?.kind === 'city');
    if (right) push(`${leftText}, ${right}`);
  }

  // 4. "at Borough Market, London", "in Kyoto", "trip to Japan", "at 5th Avenue"
  for (const m of s.matchAll(/(?<![\p{L}\p{N}])(\p{L}+)[ \t\u00A0]+(?=\p{Lu}|\d)/gu)) {
    const prep = m[1].toLowerCase();
    const strict = STRICT_PREPS.has(prep);
    if (!strict && !KNOWN_PREPS.has(prep)) continue;
    let start = m.index + m[0].length;
    let lead: string | undefined;
    if (/\d/.test(s[start])) {
      // A number only starts a street name: "at 5th Avenue", not "in 15 Minutes".
      const num = strict ? /^\d{1,4}(?:st|nd|rd|th|[A-Za-z])?(?=[ \t\u00A0]+\p{Lu})/u.exec(s.slice(start, start + 12)) : null;
      if (!num) continue;
      lead = num[0];
      start += lead.length;
    }
    const run = capRun(s, start);
    if (lead) {
      if (!numberLeadOk(lead, run.words)) continue;
      run.words.unshift(lead);
    }
    if (!goodStart(run.words)) continue;
    if (!strict) {
      const known = knownPrefix(run.words);
      if (known && entryFits(known.entry, known.text, s, start)) push(known.text);
      continue;
    }
    let hint = run.words.join(' ');
    const whole = exactPlace(hint);
    // "LOOK AT US", "Turkey" next to "roast": not the place.
    if (whole && !entryFits(whole, hint, s, start)) continue;
    if (s[run.end] === ',') {
      const known = knownAfterComma(s, run.end + 1, exactPlace(hint)?.kind === 'city');
      if (known) hint += `, ${known}`;
    }
    push(hint);
  }

  // 5. Trailing " — Lisbon" (any capitalised name) or " | Lisbon" / " - Lisbon" (known places only)
  for (const line of s.split('\n')) {
    const m = /\s([—–|-])\s+([^—–|\n]+?)\s*$/u.exec(line);
    if (!m) continue;
    const value = tidyHint(cutValue(m[2]));
    if (!value) continue;
    const loose = m[1] === '—' || m[1] === '–';
    const run = capRun(value, 0);
    const whole = run.words.length > 0 && run.end >= value.length;
    const credit = stopKey(run.words[0] ?? '') === 'the' && !exactPlace(value);
    if (loose ? whole && !credit && goodStart(run.words) : isKnownish(value)) push(value);
  }

  // 6. "(Lisbon)", and "Kyoto (Japan)" → "Kyoto, Japan"
  for (const m of s.matchAll(/\(([^()\n]{2,60})\)/g)) {
    const value = tidyHint(m[1]);
    if (!value || !isKnownish(value)) continue;
    const inner = exactPlace(value);
    const left = inner && inner.kind !== 'city' ? capRunBefore(s, m.index).words : [];
    const outer = left.length ? exactPlace(left.join(' ')) : undefined;
    push(outer && outer.kind !== 'country' ? `${left.join(' ')}, ${value}` : value);
  }

  // 7. Known cities, regions and countries mentioned anywhere (hashtags too)
  const hits = scan(fold(s)).filter((h) => h.entry.kind !== 'demonym');
  for (const kind of ['city', 'region', 'country'] as Kind[]) {
    for (const h of hits) if (h.entry.kind === kind) push(h.entry.label);
  }

  return dedupeHints(found).slice(0, 5);
}

/** A known place, or "Something, <known place>". */
function isKnownish(value: string): boolean {
  if (exactPlace(value)) return true;
  const parts = value.split(/\s*,\s*/);
  return parts.length >= 2 && (!!exactPlace(parts[parts.length - 1]) || !!codeAfterComma(parts[parts.length - 1]));
}

const wordsOf = (s: string) => ` ${keyOf(s)} `;

/** Drops repeats and hints already contained in an earlier, fuller one ("Kyoto" after "Kyoto, Japan"). */
function dedupeHints(hints: string[]): string[] {
  const out: string[] = [];
  for (const h of hints) {
    const w = wordsOf(h);
    if (w.trim() && !out.some((o) => wordsOf(o).includes(w))) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Place details and labels

function sameText(a: string, b: string): boolean {
  return keyOf(a) === keyOf(b);
}

// Address parts naming a street, which are often named after other places ("Paris Street", "Rue de Rome").
const STREET_RE =
  /(?<![\p{L}])(?:street|road|rd|lane|avenue|ave|boulevard|blvd|drive|square|terrace|crescent|alley|highway|parkway|rua|rue|calle|carrer|via|viale|corso|piazza|platz|stra(?:ss|ß)e|gasse|avenida|travessa|largo|praça|plaza|paseo|jalan|soi|thanon|prospekt|prospect)(?![\p{L}])/iu;

/** An address without its street parts, for offline guessing. */
function addressText(address: string | undefined): string {
  return clean(address)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !STREET_RE.test(p))
    .join(', ');
}

/** Best country code for a place: its own, or worked out offline from its country / address. */
export function placeCountryCode(place?: Place): string | undefined {
  if (!place) return undefined;
  const own = normalizeCountryCode(place.countryCode);
  if (own) return own;
  const byName = countryCodeFor(place.country);
  if (byName) return byName;
  const parts = clean(place.address).split(',').map((p) => p.trim()).filter(Boolean);
  const last = parts[parts.length - 1];
  // "…, Cupertino, CA 95014" is California, not Canada.
  const abbr = last && /^([A-Z]{2})(?:\s+[\dA-Z]{3,5}(?:[\s-][\dA-Z]{3,4})?)?$/.exec(last);
  const byAddress = abbr ? codeAfterComma(abbr[1]) : last ? countryCodeFor(last) : undefined;
  if (byAddress) return byAddress;
  // Addresses run small → large, so the last place named wins.
  const hits = scan(fold(stripUrls([place.city, addressText(place.address)].filter(Boolean).join(', ')))).filter(
    (h) => h.entry.kind !== 'demonym',
  );
  return hits.length ? hits[hits.length - 1].entry.code : undefined;
}

/** The last well-known city in some text, optionally only one in a given country. */
function knownCityIn(text: string, code?: string): string | undefined {
  if (!text.trim()) return undefined;
  const hits = scan(fold(stripUrls(text))).filter((h) => h.entry.kind === 'city' && (!code || h.entry.code === code));
  return hits.length ? hits[hits.length - 1].entry.label : undefined;
}

/** The place's city, or a well-known city found in its address. None for a whole country or region. */
export function placeCity(place?: Place): string | undefined {
  if (!place) return undefined;
  const own = clean(place.city);
  if (own) return own;
  if (isAreaPlace(place)) return undefined;
  return knownCityIn(addressText(place.address), placeCountryCode(place));
}

const addressParts = (address: string | undefined) =>
  clean(address)
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/^[\d\s/-]+[a-z]?$/i.test(p));

/** A country, or a region the gazetteer knows ("Bali", "Tuscany", "Hokkaido"). */
function isAreaName(name: string, place: Place): boolean {
  const e = exactPlace(name);
  if (e) return e.kind !== 'city';
  if (clean(place.country) && sameText(name, place.country as string)) return true;
  return name.trim().length > 2 && !!countryCodeFor(name);
}

/**
 * True when a place is a whole country or region ("Japan", "Tuscany, Italy") rather than
 * a spot, so it has no single city: its name or address head is a country or known
 * region, or its address is just "<region>, <country>".
 */
export function isAreaPlace(place?: Place): boolean {
  if (!place) return false;
  const parts = addressParts(place.address);
  const name = clean(place.name);
  const head = name || parts[0];
  if (!head) return false;
  if (isAreaName(head, place)) return true;
  if (name && parts[0] && !sameText(name, parts[0])) return false;
  // "Toscana, Italia": a region (not a known city like "Lisboa, Portugal") and its country.
  if (parts.length !== 2 || clean(place.city) || exactPlace(parts[0])?.kind === 'city') return false;
  return !!countryCodeFor(parts[1]) || (!!clean(place.country) && sameText(parts[1], place.country as string));
}

/**
 * Whether reverse geocoding may supply a missing city. Not for a whole country or region
 * (its centre would give a random village), and not when a full address with its country
 * is already there: that came from a lookup that found no city.
 */
function wantsCity(place: Place): boolean {
  if (clean(place.city) || isAreaPlace(place)) return false;
  return !(clean(place.address) && (normalizeCountryCode(place.countryCode) || clean(place.country)));
}

/** "Lisbon, Portugal", "Portugal", or the first two parts of the address. '' when nothing is known. */
export function placeLabel(place?: Place, locale?: string): string {
  if (!place) return '';
  const code = placeCountryCode(place);
  const city = placeCity(place) ?? '';
  const country = clean(place.country) || (code ? countryName(code, locale) : '');
  if (city && country) return sameText(city, country) ? country : `${city}, ${country}`;
  if (city || country) return city || country;
  return addressParts(place.address).slice(0, 2).join(', ');
}

const validCoords = (p: Place) =>
  Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/**
 * True when a place (with usable coordinates) is missing its country or country code, or
 * a city a lookup could find: spots only, not whole countries or regions.
 */
export function needsDetails(place?: Place): boolean {
  if (!place || !validCoords(place)) return false;
  return !normalizeCountryCode(place.countryCode) || !clean(place.country) || wantsCity(place);
}

type DetailKey = 'name' | 'address' | 'city' | 'country' | 'countryCode';
const DETAIL_KEYS: DetailKey[] = ['name', 'address', 'city', 'country', 'countryCode'];

/**
 * `place` plus any details `from` has that it lacks, when both are the same spot (same
 * coordinates). Never overwrites; returns `place` itself when there's nothing to add.
 */
export function mergePlaceDetails(place: Place, from: Place): Place {
  if (place.lat !== from.lat || place.lng !== from.lng) return place;
  let next = place;
  for (const k of DETAIL_KEYS) {
    const v = clean(from[k]);
    if (v && !clean(place[k])) next = { ...next, [k]: v };
  }
  return next;
}

export interface ResolveOptions {
  /** Also fill a missing venue name from what's at the coordinates. Default true. */
  name?: boolean;
  signal?: AbortSignal;
}

/**
 * Fills a place's missing name / address / city / country / country code —
 * offline first, then by reverse geocoding. Never overwrites existing values.
 * A whole country or region only gets its country filled, and a venue name and
 * address only come from the lookup for bare coordinates.
 * Resolves to the same object when nothing changed (including on failure).
 */
export async function resolvePlaceDetails(place: Place, opts: ResolveOptions = {}): Promise<Place> {
  if (!needsDetails(place)) return place;
  const area = isAreaPlace(place);
  const wantCity = wantsCity(place);
  const bare = !clean(place.address) && !area;
  const next: Place = { ...place };
  let changed = false;
  const fill = (key: DetailKey, value: string | undefined) => {
    const v = clean(value);
    if (v && !clean(next[key])) {
      next[key] = v;
      changed = true;
    }
  };

  const setCode = (value: string | undefined) => {
    const c = normalizeCountryCode(value);
    if (c && !normalizeCountryCode(next.countryCode)) {
      next.countryCode = c;
      changed = true;
    }
  };

  const nameFromCode = () => {
    const c = normalizeCountryCode(next.countryCode);
    if (c && !clean(next.country)) {
      const name = countryName(c);
      if (name !== c) fill('country', name);
    }
  };

  // Offline: a country name gives the code, and a code gives the name.
  setCode(countryCodeFor(next.country));
  // "Bali, Indonesia" or "Tuscany, Italy" says which country it is.
  if (area) setCode(placeCountryCode(next));
  nameFromCode();

  if (!normalizeCountryCode(next.countryCode) || !clean(next.country) || (wantCity && !clean(next.city))) {
    let found: Partial<Place> | undefined;
    try {
      found = await reverseGeocode(place.lat, place.lng, { signal: opts.signal });
    } catch {
      found = undefined;
    }
    if (found) {
      if (bare) {
        if (opts.name !== false) fill('name', found.name);
        fill('address', found.address);
      }
      if (wantCity) fill('city', found.city);
      fill('country', found.country);
      setCode(found.countryCode);
    }
  }
  // Offline or nothing there: settle for what the address — or a country / region's own name — says.
  // (After the lookup, since the coordinates beat a name like "Georgia".)
  if (!normalizeCountryCode(next.countryCode)) {
    const name = area ? clean(next.name) : '';
    setCode(placeCountryCode(next) ?? (name ? (exactPlace(name)?.code ?? countryCodeFor(name)) : undefined));
    nameFromCode();
  }
  return changed ? next : place;
}

// ---------------------------------------------------------------------------
// Grouping by country

export interface CityGroup {
  name: string;
  items: Item[];
}

export interface CountryGroup {
  /** ISO code; undefined for the "Somewhere else" group. */
  code?: string;
  name: string;
  flag: string;
  items: Item[];
  todo: number;
  done: number;
  cities: CityGroup[];
}

export const OTHER_CITY = 'Other';
export const UNKNOWN_COUNTRY = 'Somewhere else';
const OTHER_KEY = keyOf(OTHER_CITY);

export interface GroupOptions {
  locale?: string;
  /** Also place saves without a location by a confident offline guess from their text. Default false. */
  guessFromText?: boolean;
}

const itemText = (item: Item) => [item.title, item.note, item.sharedText, item.description].filter(Boolean).join('\n');

/**
 * Saves with a location, grouped by country (most saves first) and then by city
 * (most first, "Other" last). Saves whose country can't be told end up in a final
 * "Somewhere else" group.
 */
export function groupByCountry(items: Item[], opts: GroupOptions = {}): CountryGroup[] {
  const buckets = new Map<string, { code?: string; items: Item[]; cities: Map<string, CityGroup>; countryNames: string[] }>();

  for (const item of items) {
    let code: string | undefined;
    let city: string | undefined;
    if (item.place) {
      code = placeCountryCode(item.place);
      city = placeCity(item.place);
    } else if (opts.guessFromText) {
      const text = itemText(item);
      code = guessCountry(text, { demonyms: false })?.code;
      if (!code) continue;
      city = knownCityIn(text, code);
    } else {
      continue;
    }

    const key = code ?? '';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { code, items: [], cities: new Map(), countryNames: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
    const countryText = clean(item.place?.country);
    if (countryText) bucket.countryNames.push(countryText);

    const known = city ? exactPlace(city) : undefined;
    let cityKey = city ? keyOf(known?.kind === 'city' ? known.label : city) : '';
    // A city literally called "Other" shares the unknown-city bucket instead of making a second "Other".
    if (cityKey === OTHER_KEY) cityKey = '';
    const group = bucket.cities.get(cityKey);
    if (group) group.items.push(item);
    else bucket.cities.set(cityKey, { name: cityKey ? (city as string) : OTHER_CITY, items: [item] });
  }

  const byName = (a: string, b: string) => a.localeCompare(b, opts.locale);
  const groups: CountryGroup[] = [];
  let unknown: CountryGroup | undefined;

  for (const b of buckets.values()) {
    const cities = [...b.cities.entries()]
      .sort(([ka, a], [kb, bb]) => {
        if (!ka !== !kb) return ka ? -1 : 1; // "Other" last
        return bb.items.length - a.items.length || byName(a.name, bb.name);
      })
      .map(([, c]) => c);
    const done = b.items.filter((i) => i.status === 'done').length;
    let name = UNKNOWN_COUNTRY;
    if (b.code) {
      name = countryName(b.code, opts.locale);
      if (name === b.code && b.countryNames.length) name = b.countryNames[0];
    }
    const group: CountryGroup = {
      code: b.code,
      name,
      flag: flagEmoji(b.code),
      items: b.items,
      todo: b.items.length - done,
      done,
      cities,
    };
    if (b.code) groups.push(group);
    else unknown = group;
  }

  groups.sort((a, b) => b.items.length - a.items.length || byName(a.name, b.name));
  if (unknown) groups.push(unknown);
  return groups;
}

/**
 * "5 want to go · 2 visited", using each type's own wording when a group is all
 * one kind of save, and "to do" / "done" otherwise.
 */
export function groupSummary(items: Item[]): string {
  const todo = items.filter((i) => i.status !== 'done');
  const done = items.filter((i) => i.status === 'done');
  const word = (list: Item[], pick: 'todo' | 'done', fallback: string) => {
    const words = new Set(list.map((i) => TYPE_INFO[i.type]?.[pick].toLowerCase() ?? fallback));
    return words.size === 1 ? [...words][0] : fallback;
  };
  const parts: string[] = [];
  if (todo.length) parts.push(`${todo.length} ${word(todo, 'todo', 'to do')}`);
  if (done.length) parts.push(`${done.length} ${word(done, 'done', 'done')}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Idle-time warm-up (see warmup.ts)

/**
 * Builds the gazetteer and the device-language country names a small step at a time. True once both are built.
 * The tables come out exactly as when a lookup builds them on the spot.
 */
export function warmTablesStep(): boolean {
  return gazetteer.step() && countryNamesIn(defaultLocale()).step();
}

/**
 * This module's regexes, the gazetteer's too once it's built, so they can be compiled ahead of time (a regex
 * compiles on its first runs, which takes a while for the big Unicode ones on a phone).
 */
export function warmRegExps(): RegExp[] {
  const built = gazetteer.peek();
  return [
    ...(built ? [built.re] : []),
    ...Object.values(CONTEXT_BLOCK),
    WORD_BEFORE,
    WORD_AFTER,
    ABBREVIATION,
    TOKEN,
    PLACEHOLDER,
    STREET_RE,
  ];
}
