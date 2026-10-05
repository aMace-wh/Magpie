import { describe, expect, it } from 'vitest';
import type { Item } from './types';
import {
  analyzeSave,
  automaticTitle,
  isSocialSave,
  looksAutomatic,
  looksLikeAccount,
  mergeTags,
  reanalysisChanges,
  shouldLocate,
  storedPreview,
  wantsLookup,
  withoutDates,
  type SaveInput,
} from './understand';

// All examples are made up, in the formats Instagram's previews use.
const NOW = new Date(2026, 9, 5, 12);
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const REEL = 'https://www.instagram.com/reel/AbCdEf123/';
const POST = 'https://www.instagram.com/p/XyZ987abc/';

/** A save as older versions stored it: the account's name as title, the preview's description as is. */
function stored(title: string, description: string, extra: Partial<SaveInput> = {}) {
  const item: SaveInput = { url: REEL, title, type: 'video', sharedText: REEL, ...extra };
  return analyzeSave(item, storedPreview({ title, description }), NOW);
}

describe('analyzeSave: older Instagram saves', () => {
  it('titles from the caption, keeps the author and posting day, and drops the posting day as a date', () => {
    const a = stored(
      'Mei Chan (@mei.eats) • Instagram reel',
      '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Hidden noodle bar in Mong Kok 🍜 open till late 📍 Shop 5, Fa Yuen Street, Mong Kok #noodles”.',
      { when: { start: '2026-09-12' } },
    );
    expect(a.title).toBe('Hidden noodle bar in Mong Kok');
    expect(a.author).toBe('Mei Chan');
    expect(a.publishedAt).toBe('2026-09-12');
    expect(a.dropWhen).toBe(true);
    expect(a.when).toBeUndefined();
    expect(a.type).toBe('place');
    expect(a.candidates[0]).toMatchObject({ marked: true, countryCode: 'HK' });
    expect(a.tags).toContain('noodles');
  });

  it('reads Chinese captions: kind, place and a real date range, not opening hours or offers', () => {
    const a = stored(
      'Pop Corner (@popcorner.hk) • Instagram reel',
      '2,345 likes, 12 comments - popcorner.hk on September 20, 2026: “卡通主題快閃店登陸銅鑼灣！\n地址：香港銅鑼灣時代廣場地下\n日期：28/9-9/11\n開放時間：一至日 11:00-22:00\n10月1-3日期間訂購門票有85折優惠”.',
      { type: 'event', when: { start: '2026-09-20' } },
    );
    expect(a.type).toBe('event');
    expect(a.dropWhen).toBe(true);
    expect(a.when).toEqual(expect.objectContaining({ start: '2026-09-28', end: '2026-11-09' }));
    expect(a.candidates[0]).toMatchObject({ marked: true, countryCode: 'HK' });
  });

  it('gives an "event" filed only because of its posting date a second look', () => {
    const a = stored(
      'Hike Club (@hikeclub) • Instagram reel',
      '880 likes, 9 comments - hikeclub on August 2, 2026: “山頂日落超美 行山新手都啱 📍 Lion Rock, Hong Kong”.',
      { type: 'event', when: { start: '2026-08-02' } },
    );
    expect(a.dropWhen).toBe(true);
    expect(a.when).toBeUndefined();
    expect(a.type).toBe('place');
  });

  it('replaces a bare account name, but not a title the user typed', () => {
    const description = '410 likes, 2 comments - citybites_daily on July 1, 2026: “五款必試蛋撻 🥧 #蛋撻 #甜品”.';
    expect(stored('City Bites Daily', description, { url: POST, type: 'link' }).title).toBe('五款必試蛋撻');
    expect(stored('Tarts to try with Mum', description, { url: POST, type: 'link' }).title).toBeUndefined();
  });

  it('names a caption-less post after its author', () => {
    const a = stored('Mei Chan (@mei.eats) • Instagram reel', '5,400 likes, 210 comments - mei.eats on June 3, 2026');
    expect(a.title).toBe('Reel by Mei Chan');
    expect(a.caption).toBeUndefined();
  });

  it("never changes what looks chosen: a specific kind, a typed title, a date that isn't the posting day", () => {
    const a = stored(
      'Weeknight dumplings',
      '96 likes, 1 comment - homecook.amy on May 9, 2026: “Travel vlog: a day in Taipei 🇹🇼 night markets and temples”.',
      { type: 'recipe', when: { start: '2026-11-01' } },
    );
    expect(a.type).toBe('recipe');
    expect(a.title).toBeUndefined();
    expect(a.dropWhen).toBeUndefined();
    expect(a.when).toBeUndefined();
  });

  it("doesn't take an ordinary sentence for a post", () => {
    const a = analyzeSave({ title: 'Party', type: 'note', note: 'party on October 24, 2026: bring snacks', when: { start: '2026-10-24' } }, {}, NOW);
    expect(a.dropWhen).toBeUndefined();
    expect(a.publishedAt).toBeUndefined();
  });
});

describe('analyzeSave: posting dates', () => {
  const wrapper = (caption: string) => `12 likes, 1 comment - blueroom.bar on September 12, 2026: “${caption}”`;

  it("drops a date read from the post's own date line, told by the phrase it came from", () => {
    const a = stored('Blue Room (@blueroom.bar) • Instagram reel', wrapper('Vinyl night with friends'), {
      type: 'event',
      when: { start: '2026-09-12', source: 'September 12, 2026' },
    });
    expect(a.dropWhen).toBe(true);
  });

  it('keeps a date the caption gives for the day the post went up', () => {
    const day = new Date(2026, 8, 12, 9);
    const preview = storedPreview({ title: 'Blue Room (@blueroom.bar) • Instagram reel', description: wrapper('Tonight 9pm: DJ set, free entry') });
    // Read from the caption when the save was made…
    const kept = analyzeSave({ url: REEL, type: 'event', title: 'Instagram reel', when: { start: '2026-09-12T21:00', source: 'Tonight 9pm' } }, preview, day);
    expect(kept.dropWhen).toBeUndefined();
    // …or found now.
    const found = analyzeSave({ url: REEL, type: 'event', title: 'Instagram reel' }, preview, day);
    expect(found.when).toMatchObject({ start: '2026-09-12T21:00' });
  });

  it('keeps a date the user picked for that day, with a time and no phrase', () => {
    const a = stored('Gallery (@gallery.hk) • Instagram reel', wrapper('Opening night, come by!'), { type: 'event', when: { start: '2026-09-12T19:00' } });
    expect(a.dropWhen).toBeUndefined();
  });

  it("never takes another site's publishing date for a posting day", () => {
    const day = toDay(NOW);
    const a = analyzeSave(
      { url: 'https://venue.example.com/jazz', type: 'event', title: 'Jazz tonight', when: { start: `${day}T20:00`, source: 'tonight 8pm' } },
      { title: 'Live Jazz at the Blue Room', description: 'Live jazz every week in the back room.', publishedAt: `${day}T09:12:00.000Z` },
      NOW,
    );
    expect(a.publishedAt).toBeUndefined();
    expect(a.dropWhen).toBeUndefined();
  });

  it("doesn't read a news site's description as a post", () => {
    const a = analyzeSave(
      { url: 'https://news.example.com/a', type: 'article', title: 'Minister vows to fight on', when: { start: '2026-03-05', source: 'March 5, 2026' } },
      { title: 'Minister vows to fight on', description: 'Published March 5, 2026: “We will fight on,” said the minister at the summit.' },
      NOW,
    );
    expect(a).toMatchObject({ type: 'article' });
    expect(a.author).toBeUndefined();
    expect(a.title).toBeUndefined();
    expect(a.dropWhen).toBeUndefined();
  });
});

describe('analyzeSave: what the user set', () => {
  const description = '96 likes, 1 comment - homecook.amy on May 9, 2026: “Easy carbonara recipe 🍝 Ingredients: 200g spaghetti, 2 eggs, 50g parmesan. Method: boil, whisk, toss. Pop-up dinner Saturday 24 October 2026”.';

  it('suggests no change to a kind, date or title the user set', () => {
    const a = stored('Amy (@homecook.amy) • Instagram reel', description, { type: 'video', edited: ['type', 'when', 'title'] });
    expect(a.type).toBe('video');
    expect(a.when).toBeUndefined();
    expect(a.title).toBeUndefined();
    const free = stored('Amy (@homecook.amy) • Instagram reel', description, { type: 'video' });
    expect(free.type).toBe('recipe');
    expect(free.title).toBeDefined();
  });
});

describe('analyzeSave: fresh previews', () => {
  it('uses the caption and author a preview brings', () => {
    const caption = 'Hokkaido winter travel guide ❄️ 3-day itinerary: ski resorts, onsen hotels and where to eat crab';
    const a = analyzeSave(
      { url: REEL, title: 'Instagram reel', type: 'video', sharedText: REEL },
      { title: caption, rawTitle: caption, description: caption, caption, author: 'Snow Trips', publishedAt: '2026-01-10T00:00:00.000Z' },
      NOW,
    );
    expect(a.title).toBe('Hokkaido winter travel guide');
    expect(a.author).toBe('Snow Trips');
    expect(a.type).toBe('place');
    expect(a.candidates[0]).toMatchObject({ countryCode: 'JP', area: 'region' });
  });

  it('keeps a page title for ordinary links and only replaces an automatic one', () => {
    const preview = { title: 'Best pancakes in Brooklyn', description: 'A short guide.' };
    expect(analyzeSave({ url: 'https://example.com/a', title: '', type: 'link' }, preview, NOW).title).toBe('Best pancakes in Brooklyn');
    expect(analyzeSave({ url: 'https://example.com/a', title: 'My list', type: 'link' }, preview, NOW).title).toBeUndefined();
  });
});

describe('looksLikeAccount', () => {
  it('spots display names that match the handle', () => {
    expect(looksLikeAccount('City Bites Daily', undefined, 'citybites_daily')).toBe(true);
    expect(looksLikeAccount('WKD 週末去邊', undefined, 'weekendtrips_hk')).toBe(true);
    expect(looksLikeAccount('Mei Chan', 'Mei Chan')).toBe(true);
    expect(looksLikeAccount('@mei.eats', undefined, 'mei.eats')).toBe(true);
  });

  it('leaves real titles alone', () => {
    expect(looksLikeAccount('Tarts to try with Mum', undefined, 'citybites_daily')).toBe(false);
    expect(looksLikeAccount('Best bites in the city!', undefined, 'citybites_daily')).toBe(false);
    expect(looksLikeAccount('蛋撻', undefined, 'citybites_daily')).toBe(false);
    expect(looksLikeAccount('City Bites Daily')).toBe(false);
  });
});

describe('reanalysisChanges', () => {
  const base: Item = {
    id: 'a',
    type: 'video',
    title: 'Mei Chan (@mei.eats) • Instagram reel',
    url: REEL,
    description: '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Five-minute desk stretches 🧘 neck and shoulder mobility routine, 3 sets each #mobility”.',
    siteName: 'Instagram',
    tags: ['saved'],
    collectionIds: [],
    status: 'todo',
    when: { start: '2026-09-12' },
    createdAt: 1,
    updatedAt: 1,
  };

  it('cleans up an older save', () => {
    const changes = reanalysisChanges(base, analyzeSave(base, storedPreview(base), NOW));
    expect(changes).toMatchObject({ title: 'Five-minute desk stretches', type: 'workout', author: 'Mei Chan', description: 'Five-minute desk stretches 🧘 neck and shoulder mobility routine, 3 sets each #mobility' });
    expect('when' in changes && changes.when === undefined).toBe(true);
    expect(changes.tags).toEqual(expect.arrayContaining(['saved', 'mobility']));
  });

  it('drops a description that was only likes and a date', () => {
    const item = { ...base, description: '5,400 likes, 210 comments - mei.eats on June 3, 2026', when: undefined };
    const changes = reanalysisChanges(item, analyzeSave(item, storedPreview(item), NOW));
    expect('description' in changes && changes.description === undefined).toBe(true);
  });

  it('leaves alone what the user set', () => {
    const item: Item = { ...base, edited: ['title', 'type', 'when'] };
    const changes = reanalysisChanges(item, analyzeSave(item, storedPreview(item), NOW));
    expect(changes).toEqual({ author: 'Mei Chan', description: 'Five-minute desk stretches 🧘 neck and shoulder mobility routine, 3 sets each #mobility' });
  });

  it('adds tags only along with a better kind', () => {
    const item: Item = { ...base, type: 'recipe' };
    expect(reanalysisChanges(item, analyzeSave(item, storedPreview(item), NOW)).tags).toBeUndefined();
    const kept: Item = { ...base, edited: ['tags'] };
    const changes = reanalysisChanges(kept, analyzeSave(kept, storedPreview(kept), NOW));
    expect(changes.type).toBe('workout');
    expect(changes.tags).toBeUndefined();
  });

  it("leaves other sites' saves and notes as they are", () => {
    const event: Item = { ...base, url: 'https://example.com/jazz', title: 'Jazz night', type: 'event', when: undefined, description: 'Jazz night on Saturday 24 October 2026 at the club, doors 8pm' };
    const video: Item = { ...base, url: 'https://example.com/v/1', title: 'Easy carbonara recipe', when: undefined, description: 'Ingredients: 200g spaghetti, 2 eggs, 50g parmesan. Method: boil the pasta, whisk the eggs' };
    const note: Item = { ...base, url: undefined, title: 'Birthday dinner', type: 'note', when: undefined, description: undefined, note: '📍 Harbour Grill, Central, Hong Kong — book a table' };
    for (const item of [event, video, note]) {
      const a = analyzeSave(item, storedPreview(item), NOW);
      expect(reanalysisChanges(item, a)).toEqual({});
      expect(wantsLookup(item, a)).toBe(false);
    }
  });

  it('changes nothing the second time', () => {
    const once = { ...base, ...reanalysisChanges(base, analyzeSave(base, storedPreview(base), NOW)) };
    expect(reanalysisChanges(once, analyzeSave(once, storedPreview(once), NOW))).toEqual({});
  });
});

describe('looksAutomatic / automaticTitle', () => {
  const item = { url: REEL, title: 'City Bites Daily', description: '410 likes, 2 comments - citybites_daily on July 1, 2026: “五款必試蛋撻”' };

  it('trusts the wrapper on older social saves only', () => {
    expect(isSocialSave({ url: REEL })).toBe(true);
    expect(isSocialSave({ source: 'threads' })).toBe(true);
    expect(isSocialSave({ url: 'https://example.com/a' })).toBe(false);
    expect(looksAutomatic(item)).toBe(true);
    expect(looksAutomatic({ ...item, description: '五款必試蛋撻', title: '五款必試蛋撻' })).toBe(false);
    expect(looksAutomatic({ ...item, url: 'https://example.com/a' })).toBe(false);
    expect(automaticTitle(item)).toBe(true);
    expect(automaticTitle({ ...item, edited: ['title'] })).toBe(false);
    expect(automaticTitle({ ...item, analyzed: 1 })).toBe(false);
    expect(automaticTitle({ url: 'https://example.com/a', title: 'Instagram reel' })).toBe(true);
  });

  it('wants a lookup only for places nobody set or cleared', () => {
    const saved: Item = {
      id: 'p',
      type: 'video',
      title: 'Mei Chan (@mei.eats) • Instagram reel',
      url: REEL,
      description: '1 like - mei.eats on May 1, 2026: “Best egg tarts 🥧\n📍 Shop 3, Lyndhurst Terrace, Central, Hong Kong”',
      tags: [],
      collectionIds: [],
      status: 'todo',
      createdAt: 1,
      updatedAt: 1,
    };
    const a = analyzeSave(saved, storedPreview(saved), NOW);
    expect(wantsLookup(saved, a)).toBe(true);
    expect(wantsLookup({ ...saved, edited: ['place'] }, a)).toBe(false);
    expect(wantsLookup({ ...saved, place: { lat: 1, lng: 2 } }, a)).toBe(false);
  });
});

describe('helpers', () => {
  it('decides when a lookup is worth it', () => {
    const pinned = { query: 'Shop 5, Fa Yuen Street', countryCode: 'HK', marked: true };
    const city = { query: 'Osaka', countryCode: 'JP', marked: false, area: 'city' as const };
    const mall = { query: 'Siam Paragon', countryCode: 'TH', marked: false };
    expect(shouldLocate('recipe', [pinned])).toBe(true);
    expect(shouldLocate('video', [city])).toBe(false);
    expect(shouldLocate('place', [city])).toBe(true);
    expect(shouldLocate('product', [mall])).toBe(true);
    expect(shouldLocate('product', [city])).toBe(false);
    expect(shouldLocate('place', [{ query: 'Somewhere', marked: true }])).toBe(false);
    expect(shouldLocate('place', [])).toBe(false);
  });

  it('merges tags without repeats, up to six', () => {
    expect(mergeTags(['Food'], ['food', 'travel'])).toEqual(['food', 'travel']);
    expect(mergeTags([], ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(6);
  });

  it('blanks dates out of text', () => {
    expect(withoutDates('📍 Lisbon — Sat 24 Oct 2026', NOW).trim()).toBe('📍 Lisbon');
  });
});
