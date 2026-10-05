import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetGeoState } from './geo';
import {
  countryCodeFor,
  countryName,
  extractLocationHints,
  flagEmoji,
  groupByCountry,
  groupSummary,
  guessCountry,
  isAreaPlace,
  mergePlaceDetails,
  needsDetails,
  normalizeCountryCode,
  OTHER_CITY,
  placeCity,
  placeCountryCode,
  placeCandidates,
  placeLabel,
  resolvePlaceDetails,
  UNKNOWN_COUNTRY,
} from './location';
import type { Item, ItemType, Place, Status } from './types';

let n = 0;
function item(title: string, place?: Place, opts: { type?: ItemType; status?: Status; note?: string } = {}): Item {
  n += 1;
  return {
    id: `i${n}`,
    type: opts.type ?? 'place',
    title,
    note: opts.note,
    tags: [],
    collectionIds: [],
    status: opts.status ?? 'todo',
    place,
    createdAt: n,
    updatedAt: n,
  };
}
const at = (extra: Partial<Place> = {}): Place => ({ lat: 1, lng: 2, ...extra });
const hints = (s: string) => extractLocationHints(s);
const guess = (s: string) => guessCountry(s, { locale: 'en' })?.code;

describe('country codes, flags and names', () => {
  it('normalises codes', () => {
    expect(normalizeCountryCode(' pt ')).toBe('PT');
    expect(normalizeCountryCode('uk')).toBe('GB');
    expect(normalizeCountryCode('XK')).toBe('XK');
    expect(normalizeCountryCode('ZZ')).toBeUndefined();
    expect(normalizeCountryCode('PRT')).toBeUndefined();
    expect(normalizeCountryCode(undefined)).toBeUndefined();
  });

  it('turns codes into flag emoji', () => {
    expect(flagEmoji('PT')).toBe('🇵🇹');
    expect(flagEmoji('gb')).toBe('🇬🇧');
    expect(flagEmoji('JP')).toBe('\u{1F1EF}\u{1F1F5}');
    expect(flagEmoji('zz')).toBe('🌐');
    expect(flagEmoji(undefined)).toBe('🌐');
    expect(flagEmoji('', '')).toBe('');
  });

  it('names countries in the requested language', () => {
    expect(countryName('PT', 'en')).toBe('Portugal');
    expect(countryName('de', 'fr')).toBe('Allemagne');
    expect(countryName('HK', 'en')).toBe('Hong Kong');
    expect(countryName('XX', 'en')).toBe('XX');
    expect(countryName('', 'en')).toBe('');
  });

  it('falls back to the code without Intl.DisplayNames', () => {
    vi.stubGlobal('Intl', { ...Intl, DisplayNames: undefined });
    try {
      expect(countryName('PT', 'sv-FI')).toBe('PT');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('finds codes for country names and aliases', () => {
    expect(countryCodeFor('Portugal')).toBe('PT');
    expect(countryCodeFor('united kingdom')).toBe('GB');
    expect(countryCodeFor('UK')).toBe('GB');
    expect(countryCodeFor('U.S.A.')).toBe('US');
    expect(countryCodeFor('Türkiye')).toBe('TR');
    expect(countryCodeFor('Deutschland', 'de')).toBe('DE');
    expect(countryCodeFor('pt')).toBe('PT');
    expect(countryCodeFor('Narnia')).toBeUndefined();
    expect(countryCodeFor('Lisbon')).toBeUndefined();
  });
});

describe('placeLabel and friends', () => {
  it('prefers "City, Country"', () => {
    expect(placeLabel(at({ city: 'Lisbon', country: 'Portugal', countryCode: 'PT' }))).toBe('Lisbon, Portugal');
    expect(placeLabel(at({ city: 'Lisbon', countryCode: 'PT' }), 'en')).toBe('Lisbon, Portugal');
    expect(placeLabel(at({ city: 'Singapore', country: 'Singapore' }))).toBe('Singapore');
  });

  it('shows just the country when that is all it knows', () => {
    expect(placeLabel(at({ countryCode: 'PT' }), 'en')).toBe('Portugal');
    expect(placeLabel(at({ country: 'Japan' }))).toBe('Japan');
  });

  it('works out city and country from an address, ignoring streets named after places', () => {
    const place = at({ address: 'Dishoom, 12, Upper St Martin’s Lane, London' });
    expect(placeCountryCode(place)).toBe('GB');
    expect(placeCity(place)).toBe('London');
    expect(placeLabel(place, 'en')).toBe('London, United Kingdom');
    expect(placeCountryCode(at({ address: 'Paris Street, Exeter, England' }))).toBe('GB');
    expect(placeCity(at({ address: 'Rua Augusta 24, Lisboa, Portugal' }))).toBe('Lisbon');
  });

  it('falls back to the first two parts of the address', () => {
    expect(placeLabel(at({ address: 'Café Luna, 12, Rua das Flores, Bairro Qualquer' }))).toBe('Café Luna, Rua das Flores');
    expect(placeLabel(at())).toBe('');
    expect(placeLabel(undefined)).toBe('');
  });
});

describe('groupByCountry', () => {
  const lisbon1 = item('Time Out Market', at({ city: 'Lisbon', countryCode: 'PT' }), { status: 'done' });
  const lisbon2 = item('Pastéis de Belém', at({ city: 'Lisbon', countryCode: 'PT' }));
  const porto = item('Livraria Lello', at({ city: 'Porto', countryCode: 'PT' }));
  const sintra = item('Pena Palace', at({ country: 'Portugal' })); // no code, no city
  const kyoto1 = item('Fushimi Inari', at({ city: 'Kyoto', countryCode: 'JP' }));
  const kyoto2 = item('Nishiki Market', at({ city: 'Kyoto', countryCode: 'jp' }));
  const london = item('Dishoom', at({ city: 'London', countryCode: 'GB' }), { type: 'recipe' });
  const nowhere = item('Mystery spot', at());
  const noPlace = item('Ramen in Kyoto', undefined, { type: 'video' });

  const groups = groupByCountry([london, lisbon1, nowhere, kyoto1, porto, noPlace, lisbon2, kyoto2, sintra], { locale: 'en' });

  it('orders countries by number of saves, unknown last', () => {
    expect(groups.map((g) => g.code)).toEqual(['PT', 'JP', 'GB', undefined]);
    expect(groups.map((g) => g.name)).toEqual(['Portugal', 'Japan', 'United Kingdom', UNKNOWN_COUNTRY]);
    expect(groups[0].flag).toBe('🇵🇹');
    expect(groups[3].flag).toBe('🌐');
  });

  it('only includes saves with a location', () => {
    expect(groups.flatMap((g) => g.items)).not.toContain(noPlace);
    expect(groups[3].items).toEqual([nowhere]);
  });

  it('counts to-do and done', () => {
    expect(groups[0].todo).toBe(3);
    expect(groups[0].done).toBe(1);
  });

  it('groups cities by count with "Other" last', () => {
    expect(groups[0].cities.map((c) => [c.name, c.items.length])).toEqual([
      ['Lisbon', 2],
      ['Porto', 1],
      [OTHER_CITY, 1],
    ]);
    expect(groups[1].cities).toEqual([{ name: 'Kyoto', items: [kyoto1, kyoto2] }]);
  });

  it('breaks ties by name and leaves out an empty unknown group', () => {
    const g = groupByCountry([item('b', at({ countryCode: 'FR' })), item('a', at({ countryCode: 'AT' }))], { locale: 'en' });
    expect(g.map((x) => x.name)).toEqual(['Austria', 'France']);
    expect(groupByCountry([])).toEqual([]);
  });

  it('keeps one "Other" even when a city is literally called that', () => {
    const g = groupByCountry(
      [item('a', at({ countryCode: 'FR' })), item('b', at({ countryCode: 'FR', city: 'Other' })), item('c', at({ countryCode: 'FR', city: 'Paris' }))],
      { locale: 'en' },
    );
    expect(g[0].cities.map((c) => [c.name, c.items.length])).toEqual([
      ['Paris', 1],
      [OTHER_CITY, 2],
    ]);
  });

  it('puts a whole country or region under "Other", not an invented city', () => {
    const japan = item('Japan trip', at({ name: 'Japan', address: 'Japan', country: 'Japan', countryCode: 'JP' }));
    const bali = item('Bali', at({ name: 'Bali', address: 'Bali, Indonesia' }));
    const g = groupByCountry([japan, bali], { locale: 'en' });
    expect(g.map((x) => [x.code, x.cities.map((c) => c.name)])).toEqual([
      ['ID', [OTHER_CITY]],
      ['JP', [OTHER_CITY]],
    ]);
  });

  it('can place saves without a location by what their text mentions', () => {
    const g = groupByCountry([noPlace, item('Thai green curry', undefined, { type: 'recipe' })], { guessFromText: true, locale: 'en' });
    expect(g).toHaveLength(1);
    expect(g[0].code).toBe('JP');
    expect(g[0].cities[0].name).toBe('Kyoto');
  });
});

describe('groupSummary', () => {
  it('uses the save type’s own words', () => {
    expect(groupSummary([item('a', at()), item('b', at()), item('c', at(), { status: 'done' })])).toBe('2 want to go · 1 visited');
    expect(groupSummary([item('a', at(), { type: 'recipe', status: 'done' })])).toBe('1 cooked');
  });

  it('falls back to "to do" / "done" for mixed saves', () => {
    const mixed = [item('a', at(), { type: 'recipe' }), item('b', at(), { type: 'video' }), item('c', at(), { status: 'done' })];
    expect(groupSummary(mixed)).toBe('2 to do · 1 visited');
    expect(groupSummary([])).toBe('');
  });
});

describe('extractLocationHints', () => {
  it('reads pins and labels', () => {
    expect(hints('📍 Lisbon, Portugal\n\nBest pastéis in town #lisbon #travel')).toEqual(['Lisbon, Portugal']);
    expect(hints('📍Kyoto')).toEqual(['Kyoto']);
    expect(hints('Location: Shoreditch, London')).toEqual(['Shoreditch, London']);
    expect(hints('📍 @dishoom Covent Garden — London 🍛')[0]).toBe('dishoom Covent Garden, London');
  });

  it('reads "in …", "at …, City" and "City, Country"', () => {
    expect(hints('Matcha everything in Kyoto 🍵')).toEqual(['Kyoto']);
    expect(hints('Street food at Borough Market, London')).toEqual(['Borough Market, London']);
    expect(hints('Paris, France')).toEqual(['Paris, France']);
    expect(hints('Visiting Paris, France with friends')).toEqual(['Paris, France']);
    expect(hints('Austin, TX taco crawl')).toEqual(['Austin, TX']);
    expect(hints('Things To Do In Lisbon This Weekend')).toEqual(['Lisbon']);
    expect(hints('🌮 BEST TACOS IN MEXICO CITY')).toEqual(['Mexico City']);
    expect(hints("Kyoto's best temples")).toEqual(['Kyoto']);
  });

  it('reads trailing names and parentheses', () => {
    expect(hints('Best pastel de nata — Lisbon')).toEqual(['Lisbon']);
    expect(hints('Best pastel de nata | Lisbon')).toEqual(['Lisbon']);
    expect(hints('Hidden gem (Lisbon)')).toEqual(['Lisbon']);
    expect(hints('Tiny wine bar — Aveiro')).toEqual(['Aveiro']);
  });

  it('skips everyday phrases', () => {
    for (const junk of [
      'Ready in 15 minutes',
      'Fell in love with this',
      'Workout at home',
      'Bake in the oven for 20 minutes',
      'Dinner at 7pm',
      'Best Pizza In Town',
      'Speak in English please',
      'Available at Amazon',
      'Thanks, DM me for the link',
      'Pasta carbonara — easy weeknight dinner',
      'Blinding Lights — The Weeknd',
      'Nice view!',
      'Tutorial (Official Video)',
    ]) {
      expect(hints(junk), junk).toEqual([]);
    }
  });

  it('skips "US" / "LA" when they are words, including in all-caps captions', () => {
    for (const junk of [
      'FOLLOW US FOR MORE RECIPES',
      'Link in bio, DM US',
      'LA LA LAND soundtrack',
      'LA VIE EN ROSE',
      'COME VISIT US',
      'Come Visit Us',
      'LOOK AT US',
      'I LOVE LA',
      'Hi, MA here',
    ]) {
      expect(hints(junk), junk).toEqual([]);
    }
  });

  it('still finds "US" / "LA" where a place fits', () => {
    expect(hints('BEST TACOS IN LA')).toEqual(['Los Angeles']);
    expect(hints('I love LA')).toEqual(['Los Angeles']);
    expect(hints('Moving to LA next month')).toEqual(['Los Angeles']);
    expect(hints('HIKING IN THE US')).toEqual(['US']);
    expect(hints('US road trip')).toEqual(['US']);
    expect(hints('UK ROAD TRIP')).toEqual(['UK']);
    expect(hints('Boston, MA')).toEqual(['Boston, MA']);
  });

  it('skips everyday words after "in" / "at"', () => {
    for (const junk of [
      'Meet at Noon',
      'Live in Concert',
      'Meeting in Room 4',
      'Launching in Q4',
      'Best in Show',
      'Built in Minecraft',
      'Made in Excel',
      'Join us in Discord',
      'Like in Real Life',
      'Done in 15 Minutes',
      'Doors at 7 PM',
      'Finished in 2nd Place',
    ]) {
      expect(hints(junk), junk).toEqual([]);
    }
  });

  it('keeps street numbers and brand names whole, and skips people', () => {
    expect(hints('Cocktails at 5th Avenue, New York')).toEqual(['5th Avenue, New York']);
    expect(hints('Photo op at 10 Downing Street, London')).toEqual(['10 Downing Street, London']);
    expect(hints('Top 10 Paris, France')).toEqual(['Paris, France']);
    expect(hints("Late night at McDonald's")).toEqual(["McDonald's"]);
    expect(hints("Lunch at Joe's Pizza, NYC")[0]).toBe("Joe's Pizza, NYC");
    expect(hints('Sandwiches at Court Street Grocers, Brooklyn')).toEqual(['Court Street Grocers, Brooklyn']);
    expect(hints('Recipe by Jamie Oliver, London')).toEqual(['London']);
    expect(hints('Street food at Borough Market’s stalls')).toEqual(['Borough Market']);
  });

  it('ignores placeholder labels and pins', () => {
    for (const junk of ['Where: my place', 'Spot: TBD', 'Location: online', 'Location: N/A', 'Location: DM for address', '📍 home']) {
      expect(hints(junk), junk).toEqual([]);
    }
    expect(hints('where: lisbon')).toEqual(['Lisbon']);
    expect(hints('📍 Tasca do Chico (closed Mondays)')).toEqual(['Tasca do Chico']);
  });

  it('reads "City (Country)" as one place, city first', () => {
    expect(hints('Kyoto (Japan)')).toEqual(['Kyoto, Japan']);
    expect(hints('📍 Kyoto (Japan)')).toEqual(['Kyoto, Japan']);
    expect(hints('Porto (Portugal) food tour')).toEqual(['Porto, Portugal']);
  });

  it('ignores links, dedupes and keeps the best five', () => {
    expect(hints('Ramen in Shinjuku https://example.com/london-paris')).toEqual(['Shinjuku']);
    expect(hints('Dinner in Kyoto. Kyoto, Japan! #kyoto')).toEqual(['Kyoto, Japan']);
    const many = hints('Tokyo, Kyoto, Osaka, Nara, Kobe, Hiroshima and Sapporo');
    expect(many).toHaveLength(5);
    expect(new Set(many).size).toBe(5);
    expect(hints('')).toEqual([]);
  });
});

describe('guessCountry', () => {
  it('recognises countries, aliases, cities and flags', () => {
    expect(guessCountry('Weekend in Lisbon', { locale: 'en' })).toEqual({ code: 'PT', name: 'Portugal' });
    expect(guess('Kyoto, Japan')).toBe('JP');
    expect(guess('NYC pizza crawl')).toBe('US');
    expect(guess('Bali retreat')).toBe('ID');
    expect(guess('UK road trip')).toBe('GB');
    expect(guess('Scotland in autumn')).toBe('GB');
    expect(guess('Tulips in Holland')).toBe('NL');
    expect(guess('Street food in Korea')).toBe('KR');
    expect(guess('Czechia')).toBe('CZ');
    expect(guess('New Mexico road trip')).toBe('US');
    expect(guess('Istanbul, Turkey')).toBe('TR');
    expect(guess('🇵🇹 vibes')).toBe('PT');
    expect(guess('Austin, TX')).toBe('US');
    expect(guess('Saint Lucia beach')).toBe('LC');
    expect(guess('Côte d’Ivoire')).toBe('CI');
    expect(guess('A week in Nice')).toBe('FR');
  });

  it('weighs places over demonyms', () => {
    expect(guess('Japanese restaurant in London')).toBe('GB');
    expect(guess('Thai green curry')).toBe('TH');
    expect(guessCountry('Thai green curry', { demonyms: false })).toBeUndefined();
  });

  it('does not match inside words or everyday uses', () => {
    expect(guess('Chadwick Boseman marathon')).toBeUndefined();
    expect(guess('roast turkey')).toBeUndefined();
    expect(guess('Easy Roast Turkey Recipe')).toBeUndefined();
    expect(guess('Nice view!')).toBeUndefined();
    expect(guess('let us go')).toBeUndefined();
    expect(guess('Backpacking South America')).toBeUndefined();
    expect(guess('Dutch oven bread')).toBeUndefined();
    expect(guess('')).toBeUndefined();
  });

  it('does not read "US" / "LA" / state codes from shouting or chat', () => {
    expect(guess('FOLLOW US FOR MORE RECIPES')).toBeUndefined();
    expect(guess('Link in bio, DM US')).toBeUndefined();
    expect(guess('LA LA LAND soundtrack')).toBeUndefined();
    expect(guess('Hi, MA here')).toBeUndefined();
    expect(guess('HI, MA HERE')).toBeUndefined();
    expect(guess('Road trip across the US')).toBe('US');
    expect(guess('Tacos in LA 🌮')).toBe('US');
    expect(guess('Lobster rolls, Boston, MA')).toBe('US');
  });
});

describe('CJK places', () => {
  it('recognises Chinese, Japanese and Korean place names', () => {
    expect(guess('週末去東京食拉麵')).toBe('JP');
    expect(guess('首爾三日兩夜行程')).toBe('KR');
    expect(guess('서울특별시 마포구 예시로 10')).toBe('KR');
    expect(guess('경기도 수원시 예시구 예시로 5')).toBe('KR');
    expect(guess('曼谷自由行攻略')).toBe('TH');
    expect(guess('西環食早餐')).toBe('HK');
    expect(guess('塔斯曼尼亞徒步')).toBe('AU');
    expect(guess('南法薰衣草田')).toBe('FR');
    expect(guess('广东早茶推介')).toBe('CN');
    expect(guess('タイ旅行')).toBe('TH');
    expect(guessCountry('酒店喺Siam隔籬', { locale: 'en' })?.code).toBe('TH');
  });

  it('prefers the most mentioned country, and the one after a pin', () => {
    expect(guess('#意大利 #羅馬 #法國')).toBe('IT');
    expect(guess('倫敦同東京都去過，今次去首爾')).toBe('GB'); // a tie: the first named
    expect(guess('倫敦同東京都去過，今次去首爾 📍 서울특별시 종로구 예시로 1')).toBe('KR');
  });

  it('skips brands, origins and everyday words', () => {
    for (const junk of [
      '日本品牌嘅護膚品',
      '韓國男團演唱會門票',
      '泰國菜食譜',
      '由台灣直送香港，買滿包郵',
      '川貝燉雪梨',
      '舞台中央',
      '巴黎世家新款手袋',
      'タイムセール',
      'Made in Japan ceramics',
      'Our new Korean skincare routine',
      'New menu by @tokyo_cafe_guide',
    ]) {
      expect(guessCountry(junk, { demonyms: false }), junk).toBeUndefined();
    }
    expect(guess('香港人最愛')).toBe('HK');
    expect(guessCountry('香港人最愛', { demonyms: false })).toBeUndefined();
    expect(hints('Ceramics made in Japan')).toEqual([]);
  });

  it('reads CJK pins and labels', () => {
    expect(hints('同朋友去咗間酒店（珠海）📍某某酒店 #珠海好去處')).toEqual(['某某酒店', '珠海']);
    expect(hints('地址：沙田新城市廣場二期3樓')[0]).toBe('New Town Plaza, Sha Tin');
    expect(hints('我喺 Central World 搵到呢間小店')).toContain('Central World');
    expect(hints('大阪美食 📍小貼士：記得早啲去排隊')).toEqual(['大阪']);
    expect(hints('📍附近有好多小店行')).toEqual([]);
  });
});

describe('placeCandidates', () => {
  const top = (s: string) => placeCandidates(s)[0];

  it('searches a pinned venue in the city named elsewhere', () => {
    expect(top('京都兩日一夜 📍八坂神社')).toEqual({ query: '八坂神社, 京都', countryCode: 'JP', marked: true });
    expect(top('同朋友去咗間酒店（珠海）📍某某酒店 #珠海好去處')).toEqual({ query: '某某酒店, 珠海', countryCode: 'CN', marked: true });
    // Hong Kong is its own city: no district added.
    expect(top('📍Lookout Rock viewpoint Directions: walk up from Quarry Bay MTR')).toEqual({ query: 'Lookout Rock viewpoint', countryCode: 'HK', marked: true });
  });

  it('knows malls and addresses', () => {
    expect(top('📍 K11 Musea 2/F 期間限定店')).toEqual({ query: 'K11 Musea', countryCode: 'HK', marked: true });
    expect(top('地址：沙田新城市廣場二期3樓')).toEqual({ query: 'New Town Plaza, Sha Tin', countryCode: 'HK', marked: true });
    expect(top('韓國Cafe推介 📍 @somecafe 서울특별시 마포구 예시로 10 #弘大')).toEqual({ query: '서울특별시 마포구 예시로 10', countryCode: 'KR', marked: true });
    expect(top('📍12 Rue Exemple, 06000 Nice, France 夜晚好靚')).toEqual({ query: '12 Rue Exemple, 06000 Nice, France', countryCode: 'FR', marked: true });
    expect(top('📍 Kyoto (Japan)')).toEqual({ query: 'Kyoto, Japan', countryCode: 'JP', marked: true, area: 'city' });
  });

  it('looks past "search it on Google Maps 👇" to the place', () => {
    expect(top('📍地址: Google map 搵得到 👇 Sunny Beach Club 營業時間：週末 10:00-18:00 #西貢')).toEqual({
      query: 'Sunny Beach Club',
      countryCode: 'HK',
      marked: true,
    });
  });

  it('falls back to the city, region or country named', () => {
    expect(top('北海道美食 📍小貼士：記得早啲去排隊')).toEqual({ query: '北海道', countryCode: 'JP', marked: false, area: 'region' });
    expect(top('📌 English subtitles in the comments. Camping trip in Tasmania')).toEqual({
      query: 'Tasmania',
      countryCode: 'AU',
      marked: false,
      area: 'region',
    });
    expect(top('Great Barrier Reef 浮潛 澳洲')).toEqual({ query: 'Great Barrier Reef', countryCode: 'AU', marked: false, area: 'region' });
    expect(top('#意大利 #羅馬 #法國')).toEqual({ query: '羅馬', countryCode: 'IT', marked: false, area: 'city' });
    expect(top('放假去曼谷食嘢')).toEqual({ query: '曼谷', countryCode: 'TH', marked: false, area: 'city' });
  });

  it('puts a spot by a known place before the areas', () => {
    expect(placeCandidates('Street food at Borough Market, London')).toEqual([
      { query: 'Borough Market, London', countryCode: 'GB', marked: false },
      { query: 'London', countryCode: 'GB', marked: false, area: 'city' },
    ]);
  });

  it('skips a place named as a style, and people named after places', () => {
    expect(placeCandidates('Hong Kong style cafe in Manchester')).toEqual([{ query: 'Manchester', countryCode: 'GB', marked: false, area: 'city' }]);
    expect(placeCandidates('Hong Kong-style milk tea at home')).toEqual([]);
    expect(placeCandidates('香港style茶餐廳 喺台北開分店')).toEqual([{ query: '台北', countryCode: 'TW', marked: false, area: 'city' }]);
    expect(placeCandidates('Paris Hilton DJ set this Saturday')).toEqual([]);
    expect(placeCandidates('Weekend in Paris with friends')[0]).toMatchObject({ query: 'Paris', countryCode: 'FR' });
  });

  it('finds nothing in text without a place', () => {
    expect(placeCandidates('')).toEqual([]);
    expect(placeCandidates('Easy weeknight pasta')).toEqual([]);
    expect(placeCandidates('日本品牌嘅新電飯煲開箱')).toEqual([]);
    expect(placeCandidates('秘密海灘🏖 唔講位置 (片尾有提示)')).toEqual([]);
  });
});

describe('needsDetails / resolvePlaceDetails', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetGeoState();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const KYOTO = {
    name: 'Nishiki Market',
    display_name: 'Nishiki Market, Nakagyo Ward, Kyoto, Japan',
    address: { amenity: 'Nishiki Market', city: 'Kyoto', country: 'Japan', country_code: 'jp' },
  };

  it('knows when a place is missing details', () => {
    expect(needsDetails(at())).toBe(true);
    expect(needsDetails(at({ city: 'Kyoto', country: 'Japan', countryCode: 'JP' }))).toBe(false);
    expect(needsDetails({ lat: NaN, lng: 1 })).toBe(false);
    expect(needsDetails(undefined)).toBe(false);
  });

  it('fills what is missing', async () => {
    fetchMock.mockResolvedValue(reply(KYOTO));
    const place = at({ lat: 35.005, lng: 135.764 });
    const full = await resolvePlaceDetails(place);
    expect(full).toEqual({ lat: 35.005, lng: 135.764, name: 'Nishiki Market', address: KYOTO.display_name, city: 'Kyoto', country: 'Japan', countryCode: 'JP' });
    expect(place).toEqual({ lat: 35.005, lng: 135.764 }); // not mutated
  });

  it('never overwrites what is already there', async () => {
    fetchMock.mockResolvedValue(reply(KYOTO));
    const full = await resolvePlaceDetails(at({ name: 'My favourite pickles', city: 'Nakagyo' }));
    expect(full.name).toBe('My favourite pickles');
    expect(full.city).toBe('Nakagyo');
    expect(full.countryCode).toBe('JP');
  });

  it('can leave the venue name alone', async () => {
    fetchMock.mockResolvedValue(reply(KYOTO));
    expect((await resolvePlaceDetails(at(), { name: false })).name).toBeUndefined();
  });

  it('fills the code offline when it can, without a request', async () => {
    const place = at({ city: 'Lisbon', country: 'Portugal' });
    expect(await resolvePlaceDetails(place)).toEqual({ ...place, countryCode: 'PT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not give a whole country a city (reverse geocoding its centre)', async () => {
    fetchMock.mockResolvedValue(
      reply({ name: 'Some Shrine', display_name: 'Some Shrine, Hamlet, Japan', address: { amenity: 'Some Shrine', hamlet: 'Hamlet', country: 'Japan', country_code: 'jp' } }),
    );
    const japan: Place = { lat: 36.5, lng: 139.2, name: 'Japan', address: 'Japan', country: 'Japan', countryCode: 'JP' };
    expect(isAreaPlace(japan)).toBe(true);
    expect(needsDetails(japan)).toBe(false);
    expect(await resolvePlaceDetails(japan)).toBe(japan);
    expect(placeLabel(japan)).toBe('Japan');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills only the country of a region, offline when it can', async () => {
    fetchMock.mockResolvedValue(reply({ address: { hamlet: 'Random Village', country: 'Indonesia', country_code: 'id' } }));
    const bali: Place = { lat: -8.4, lng: 115.1, name: 'Bali', address: 'Bali, Indonesia' };
    expect(isAreaPlace(bali)).toBe(true);
    const full = await resolvePlaceDetails(bali);
    expect(full.city).toBeUndefined();
    expect(full.countryCode).toBe('ID');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(placeCity(bali)).toBeUndefined();
    expect(isAreaPlace(at({ name: 'Toscana', address: 'Toscana, Italia', country: 'Italia' }))).toBe(true);
  });

  it('takes only the country from a lookup for a region it cannot place offline', async () => {
    fetchMock.mockResolvedValue(reply({ name: 'Some Shrine', display_name: 'Some Shrine, Hamlet, Japan', address: { hamlet: 'Hamlet', country: 'Japan', country_code: 'jp' } }));
    const full = await resolvePlaceDetails(at({ name: 'Nippon', country: 'Nippon' }));
    expect(full).toEqual(at({ name: 'Nippon', country: 'Nippon', countryCode: 'JP' }));
  });

  it('lets the coordinates decide an ambiguous country / region name, the name only offline', async () => {
    fetchMock.mockResolvedValue(reply({ address: { state: 'Georgia', country: 'United States', country_code: 'us' } }));
    const atlanta = await resolvePlaceDetails({ lat: 33.7, lng: -84.4, name: 'Georgia' });
    expect(atlanta.countryCode).toBe('US');
    expect(atlanta.city).toBeUndefined();

    resetGeoState();
    fetchMock.mockRejectedValue(new TypeError('offline'));
    expect((await resolvePlaceDetails({ lat: 41.7, lng: 44.8, name: 'Georgia' })).countryCode).toBe('GE');
    resetGeoState();
    expect((await resolvePlaceDetails({ lat: 36.5, lng: 139.2, name: 'Japan' })).country).toBe(countryName('JP'));
  });

  it('tells spots from areas', () => {
    expect(isAreaPlace(at())).toBe(false);
    expect(isAreaPlace(at({ name: 'Time Out Market', address: 'Time Out Market, Avenida 24 de Julho, Lisboa, Portugal' }))).toBe(false);
    expect(isAreaPlace(at({ name: 'Lisboa', address: 'Lisboa, Portugal' }))).toBe(false); // a known city
    expect(isAreaPlace(at({ name: 'Portugal' }))).toBe(true);
    expect(isAreaPlace(undefined)).toBe(false);
  });

  it('knows regions by their Chinese / Japanese names too, so they get no random city', () => {
    const region: Place = { lat: 43.2, lng: 142.8, name: '北海道', country: '日本', countryCode: 'JP' };
    expect(isAreaPlace(region)).toBe(true);
    expect(needsDetails(region)).toBe(false);
    // A city keeps its own name as its city.
    const city: Place = { lat: 34.69, lng: 135.5, name: '大阪', city: '大阪', country: '日本', countryCode: 'JP' };
    expect(isAreaPlace(city)).toBe(false);
    expect(needsDetails(city)).toBe(false);
  });

  it('does not look up a city a full search result already went without', async () => {
    const park = at({ name: 'Serengeti National Park', address: 'Serengeti National Park, Mara, Tanzania', country: 'Tanzania', countryCode: 'TZ' });
    expect(needsDetails(park)).toBe(false);
    expect(await resolvePlaceDetails(park)).toBe(park);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives an older saved venue its city and country, but not a neighbour’s name', async () => {
    fetchMock.mockResolvedValue(
      reply({ name: 'Bar Next Door', display_name: 'Bar Next Door, Rua Direita, Monsaraz, Portugal', address: { village: 'Monsaraz', country: 'Portugal', country_code: 'pt' } }),
    );
    const old = at({ address: 'Rua Direita 3, Monsaraz, Évora, Portugal' });
    expect(needsDetails(old)).toBe(true);
    const full = await resolvePlaceDetails(old);
    expect(full).toEqual({ ...old, city: 'Monsaraz', country: 'Portugal', countryCode: 'PT' });
  });

  it('returns the same object when complete or when the lookup fails', async () => {
    const complete = at({ city: 'Kyoto', country: 'Japan', countryCode: 'JP' });
    expect(await resolvePlaceDetails(complete)).toBe(complete);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const bare = at({ lat: 12.3, lng: 45.6 });
    expect(await resolvePlaceDetails(bare)).toBe(bare);
  });
});

describe('mergePlaceDetails', () => {
  it('adds missing details from the same spot without overwriting', () => {
    const picked = at({ name: 'My spot' });
    const saved = at({ name: 'Other name', city: 'Kyoto', countryCode: 'JP' });
    expect(mergePlaceDetails(picked, saved)).toEqual(at({ name: 'My spot', city: 'Kyoto', countryCode: 'JP' }));
    expect(picked).toEqual(at({ name: 'My spot' })); // not mutated
  });

  it('leaves a different spot, or nothing new, alone', () => {
    const picked = at({ city: 'Kyoto' });
    expect(mergePlaceDetails(picked, { lat: 9, lng: 9, country: 'Japan' })).toBe(picked);
    expect(mergePlaceDetails(picked, at({ city: 'Osaka' }))).toBe(picked);
  });
});

describe('edge cases', () => {
  it('reads US state abbreviations at the end of an address as the US', () => {
    expect(placeCountryCode(at({ address: '1 Infinite Loop, Cupertino, CA 95014' }))).toBe('US');
    expect(placeCountryCode(at({ address: '10 Main St, Springfield, CA' }))).toBe('US');
    expect(placeCountryCode(at({ address: '100 Queen St W, Toronto, ON M5H 2N2' }))).toBe('CA');
  });

  it('falls back to the address when the lookup fails, and ignores junk codes', async () => {
    resetGeoState();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    try {
      const full = await resolvePlaceDetails(at({ lat: 40.1, lng: -3.2, countryCode: 'xx', address: 'Calle Mayor 5, Madrid' }));
      expect(full.countryCode).toBe('ES');
      expect(full.country).toBe('Spain');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stays quick on very long text', () => {
    const long = `${'Lorem, Ipsum, Dolor, '.repeat(3000)}in Kyoto`;
    const t = Date.now();
    extractLocationHints(long);
    guessCountry(long);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
