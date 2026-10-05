import { describe, expect, it } from 'vitest';
import {
  analyzeTitle,
  classify,
  cleanTitle,
  extractUrl,
  handedText,
  hashtags,
  isTrackingParam,
  itemFieldsFrom,
  normalizeTag,
  normalizeUrl,
  parsePlaceFromUrl,
  parseShared,
  sharedTextOf,
  sourceLabel,
  stripTracking,
  stripTrackingInText,
  titleFromUrl,
  youtubeId,
} from './classify';

describe('sourceLabel', () => {
  it('only looks up its own names, so prototype keys stay plain text', () => {
    expect(sourceLabel('youtube')).toBe('YouTube');
    expect(sourceLabel('somewhere')).toBe('somewhere');
    expect(sourceLabel(undefined)).toBeUndefined();
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(sourceLabel(key)).toBe(key);
  });
});

describe('stripTracking', () => {
  it('removes per-sharer tracking parameters and keeps everything else', () => {
    expect(stripTracking('https://www.instagram.com/reel/x/?igsh=abc')).toBe('https://www.instagram.com/reel/x/');
    expect(stripTracking('https://youtu.be/abc?si=XYZ&t=42')).toBe('https://youtu.be/abc?t=42');
    expect(stripTracking('https://www.tiktok.com/@a/video/1?_t=8x&_r=1&is_from_webapp=1&sender_device=pc')).toBe('https://www.tiktok.com/@a/video/1');
    expect(stripTracking('https://shop.example/p?id=5&utm_source=x&UTM_Medium=y')).toBe('https://shop.example/p?id=5');
    // No tracking: exactly as it was.
    expect(stripTracking('https://Example.com/a?b=1&c=%20')).toBe('https://Example.com/a?b=1&c=%20');
    expect(stripTracking('not a url ?si=1')).toBe('not a url ?si=1');
    expect(stripTracking('geo:1,2?si=3')).toBe('geo:1,2?si=3');
  });

  it('drops Instagram share tokens, keeping only which photo of a carousel', () => {
    expect(stripTracking('https://www.instagram.com/reel/AbC123/?stkn=Zm9vYmFy')).toBe('https://www.instagram.com/reel/AbC123/');
    expect(stripTracking('https://www.instagram.com/p/AbC123/?img_index=3&stkn=Zm9v&utm_source=ig_web_copy_link')).toBe(
      'https://www.instagram.com/p/AbC123/?img_index=3',
    );
    // Any other parameter on a post or reel is a per-share token too, even ones nobody has named yet.
    expect(stripTracking('https://instagram.com/someone/reel/AbC123/?abc=1&igsh=x')).toBe('https://instagram.com/someone/reel/AbC123/');
    expect(stripTracking('https://www.instagram.com/tv/AbC123?xyz=9')).toBe('https://www.instagram.com/tv/AbC123');
    // Nothing to strip: exactly as it was.
    expect(stripTracking('https://www.instagram.com/p/AbC123/?img_index=2')).toBe('https://www.instagram.com/p/AbC123/?img_index=2');
    // Profiles and other sites keep their parameters (only known tracking goes).
    expect(stripTracking('https://www.instagram.com/someone/?hl=en')).toBe('https://www.instagram.com/someone/?hl=en');
    expect(stripTracking('https://shop.example/p/AbC123/?abc=1&stkn=2')).toBe('https://shop.example/p/AbC123/?abc=1');
  });

  it('isTrackingParam matches what stripTracking drops', () => {
    const post = new URL('https://www.instagram.com/p/AbC123/');
    expect(isTrackingParam(post, 'stkn')).toBe(true);
    expect(isTrackingParam(post, 'anything')).toBe(true);
    expect(isTrackingParam(post, 'img_index')).toBe(false);
    expect(isTrackingParam(new URL('https://example.com/p/AbC123/'), 'anything')).toBe(false);
    expect(isTrackingParam(new URL('https://example.com/'), 'utm_source')).toBe(true);
  });

  it('cleans every link in a text, leaving trailing punctuation alone', () => {
    expect(stripTrackingInText('Look (https://a.example/x?fbclid=1), and https://b.example/?igshid=2!')).toBe(
      'Look (https://a.example/x), and https://b.example/!',
    );
    expect(stripTrackingInText('no links')).toBe('no links');
  });
});

describe('extractUrl / normalizeUrl', () => {
  it('finds a link inside shared text and trims trailing punctuation', () => {
    expect(extractUrl('Check out @chef’s video! https://vm.tiktok.com/ZMabc123/.')).toBe('https://vm.tiktok.com/ZMabc123/');
    expect(extractUrl('see www.example.com/foo)')).toBe('https://www.example.com/foo');
    expect(extractUrl('no links here')).toBeUndefined();
  });

  it('normalises bare domains and rejects junk', () => {
    expect(normalizeUrl('example.com/recipes')).toBe('https://example.com/recipes');
    expect(normalizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeUrl('just words')).toBeUndefined();
  });
});

describe('parseShared', () => {
  it('splits Google Maps style shares into title + url', () => {
    expect(parseShared({ text: 'Dishoom Covent Garden\nhttps://maps.app.goo.gl/abc123' })).toEqual({
      url: 'https://maps.app.goo.gl/abc123',
      title: 'Dishoom Covent Garden',
      note: undefined,
    });
  });

  it('keeps the provided title and puts extra text in the note', () => {
    const r = parseShared({ title: 'Best focaccia', text: 'So good #baking https://example.com/focaccia' });
    expect(r.title).toBe('Best focaccia');
    expect(r.url).toBe('https://example.com/focaccia');
    expect(r.note).toBe('So good #baking');
  });

  it('drops a title that is just the url', () => {
    const r = parseShared({ title: 'https://youtu.be/dQw4w9WgXcQ', url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(r.title).toBeUndefined();
  });
});

describe('classify', () => {
  it('recognises videos and their platform', () => {
    const r = classify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(r.type).toBe('video');
    expect(r.source).toBe('youtube');
    expect(r.title).toBe('YouTube video');
  });

  it('re-files a TikTok with a recipe into recipes, with tags', () => {
    const r = classify({
      text: 'Creamy 15 minute pasta recipe 🍝 #pasta #dinnerideas #fyp https://www.tiktok.com/@chef/video/123',
    });
    expect(r.type).toBe('recipe');
    expect(r.source).toBe('tiktok');
    expect(r.tags).toContain('pasta');
    expect(r.tags).toContain('dinnerideas');
    expect(r.tags).not.toContain('fyp');
    expect(r.tags).toContain('quick');
  });

  it('spots workouts', () => {
    const r = classify({ text: '20 min full body HIIT workout, no equipment https://www.instagram.com/reel/Cxyz/' });
    expect(r.type).toBe('workout');
    expect(r.tags).toContain('hiit');
  });

  it('spots places mentioned in social posts', () => {
    const r = classify({ text: 'The best hidden gem coffee shop in Lisbon ☕️ https://www.tiktok.com/@traveller/video/9' });
    expect(r.type).toBe('place');
    expect(r.tags).toContain('coffee');
  });

  it('uses domain knowledge', () => {
    expect(classify({ url: 'https://www.bbcgoodfood.com/recipes/easy-chicken-curry' }).type).toBe('recipe');
    expect(classify({ url: 'https://www.bbcgoodfood.com/recipes/easy-chicken-curry' }).title).toBe('Easy chicken curry');
    expect(classify({ url: 'https://www.amazon.co.uk/dp/B0ABC' }).type).toBe('product');
    expect(classify({ url: 'https://open.spotify.com/album/123' }).type).toBe('music');
    expect(classify({ url: 'https://www.goodreads.com/book/show/1-the-hobbit' }).type).toBe('book');
    expect(classify({ url: 'https://www.theguardian.com/food/2024/jan/01/some-article' }).type).toBe('article');
    expect(classify({ url: 'https://www.yelp.com/biz/some-diner' }).type).toBe('place');
  });

  it('does not override a domain-specific type with keywords', () => {
    expect(classify({ title: 'Recipe book', url: 'https://www.amazon.com/dp/123' }).type).toBe('product');
  });

  it('treats plain text as a note unless it clearly describes something', () => {
    expect(classify({ text: 'Call mum about Sunday' }).type).toBe('note');
    expect(classify({ text: 'Try that ramen restaurant near the station' }).type).toBe('place');
  });

  it('reads places and coordinates from map links', () => {
    const r = classify({
      url: 'https://www.google.com/maps/place/Dishoom+Covent+Garden/@51.5124,-0.1269,17z/data=!3d51.5125!4d-0.1270',
    });
    expect(r.type).toBe('place');
    expect(r.title).toBe('Dishoom Covent Garden');
    expect(r.place).toEqual({ lat: 51.5125, lng: -0.127 });
  });
});

describe('parsePlaceFromUrl', () => {
  it('handles Apple Maps, OSM and geo: URIs', () => {
    expect(parsePlaceFromUrl('https://maps.apple.com/?ll=48.8584,2.2945&q=Eiffel%20Tower')).toEqual({
      place: { lat: 48.8584, lng: 2.2945 },
      name: 'Eiffel Tower',
    });
    expect(parsePlaceFromUrl('https://www.openstreetmap.org/#map=16/51.5007/-0.1246').place).toEqual({ lat: 51.5007, lng: -0.1246 });
    expect(parsePlaceFromUrl('geo:37.786971,-122.399677?q=37.786971,-122.399677(Moscone)')).toEqual({
      place: { lat: 37.786971, lng: -122.399677 },
      name: 'Moscone',
    });
  });

  it('rejects out of range coordinates', () => {
    expect(parsePlaceFromUrl('https://maps.google.com/?q=123.4,500').place).toBeUndefined();
  });
});

describe('helpers', () => {
  it('youtubeId', () => {
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://www.youtube.com/shorts/abcDEF12345')).toBe('abcDEF12345');
    expect(youtubeId('https://m.youtube.com/watch?v=xyz789abc')).toBe('xyz789abc');
    expect(youtubeId('https://example.com')).toBeUndefined();
  });

  it('normalizeTag and hashtags', () => {
    expect(normalizeTag('  #Air Fryer! ')).toBe('air-fryer');
    expect(hashtags('yum #Pasta #fyp #café')).toEqual(['pasta', 'café']);
  });

  it('titleFromUrl falls back to the host', () => {
    expect(titleFromUrl('https://example.com/p/12345')).toBe('example.com');
    expect(titleFromUrl('https://blog.example.com/2024/05/my-great-trip-to-rome.html')).toBe('My great trip to rome');
  });
});

// ---------------------------------------------------------------------------
// Identifying what is being saved

describe('events', () => {
  it('knows event and ticketing sites', () => {
    const r = classify({ url: 'https://www.eventbrite.co.uk/e/jazz-night-at-the-vortex-tickets-1234567890' });
    expect(r.type).toBe('event');
    expect(r.source).toBe('eventbrite');
    expect(r.title).toBe('Jazz night at the vortex');
    expect(r.confidence).toBe('high');
    expect(r.reasons[0]).toBe('Eventbrite is an events site');

    const urls = [
      'https://www.ticketmaster.co.uk/event/123',
      'https://dice.fm/event/abc-some-gig',
      'https://link.dice.fm/xyz',
      'https://ra.co/events/1234567',
      'https://www.residentadvisor.net/events/123',
      'https://www.meetup.com/london-hikers/events/123/',
      'https://lu.ma/abc123',
      'https://luma.com/abc123',
      'https://partiful.com/e/abc',
      'https://www.songkick.com/concerts/123-band',
      'https://www.bandsintown.com/e/123',
      'https://feverup.com/m/123',
      'https://www.eventim.de/event/abc',
      'https://allevents.in/london/party/123',
      'https://www.livenation.co.uk/show/123',
      'https://www.seetickets.com/event/abc',
      'https://www.skiddle.com/whats-on/abc',
      'https://www.universe.com/events/abc',
      'https://www.axs.com/events/123',
      'https://www.designmynight.com/london/whats-on/abc',
      'https://www.headout.com/abc',
      'https://www.tickettailor.com/events/abc',
      'https://events.humanitix.com/abc',
      'https://www.klook.com/activity/123-abc/',
      'https://calendar.google.com/calendar/event?eid=abc',
      'https://example.com/invite/party.ics',
    ];
    for (const url of urls) expect(classify({ url }).type, url).toBe('event');
  });

  it('separates Facebook events and Airbnb Experiences from the rest of the site', () => {
    const fb = classify({ url: 'https://www.facebook.com/events/123456789/' });
    expect(fb.type).toBe('event');
    expect(fb.source).toBe('facebook');
    expect(fb.title).toBe('Facebook event');
    expect(fb.reasons).toEqual(['Facebook event']);
    expect(classify({ url: 'https://www.facebook.com/somepage/posts/123' }).type).toBe('link');
    expect(classify({ url: 'https://fb.watch/abc/' }).type).toBe('video');

    const exp = classify({ url: 'https://www.airbnb.co.uk/experiences/123456' });
    expect(exp.type).toBe('event');
    expect(exp.title).toBe('Airbnb Experience');
    expect(classify({ url: 'https://www.airbnb.com/rooms/123' }).type).toBe('place');
  });

  it('re-files social posts about gigs and festivals as events', () => {
    const r = classify({ text: 'Festival lineup announced! Tickets on sale Fri 12 Oct https://www.tiktok.com/@fest/video/1' });
    expect(r.type).toBe('event');
    expect(r.source).toBe('tiktok');
    expect(r.tags).toContain('festival');
    expect(r.reasons).toContain('has a date: Fri 12 Oct');
    expect(r.alternatives[0]).toBe('video');
    expect(r.confidence).toBe('high');

    const gig = classify({ text: "Jazz night at Ronnie Scott's this Friday 9pm" });
    expect(gig.type).toBe('event');
    expect(gig.tags).toContain('live-music');
  });

  it('lets a date tip a venue into an event', () => {
    const market = classify({ text: 'Night market this weekend in Shoreditch 🌮 https://www.instagram.com/p/abc/' });
    expect(market.type).toBe('event');
    expect(market.tags).toContain('market');
    expect(market.reasons[0]).toBe('has a date: this weekend');

    const show = classify({ text: 'New exhibition at the Tate Modern this Saturday' });
    expect(show.type).toBe('event');
    expect(show.alternatives).toContain('place');
    expect(show.reasons).toContain('mentions exhibition');

    // Without a date it's somewhere to go.
    expect(classify({ text: 'New exhibition at the Tate Modern' }).type).toBe('note');
    expect(classify({ text: 'The best museums in Paris' }).type).toBe('place');
  });

  it('keeps strong place lists as places, offering event as a second guess', () => {
    const r = classify({ text: 'Best cocktail bars in London - perfect for this weekend' });
    expect(r.type).toBe('place');
    expect(r.alternatives[0]).toBe('event');
  });

  it('does not invent events', () => {
    const pasta = classify({ text: '15 minute pasta' });
    expect(pasta.type).toBe('recipe');
    expect(pasta.alternatives).not.toContain('event');

    const run = classify({ text: '5k run' });
    expect(run.type).not.toBe('event');
    expect(run.alternatives).not.toContain('event');

    expect(classify({ text: 'Easy dinner for tonight: creamy pasta https://www.tiktok.com/@a/video/2' }).type).toBe('recipe');
    expect(classify({ text: 'Borough Market — Saturday food market' }).type).not.toBe('event');
    expect(classify({ text: 'Best brunch spots in London, open Saturday 10am' }).type).toBe('place');
    expect(classify({ text: 'You may 2x the recipe, bake 20 mins' }).type).toBe('recipe');
    expect(classify({ text: 'Gift ideas for Sam\nCeramics class voucher, the green Moleskine' }).type).toBe('product');
    expect(classify({ text: 'Call mum about Sunday' }).alternatives).toEqual([]);
  });
});

describe('clean titles', () => {
  it('strips hashtags from the title but keeps them as tags', () => {
    const r = classify({ text: 'Creamy 15 minute pasta recipe 🍝 #pasta #dinnerideas #fyp https://www.tiktok.com/@chef/video/123' });
    expect(r.title).toBe('Creamy 15 minute pasta recipe 🍝');
    expect(r.tags).toEqual(expect.arrayContaining(['pasta', 'dinnerideas']));
  });

  it('turns share-sheet boilerplate into a useful title', () => {
    const tiktok = classify({ text: 'Check out @chef’s video! #TikTok https://vm.tiktok.com/ZMabc123/' });
    expect(tiktok.title).toBe('TikTok by @chef');
    expect(tiktok.author).toBe('@chef');

    const reel = classify({ text: 'Watch this reel by @x on Instagram https://www.instagram.com/reel/Cxyz/' });
    expect(reel.title).toBe('Instagram reel by @x');
    expect(reel.type).toBe('video');

    const caption = classify({ text: 'Watch this reel by @x on Instagram\nCreamy pasta in 15 minutes\nhttps://www.instagram.com/reel/Cxyz/' });
    expect(caption.title).toBe('Creamy pasta in 15 minutes');
    expect(caption.note).toBeUndefined();
    expect(caption.type).toBe('recipe');
  });

  it('drops platform trailers from titles', () => {
    expect(classify({ title: 'Never Gonna Give You Up - YouTube', url: 'https://youtu.be/dQw4w9WgXcQ' }).title).toBe('Never Gonna Give You Up');
    expect(classify({ title: 'Creamy pasta | TikTok', url: 'https://www.tiktok.com/@a/video/1' }).title).toBe('Creamy pasta');
    const profile = classify({ title: 'Dishoom (@dishoom) • Instagram photos and videos', url: 'https://www.instagram.com/dishoom/' });
    expect(profile.title).toBe('Dishoom');
    expect(profile.author).toBe('@dishoom');
  });

  it('keeps a long first line in the note when the title had to be shortened', () => {
    const line = `Wait for it… ${'this is the best street food tour in Bangkok, '.repeat(3)}`.trim();
    const r = classify({ text: `${line}\nhttps://www.tiktok.com/@a/video/1` });
    expect(r.title.endsWith('…')).toBe(true);
    expect(r.note).toBe(line);
    const short = classify({ text: 'Wait for it…\nhttps://www.tiktok.com/@a/video/1' });
    expect(short.title).toBe('Wait for it…');
    expect(short.note).toBeUndefined();
  });

  it('removes boilerplate-only lines from the note', () => {
    const r = classify({ text: 'Dishoom Covent Garden\n12 Upper St Martin’s Ln, London\nShared via Google Maps\nhttps://maps.app.goo.gl/abc123' });
    expect(r.title).toBe('Dishoom Covent Garden');
    expect(r.note).toBe('12 Upper St Martin’s Ln, London');
    expect(r.type).toBe('place');
  });

  it('caps long titles at a word boundary', () => {
    const long = `${'Slow roasted tomato and garlic '.repeat(6)}pasta`;
    const r = classify({ text: `${long}\nhttps://example.com/p/1` });
    expect(Array.from(r.title).length).toBeLessThanOrEqual(100);
    expect(r.title.endsWith('…')).toBe(true);
    expect(r.title).not.toMatch(/\s…$/);
    expect(long.startsWith(r.title.slice(0, -1))).toBe(true);
  });

  it('never returns an empty title', () => {
    expect(classify({ text: '#pasta #fyp https://www.tiktok.com/@chef/video/1' }).title).toBe('TikTok by @chef');
    expect(classify({ text: '#fyp' }).title).toBe('#fyp');
    expect(classify({ title: 'Just a moment...', url: 'https://example.com/p/12345' }).title).toBe('example.com');
    expect(classify({ url: 'https://open.spotify.com/track/abc' }).title).toBe('Spotify track');
    expect(classify({ url: 'https://maps.app.goo.gl/abc' }).title).toBe('Place on Google Maps');
    expect(classify({ url: 'geo:37.78,-122.39' }).title).toBe('Dropped pin');
  });

  it('reads RedNote and Douyin share texts', () => {
    const rn = classify({
      text: '【Lisbon hidden gems 🇵🇹 - Anna | 小红书 - 你的生活指南】 😆 abc123XYZ 😆 https://www.xiaohongshu.com/discovery/item/64f0?xsec=1',
    });
    expect(rn.title).toBe('Lisbon hidden gems 🇵🇹');
    expect(rn.source).toBe('rednote');
    expect(rn.type).toBe('place');

    const short = classify({
      text: '82 小红书用户发布了一篇小红书笔记，快来看吧！ 😆 Ab12Cd 😆 http://xhslink.com/a/xyz，复制本条信息，打开【小红书】App查看精彩内容！',
    });
    expect(short.url).toBe('http://xhslink.com/a/xyz');
    expect(short.title).toBe('RedNote post');

    const dy = classify({ text: '7.43 复制打开抖音，看看【小厨的作品】番茄炒蛋 https://v.douyin.com/iRNBho6u/ 复制此链接，打开Dou音搜索，直接观看视频！' });
    expect(dy.source).toBe('douyin');
    expect(dy.type).toBe('video');
    expect(dy.title).toBe('番茄炒蛋');
    expect(dy.author).toBe('小厨');
  });
});

describe('cleanTitle', () => {
  it('handles common page titles', () => {
    expect(cleanTitle('Rick Astley - Never Gonna Give You Up (Official Music Video) - YouTube')).toBe(
      'Rick Astley - Never Gonna Give You Up (Official Music Video)',
    );
    expect(cleanTitle('Creamy pasta 🍝 #pasta #fyp | TikTok')).toBe('Creamy pasta 🍝');
    expect(cleanTitle('Magpie - Wikipedia')).toBe('Magpie');
    expect(cleanTitle('Jazz Night Tickets, Sat 12 Oct 2026 at 19:30 | Eventbrite')).toBe('Jazz Night, Sat 12 Oct 2026 at 19:30');
    expect(cleanTitle('1,234 likes, 56 comments - dishoom on January 1, 2024: "Black daal forever"')).toBe('Black daal forever');
    expect(cleanTitle('Jane on X: "Best ramen in town" / X')).toBe('Best ramen in town');
    expect(cleanTitle('TikTok video from Chef (@chef): "Creamy pasta #pasta". original sound - chef.')).toBe('Creamy pasta');
    expect(cleanTitle('Watch "Lemon orzo" on YouTube')).toBe('Lemon orzo');
    expect(cleanTitle('Hades on Steam')).toBe('Hades');
    expect(cleanTitle('Best lasagna : r/Cooking')).toBe('Best lasagna');
  });

  it('treats login walls and bare site names as empty', () => {
    expect(cleanTitle('Just a moment...')).toBe('');
    expect(cleanTitle('Instagram')).toBe('');
    expect(cleanTitle('TikTok - Make Your Day')).toBe('');
    expect(cleanTitle('Sent from my iPhone')).toBe('');
    expect(cleanTitle('Instagram', { strict: false })).toBe('Instagram');
    expect(cleanTitle(undefined)).toBe('');
  });

  it('keeps meaningful hashtags and mentions readable', () => {
    expect(cleanTitle('Best #pasta in town')).toBe('Best pasta in town');
    expect(cleanTitle('Pasta night #pasta #dinner with friends')).toBe('Pasta night with friends');
    expect(cleanTitle('The #1 pizza in NYC')).toBe('The #1 pizza in NYC');
    expect(cleanTitle('Great dinner with @a @b @c')).toBe('Great dinner');
    expect(cleanTitle('Dinner at @dishoom')).toBe('Dinner at @dishoom');
    expect(cleanTitle('Stand by')).toBe('Stand by');
    expect(cleanTitle("Check out Jamie's video on pasta carbonara")).toBe("Check out Jamie's video on pasta carbonara");
    expect(cleanTitle('Check out this video by Jamie Oliver on how to cook pasta')).toBe('Check out this video by Jamie Oliver on how to cook pasta');
    expect(analyzeTitle('Check out this video by Jamie Oliver!')).toEqual({ title: '', author: 'Jamie Oliver' });
    expect(cleanTitle('Buy Tickets')).toBe('Buy Tickets');
    expect(analyzeTitle('@chef Creamy pasta')).toEqual({ title: 'Creamy pasta', author: '@chef' });
  });

  it('respects a custom max length', () => {
    expect(cleanTitle('one two three four five six', { max: 12 })).toBe('one two…');
  });
});

describe('reasons, confidence and alternatives', () => {
  it('explains domain decisions', () => {
    const r = classify({ url: 'https://www.bbcgoodfood.com/recipes/easy-chicken-curry' });
    expect(r.reasons[0]).toBe('bbcgoodfood.com is a recipe site');
    expect(r.confidence).toBe('high');
    expect(r.alternatives).toEqual([]);
  });

  it('explains keyword decisions with words and hashtags', () => {
    const r = classify({ text: 'Creamy 15 minute pasta recipe 🍝 #pasta #dinnerideas #fyp https://www.tiktok.com/@chef/video/123' });
    expect(r.reasons[0]).toMatch(/^mentions recipe/);
    expect(r.reasons).toContain('#pasta #dinnerideas');
    expect(r.confidence).toBe('high');
    expect(r.alternatives).toEqual(['video']);

    const bake = classify({ text: 'Preheat the oven, then add the ingredients' });
    expect(bake.type).toBe('recipe');
    expect(bake.reasons[0]).toBe('mentions preheat, oven');
  });

  it('explains map links', () => {
    const r = classify({ url: 'https://www.google.de/maps/place/Brandenburger+Tor/@52.5163,13.3777,17z' });
    expect(r.type).toBe('place');
    expect(r.title).toBe('Brandenburger Tor');
    expect(r.reasons).toEqual(['Google Maps link', 'has map coordinates']);
    expect(r.confidence).toBe('high');
    expect(classify({ url: 'geo:37.786971,-122.399677' }).reasons).toEqual(['map coordinates']);
  });

  it('is honest when unsure', () => {
    const r = classify({ url: 'https://example.com/p/12345' });
    expect(r.type).toBe('link');
    expect(r.confidence).toBe('low');
    expect(r.reasons).toEqual([]);

    const note = classify({ text: 'Call mum about Sunday' });
    expect(note.reasons).toEqual(['just text, no link']);
    expect(note.confidence).toBe('medium');

    const run = classify({ text: '5k run' });
    expect(run.type).toBe('note');
    expect(run.confidence).toBe('low');
    expect(run.alternatives).toEqual(['workout']);

    expect(classify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }).confidence).toBe('medium');
  });

  it('lists plausible alternatives, best first, without the chosen type', () => {
    const r = classify({ title: 'Recipe book', url: 'https://www.amazon.com/dp/123' });
    expect(r.type).toBe('product');
    expect(r.alternatives).toEqual(expect.arrayContaining(['book', 'recipe']));
    expect(r.alternatives).not.toContain('product');

    const busy = classify({ text: 'Recipe book haul: novels, cookbooks, a yoga workout playlist and a festival ticket' });
    expect(busy.alternatives.length).toBeLessThanOrEqual(3);
    expect(busy.alternatives).not.toContain(busy.type);
    expect(new Set(busy.alternatives).size).toBe(busy.alternatives.length);
  });
});

describe('sharedText', () => {
  it('keeps exactly what was shared', () => {
    const text = 'Creamy pasta 🍝  #pasta\nso good https://www.tiktok.com/@chef/video/1';
    expect(classify({ text }).sharedText).toBe(text);
    expect(classify({ title: 'Best focaccia', text: 'So good https://example.com/f' }).sharedText).toBe('Best focaccia\nSo good https://example.com/f');
    expect(sharedTextOf({ title: 'Dishoom', url: 'https://maps.app.goo.gl/abc' })).toBe('Dishoom\nhttps://maps.app.goo.gl/abc');
  });

  it('skips repeats and empty input', () => {
    expect(sharedTextOf({ title: 'Pasta', text: 'Pasta https://example.com/p', url: 'https://example.com/p' })).toBe('Pasta https://example.com/p');
    expect(sharedTextOf({ title: '  ', text: '' })).toBeUndefined();
    expect(classify({ text: '   ' }).sharedText).toBeUndefined();
  });

  it('itemFieldsFrom leaves out the explanation', () => {
    const c = classify({ text: 'Creamy pasta recipe #pasta https://www.tiktok.com/@chef/video/1' });
    const fields = itemFieldsFrom(c);
    expect(fields).toEqual({
      type: 'recipe',
      title: 'Creamy pasta recipe',
      url: 'https://www.tiktok.com/@chef/video/1',
      source: 'tiktok',
      note: undefined,
      tags: c.tags,
      place: undefined,
      sharedText: 'Creamy pasta recipe #pasta https://www.tiktok.com/@chef/video/1',
    });
    expect(fields).not.toHaveProperty('reasons');
  });
});

describe('more sources', () => {
  it('labels social platforms', () => {
    const cases: [string, string, string][] = [
      ['https://bsky.app/profile/alice.bsky.social/post/3kxyz', 'bluesky', 'Bluesky'],
      ['https://www.linkedin.com/posts/jane-doe_activity-123', 'linkedin', 'LinkedIn'],
      ['https://lnkd.in/abc', 'linkedin', 'LinkedIn'],
      ['https://www.xiaohongshu.com/explore/64f0', 'rednote', 'RedNote'],
      ['http://xhslink.com/a/xyz', 'rednote', 'RedNote'],
      ['https://www.lemon8-app.com/@anna/123', 'lemon8', 'Lemon8'],
      ['https://www.snapchat.com/add/someone', 'snapchat', 'Snapchat'],
      ['https://www.threads.net/@someone/post/abc', 'threads', 'Threads'],
    ];
    for (const [url, source, label] of cases) {
      const r = classify({ url });
      expect(r.source, url).toBe(source);
      expect(r.type, url).toBe('link');
      expect(sourceLabel(r.source)).toBe(label);
    }
    expect(classify({ url: 'https://bsky.app/profile/alice.bsky.social/post/3kxyz' }).title).toBe('Bluesky post by @alice.bsky.social');
    expect(classify({ url: 'https://x.com/someone/status/12345' }).title).toBe('X post by @someone');
  });

  it('knows more video sites', () => {
    expect(classify({ url: 'https://v.douyin.com/iRNBho6u/' }).type).toBe('video');
    expect(classify({ url: 'https://www.snapchat.com/spotlight/W7abc' }).type).toBe('video');
    expect(classify({ url: 'https://kick.com/somestreamer' }).source).toBe('kick');
    expect(classify({ url: 'https://www.instagram.com/chef/reel/Cxyz/' }).type).toBe('video');
    const lb = classify({ url: 'https://letterboxd.com/film/past-lives/' });
    expect([lb.type, lb.source, lb.title]).toEqual(['video', 'letterboxd', 'Past lives']);
    expect(classify({ url: 'https://www.imdb.com/title/tt1234567/' }).source).toBe('imdb');
    expect(classify({ url: 'https://music.youtube.com/watch?v=abc' }).type).toBe('music');
  });

  it('files podcasts under music and says so', () => {
    const apple = classify({ url: 'https://podcasts.apple.com/gb/podcast/the-daily/id1200361736' });
    expect(apple.type).toBe('music');
    expect(apple.reasons[0]).toBe('Podcast');
    expect(apple.tags).toContain('podcast');
    const ep = classify({ url: 'https://open.spotify.com/episode/abc' });
    expect([ep.type, ep.source, ep.title]).toEqual(['music', 'spotify', 'Spotify episode']);
    expect(ep.reasons[0]).toBe('Podcast on Spotify');
    expect(classify({ url: 'https://open.spotify.com/show/abc' }).reasons[0]).toBe('Podcast on Spotify');
  });

  it('knows articles, games, shops and map links', () => {
    const sub = classify({ url: 'https://someone.substack.com/p/why-we-cook' });
    expect([sub.type, sub.source]).toEqual(['article', 'substack']);
    const steam = classify({ url: 'https://store.steampowered.com/app/1145360/Hades/' });
    expect([steam.type, steam.source, steam.title]).toEqual(['product', 'steam', 'Game on Steam']);
    expect(classify({ url: 'https://www.amazon.fr/dp/B0ABC' }).type).toBe('product');
    expect(classify({ url: 'https://www.yelp.ca/biz/some-diner' }).type).toBe('place');
    expect(classify({ url: 'https://www.openrice.com/en/hongkong/r-some-cafe-r123' }).type).toBe('place');
    for (const url of ['https://maps.app.goo.gl/abc', 'https://goo.gl/maps/abc', 'https://www.google.com.au/maps/place/Opera+House', 'https://maps.apple.com/?q=Cafe']) {
      expect(classify({ url }).type, url).toBe('place');
    }
    expect(classify({ url: 'https://goo.gl/maps/abc' }).source).toBe('google-maps');
    expect(classify({ url: 'https://maps.apple.com/?q=Cafe' }).source).toBe('apple-maps');
  });

  it('stops links at full-width punctuation and ignores ranking hashtags', () => {
    expect(extractUrl('看这个 http://xhslink.com/a/xyz，复制本条信息')).toBe('http://xhslink.com/a/xyz');
    expect(hashtags('The #1 spot 🍝#pasta ＃ramen')).toEqual(['pasta', 'ramen']);
  });
});

// ---------------------------------------------------------------------------
// Regressions from review

describe('videos about events', () => {
  it('keeps gig, festival, workshop and talk videos as videos, offering event', () => {
    const videos = [
      { title: 'Coldplay - Fix You (Live at Glastonbury 2016) - YouTube', url: 'https://www.youtube.com/watch?v=abc' },
      { title: 'Tiny Desk Concert: Mac Miller', url: 'https://www.youtube.com/watch?v=abc' },
      { title: 'Pottery workshop at home: beginner tutorial', url: 'https://youtu.be/abc' },
      { title: 'TED conference talk: how to learn', url: 'https://youtu.be/abc' },
      { text: 'Glastonbury festival 2024 highlights https://youtu.be/abc' },
      { text: 'POV: you went to the Eras Tour concert #concert https://www.tiktok.com/@a/video/1' },
      { text: 'Taylor Swift The Eras Tour concert film https://www.netflix.com/title/1' },
      { title: 'Coldplay live at Wembley 12 June 2025 full concert', url: 'https://youtu.be/abc' },
      { text: 'How to get Glastonbury tickets https://www.tiktok.com/@a/video/1' },
    ];
    for (const input of videos) {
      const r = classify(input);
      const label = input.title ?? input.text;
      expect(r.type, label).toBe('video');
      expect(r.alternatives, label).toContain('event');
      expect(r.confidence, label).toBe('medium');
    }
  });

  it('still files a video as an event when it has a date or a way to book', () => {
    const tonight = classify({ text: 'Jazz concert tonight 9pm https://www.tiktok.com/@club/video/1' });
    expect(tonight.type).toBe('event');
    expect(tonight.reasons[0]).toBe('has a date: tonight');
    expect(tonight.alternatives[0]).toBe('video');
    expect(classify({ title: 'Glastonbury 2025 tickets on sale Thursday 6pm', url: 'https://youtu.be/abc' }).type).toBe('event');
    expect(classify({ text: 'Pottery workshop this Saturday https://www.instagram.com/reel/Cabc/' }).type).toBe('event');
  });

  it('does not treat recaps and tutorials as events on posts and notes either', () => {
    const post = classify({ text: 'Glastonbury festival 2024 highlights https://www.instagram.com/p/abc/' });
    expect(post.type).toBe('link');
    expect(post.alternatives).toEqual(['event']);
    const note = classify({ text: 'Pottery workshop tutorial' });
    expect(note.type).toBe('note');
    expect(note.alternatives).toEqual(['event']);
    expect(classify({ text: 'Pottery workshop' }).type).toBe('event');
  });
});

describe('typed text (no link)', () => {
  it('keeps the words as typed: no site, @mention or "Tickets" stripping', () => {
    const typed = [
      'Cook steak - medium',
      'Birthday dinner with @amy @ben @cal at 7pm',
      'Buy Glastonbury Tickets',
      'Grocery list: eggs, milk | Etsy',
      'Things to pack: tent / X',
      '@chef Creamy pasta',
    ];
    for (const text of typed) {
      const r = classify({ text });
      expect(r.title, text).toBe(text);
      expect(r.note, text).toBeUndefined();
    }
    expect(classify({ title: 'Cook steak - medium' }).title).toBe('Cook steak - medium');
  });

  it('still tidies hashtags into tags, without losing any', () => {
    const work = classify({ text: 'Meeting notes #work' });
    expect([work.title, work.note, work.tags]).toEqual(['Meeting notes', undefined, ['work']]);
    const pasta = classify({ text: 'Pasta night #pasta #dinner with friends' });
    expect([pasta.title, pasta.note]).toEqual(['Pasta night with friends', undefined]);
    // Single-letter hashtags don't become tags, so the line stays in the note.
    const many = classify({ text: 'Meeting notes #a #b #c' });
    expect([many.title, many.note]).toEqual(['Meeting notes', 'Meeting notes #a #b #c']);
    expect(classify({ text: 'Book club #3' }).title).toBe('Book club #3');
  });

  it('picks the first line with words and keeps the rest of the note', () => {
    const r = classify({ text: '#pasta #dinner\nBuy tomatoes' });
    expect([r.title, r.note]).toEqual(['Buy tomatoes', '#pasta #dinner']);
    expect(classify({ text: 'Steak doneness\n• rare\n• Medium' }).note).toBe('• rare\n• Medium');
    expect(classify({ text: 'Buy milk\nSent from my iPhone' })).toMatchObject({ title: 'Buy milk', note: undefined });
    expect(classify({ text: 'Sent from my iPhone' }).title).toBe('Sent from my iPhone');
  });

  it('keeps a shortened first line in the note, typed or shared', () => {
    const line = 'This typed first line is quite long and goes on and on about a trip to Lisbon with friends and family in May ok';
    const typed = classify({ text: line });
    expect(typed.title.endsWith('…')).toBe(true);
    expect(typed.note).toBe(line);
    const shared = classify({ title: line, url: 'https://example.com/p/1' });
    expect(shared.title.endsWith('…')).toBe(true);
    expect(shared.note).toBe(line);
  });
});

describe('ticket titles', () => {
  it('only drops "Tickets" from ticket-site titles', () => {
    expect(cleanTitle('Jazz Night Tickets | Eventbrite')).toBe('Jazz Night');
    expect(cleanTitle('Taylor Swift Tickets | Ticketmaster')).toBe('Taylor Swift');
    expect(cleanTitle('Glastonbury Tickets, 25 June')).toBe('Glastonbury, 25 June');
    expect(cleanTitle('Buy Glastonbury Tickets')).toBe('Buy Glastonbury Tickets');
    expect(cleanTitle('Get your tickets, Sat 12 Oct')).toBe('Get your tickets, Sat 12 Oct');
    expect(cleanTitle('Buy Tickets | Eventbrite')).toBe('Buy Tickets');
    expect(cleanTitle('Top pizza #1')).toBe('Top pizza #1');
  });
});

describe('default titles', () => {
  it('skips locale folders in links', () => {
    expect(classify({ url: 'https://open.spotify.com/intl-de/episode/abc' }).title).toBe('Spotify episode');
    expect(classify({ url: 'https://open.spotify.com/intl-pt-BR/track/abc' }).title).toBe('Spotify track');
    expect(classify({ url: 'https://open.spotify.com/constructor/abc' }).title).toBe('Spotify');
    expect(titleFromUrl('https://www.example.com/en-gb/')).toBe('example.com');
    expect(titleFromUrl('https://www.example.com/en-gb/summer-sale')).toBe('Summer sale');
  });

  it('names TikTok photo posts, films and IMDb pages properly', () => {
    expect(classify({ url: 'https://www.tiktok.com/@a/photo/1' }).title).toBe('TikTok photo post');
    expect(classify({ url: 'https://www.tiktok.com/@anna/photo/1' }).title).toBe('TikTok photo post by @anna');
    expect(classify({ url: 'https://letterboxd.com/film/dune/' }).title).toBe('Dune');
    expect(classify({ url: 'https://letterboxd.com/film/dune-part-two/' }).title).toBe('Dune part two');
    expect(classify({ url: 'https://letterboxd.com/anna/film/dune-2021/' }).title).toBe('Dune');
    expect(classify({ url: 'https://boxd.it/abc' }).title).toBe('Film on Letterboxd');
    expect(classify({ url: 'https://www.imdb.com/title/tt1234567/' }).title).toBe('IMDb title');
  });
});

describe('reason wording', () => {
  it('does not repeat overlapping matches or lead with weak words', () => {
    expect(classify({ text: 'Best cafe in Soho' }).reasons).toEqual(['mentions cafe', 'reads like a “best … in” list']);
    expect(classify({ text: 'Best pasta in Rome' }).reasons).toEqual(['reads like a “best … in” list']);
    expect(classify({ text: '15 minute pasta #pasta' }).reasons).toEqual(['#pasta']);
    expect(classify({ text: '15 minute pasta' }).reasons).toEqual(['mentions pasta']);
    expect(classify({ text: 'Film festival this weekend in Soho' }).reasons).toContain('mentions film festival');
    // A weak word is still shown when it's the only one.
    expect(classify({ text: 'Party tonight' })).toMatchObject({ type: 'event', reasons: ['has a date: tonight', 'mentions party'] });
  });
});

describe('handedText', () => {
  it('keeps only what other apps handed over, never words typed in the box', () => {
    const url = 'https://www.amazon.co.uk/dp/B0TEST';
    // Typed around a pasted link: only the link is the "original".
    expect(handedText(`Lego set\nfor Anna's birthday, don't tell her\n${url}`, [url])).toBe(url);
    // Typed entirely: nothing.
    expect(handedText('Jazz night this Saturday 8pm', [])).toBeUndefined();
    // A caption pasted, then a note typed after it.
    const caption = 'Creamy garlic pasta 🍝 #pasta\r\nhttps://vm.tiktok.com/ZMabc/';
    expect(handedText(`Creamy garlic pasta 🍝 #pasta\nhttps://vm.tiktok.com/ZMabc/\nmake for Sunday`, [caption])).toBe('Creamy garlic pasta 🍝 #pasta\nhttps://vm.tiktok.com/ZMabc/');
    // Pasted, then deleted from the box: gone.
    expect(handedText('something else', ['https://a.example/'])).toBeUndefined();
    // Two pastes, and a bigger one containing an earlier one.
    expect(handedText('a https://a.example/ b https://b.example/', ['https://a.example/', 'https://b.example/'])).toBe('https://a.example/\nhttps://b.example/');
    expect(handedText('see https://a.example/ now', ['https://a.example/', 'see https://a.example/ now'])).toBe('see https://a.example/ now');
  });
});

describe('Instagram share links', () => {
  it('does not take "share" for a username', () => {
    const c = classify({ text: 'https://www.instagram.com/share/p/BAAbCdEfGh' });
    expect(c.source).toBe('instagram');
    expect(c.title).toBe('Instagram post');
    expect(classify({ text: 'https://www.instagram.com/share/reel/BAAbCdEfGh' }).title).toBe('Instagram reel');
    expect(classify({ text: 'https://www.instagram.com/chef.anna/p/DAbCdEfGhIj/' }).title).toBe('Instagram post by @chef.anna');
  });
});

describe('Chinese, Japanese and Korean captions', () => {
  const REEL = 'https://www.instagram.com/reel/AbC123/';
  const POST = 'https://www.instagram.com/p/AbC123/';
  const kind = (text: string, url: string | undefined = REEL) => classify({ text, url });

  it('re-files reels from Chinese travel words, confidently enough to apply later', () => {
    const r = kind('假日好去處 海邊看日出打卡 📍某某海灘');
    expect(r.type).toBe('place');
    expect(r.confidence).not.toBe('low');
    expect(r.tags).toEqual(expect.arrayContaining(['beach', 'outdoors']));
    expect(r.reasons[0]).toMatch(/^mentions 好去處/);
    // Simplified spellings count the same.
    expect(kind('假日好去处 海边看日出 打卡').type).toBe('place');
    expect(kind('东京自由行 第三日行程 浅草寺').type).toBe('place');
    // A post (not a reel) needs less.
    expect(kind('旅遊必去景點', POST).type).toBe('place');
  });

  it('knows food spots, stays, shrines and travel destinations', () => {
    expect(kind('銅鑼灣隱世咖啡店 必試').tags).toContain('coffee');
    expect(kind('海景酒店 住一晚 度假').tags).toContain('stay');
    expect(kind('京都散步 參拜神社 📍某某神社').type).toBe('place');
    expect(kind('首爾 맛집 카페 추천').type).toBe('place');
    expect(kind('東京のおすすめカフェ 観光').type).toBe('place');
  });

  it('spots recipes, workouts, products, books and events', () => {
    expect(kind('【食譜】氣炸鍋雞翼 做法超簡單 材料：雞翼 豉油').type).toBe('recipe');
    expect(kind('簡単レシピ 作り方 材料').type).toBe('recipe');
    expect(kind('在家十分鐘瘦腿運動 跟住做').type).toBe('workout');
    expect(kind('皮拉提斯入門 改善姿勢').tags).toContain('pilates');
    expect(kind('全新相機開箱 價格 $1,299 購買連結喺bio').type).toBe('product');
    expect(kind('書單｜今年讀過最好的5本小說').type).toBe('book');
    expect(kind('快閃店 日期：3/12-28/12 地址：某商場地下').type).toBe('event');
    expect(kind('演唱會門票 10月25日 公開發售').reasons[0]).toBe('has a date: 10月25日');
  });

  it('keeps generic posts generic', () => {
    for (const text of ['炒股心得：今日大市回落', '運動員專訪：備戰比賽的日子', '今日天氣：多雲，有驟雨', '我哋公司嘅品牌故事', '記低先，遲啲睇']) {
      expect(kind(text).type).toBe('video');
    }
    expect(classify({ text: '記得買牛奶同雞蛋' }).type).toBe('note');
    // Music and articles never re-file a video, and longer words win over the short ones inside them.
    expect(kind('節奏訓練 自彈自唱 鋼琴').type).toBe('video');
  });

  it('needs a date or a way to book before a reel becomes an event, and recaps stay videos', () => {
    expect(kind('展覽 好正').type).toBe('video');
    expect(kind('沉浸式劇場 早鳥門票 連結喺bio').type).toBe('event');
    expect(kind('展覽 回顧 精華片段 9月1日').type).toBe('video');
  });

  it('reads English words that touch Chinese text', () => {
    const r = kind('去cafe打卡 brunch好正');
    expect(r.type).toBe('place');
    expect(r.reasons[0]).toMatch(/cafe/);
  });

  it('quotes CJK hashtags as hashtags only when the term is the whole tag', () => {
    expect(kind('#自由行 #行程 去咗好多景點').reasons.join(' ')).toMatch(/#自由行/);
    expect(kind('#日本自由行 景點').reasons.join(' ')).toMatch(/mentions .*自由行/);
  });

  it('ignores when a post went up, in a raw Instagram description', () => {
    const r = kind('12 likes, 3 comments - someone on July 2, 2026: “Jazz night at the bar, live music”.');
    expect(r.type).toBe('video');
    expect(r.reasons.join(' ')).not.toMatch(/date/);
    // A date in the caption itself still counts, and so do dates that only look like that.
    expect(kind('12 likes, 3 comments - someone on July 2, 2026: “Jazz night Sat 12 Oct, tickets in bio”.').type).toBe('event');
    expect(classify({ text: 'Dinner on Sat 12 Oct at the wine bar' }).reasons.join(' ')).toMatch(/has a date/);
    expect(classify({ text: 'Dinner on October 3, 2026 at the wine bar' }).reasons.join(' ')).toMatch(/has a date/);
  });
});

describe('English travel, visiting and reading words', () => {
  const url = 'https://www.instagram.com/reel/AbC123/';

  it('reads travel planning and directions as places', () => {
    const text = 'Road trip planning: the best routes for getting around the coast';
    expect(classify({ text, url }).type).toBe('place');
    const r = classify({ text: 'Directions: take exit B, then follow the trail to the summit 📍', url });
    expect(r.type).toBe('place');
    expect(r.confidence).not.toBe('low');
  });

  it('is sure about a book list on a reel', () => {
    const r = classify({ text: 'Book list: three novels I loved this summer', url });
    expect(r.type).toBe('book');
    expect(r.confidence).not.toBe('low');
  });
});
