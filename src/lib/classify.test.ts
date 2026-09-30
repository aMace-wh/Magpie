import { describe, expect, it } from 'vitest';
import {
  classify,
  extractUrl,
  hashtags,
  normalizeTag,
  normalizeUrl,
  parsePlaceFromUrl,
  parseShared,
  titleFromUrl,
  youtubeId,
} from './classify';

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
