import { describe, expect, it } from 'vitest';
import { filterItems, isFiltering, typeCounts, type ItemFilter } from './filter';
import type { Item } from './types';

let n = 0;
function item(fields: Partial<Item> & Pick<Item, 'title'>): Item {
  n += 1;
  return { id: `i${n}`, type: 'link', tags: [], collectionIds: [], status: 'todo', createdAt: n, updatedAt: n, ...fields };
}

const all: ItemFilter = { query: '', type: 'all', status: 'any' };
const search = (items: Item[], query: string) => filterItems(items, { ...all, query }).map((i) => i.title);

describe('filterItems', () => {
  const ramen = item({
    title: 'Ichiran ramen',
    type: 'place',
    tags: ['ramen', 'food'],
    place: { lat: 35.66, lng: 139.7, name: 'Ichiran Shibuya', city: 'Tokyo', countryCode: 'JP' },
  });
  const tasca = item({
    title: 'Tasca do Chico',
    type: 'place',
    status: 'done',
    place: { lat: 38.71, lng: -9.14, city: 'Lisbon', country: 'Portugal', countryCode: 'PT' },
  });
  const reel = item({
    title: 'Crispy potatoes',
    type: 'recipe',
    url: 'https://www.instagram.com/reel/abc',
    sharedText: 'The crispiest smashed potatoes you will ever make 🥔 #sidedish',
    from: { name: 'Sam', at: 1 },
  });
  const video = item({ title: 'Deep work talk', type: 'video', note: 'Watch before Monday', url: 'https://youtu.be/xyz' });
  const items = [ramen, tasca, reel, video];

  it('returns everything for an empty filter', () => {
    expect(filterItems(items, all)).toHaveLength(4);
    expect(filterItems(items, { ...all, query: '   ' })).toHaveLength(4);
  });

  it('filters by kind and status', () => {
    expect(filterItems(items, { ...all, type: 'place' }).map((i) => i.title)).toEqual(['Ichiran ramen', 'Tasca do Chico']);
    expect(filterItems(items, { ...all, status: 'done' }).map((i) => i.title)).toEqual(['Tasca do Chico']);
    expect(filterItems(items, { ...all, type: 'place', status: 'todo' }).map((i) => i.title)).toEqual(['Ichiran ramen']);
  });

  it('matches title, notes, tags and the link host', () => {
    expect(search(items, 'deep')).toEqual(['Deep work talk']);
    expect(search(items, 'monday')).toEqual(['Deep work talk']);
    expect(search(items, '#food')).toEqual(['Ichiran ramen']);
    expect(search(items, 'youtu.be')).toEqual(['Deep work talk']);
  });

  it('matches the original shared text', () => {
    expect(search(items, 'smashed')).toEqual(['Crispy potatoes']);
    expect(search(items, '#sidedish')).toEqual(['Crispy potatoes']);
  });

  it('matches place name, city and country', () => {
    expect(search(items, 'shibuya')).toEqual(['Ichiran ramen']);
    expect(search(items, 'Lisbon')).toEqual(['Tasca do Chico']);
    expect(search(items, 'portugal')).toEqual(['Tasca do Chico']);
  });

  it('matches the country name worked out from the country code', () => {
    expect(search(items, 'Japan')).toEqual(['Ichiran ramen']);
    const codeOnly = item({ title: 'Lake', type: 'place', place: { lat: 46.4, lng: 8.2, countryCode: 'ch' } });
    expect(search([codeOnly], 'switzerland')).toEqual(['Lake']);
  });

  it('matches the friend who shared it', () => {
    expect(search(items, 'sam')).toEqual(['Crispy potatoes']);
  });

  it('needs every word to match, in any order and case', () => {
    expect(search(items, 'TOKYO ramen')).toEqual(['Ichiran ramen']);
    expect(search(items, 'ramen lisbon')).toEqual([]);
  });

  it('ignores invalid country codes', () => {
    const odd = item({ title: 'Somewhere', place: { lat: 0, lng: 0, countryCode: 'ZZ' } });
    expect(search([odd], 'zz')).toEqual([]);
  });

  it('sees edits, since a changed item is a new object', () => {
    const a = item({ title: 'Old name' });
    expect(search([a], 'new')).toEqual([]);
    expect(search([{ ...a, title: 'New name' }], 'new')).toEqual(['New name']);
  });
});

describe('isFiltering', () => {
  it('counts the search box and kind chips, not the status tab', () => {
    expect(isFiltering({ query: '', type: 'all', status: 'todo' })).toBe(false);
    expect(isFiltering({ query: '  ', type: 'all', status: 'done' })).toBe(false);
    expect(isFiltering({ query: 'pasta', type: 'all', status: 'todo' })).toBe(true);
    expect(isFiltering({ query: '', type: 'recipe', status: 'todo' })).toBe(true);
  });
});

describe('typeCounts', () => {
  it('counts kinds, most common first', () => {
    const items = [item({ title: 'a', type: 'video' }), item({ title: 'b', type: 'recipe' }), item({ title: 'c', type: 'video' })];
    expect(typeCounts(items)).toEqual([
      ['video', 2],
      ['recipe', 1],
    ]);
    expect(typeCounts([])).toEqual([]);
  });
});
