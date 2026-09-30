import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCollection, addItem, buildItem, db, deleteCollection, markDone, markTodo, saveShared, toggleItemInCollection } from './db';
import { addSampleData } from './samples';
import { decodeShare, encodeShare, shareUrl, toShared } from './share';
import { describeRules, itemsInCollection, matchesRules } from './smart';
import { exportBackup, importBackup, importSharedCollection } from './transfer';
import type { Collection } from './types';

beforeEach(async () => {
  await db.items.clear();
  await db.collections.clear();
});

describe('smart collections', () => {
  const pasta = buildItem({ title: 'Pasta', type: 'recipe', tags: ['pasta', 'quick'] });
  const cafe = buildItem({ title: 'Café', type: 'place', tags: ['coffee'], status: 'done' });

  it('matches any / all tags, types and status', () => {
    expect(matchesRules(pasta, { tags: ['pasta', 'coffee'], match: 'any', types: [], status: 'any' })).toBe(true);
    expect(matchesRules(pasta, { tags: ['pasta', 'coffee'], match: 'all', types: [], status: 'any' })).toBe(false);
    expect(matchesRules(cafe, { tags: [], match: 'any', types: ['place'], status: 'done' })).toBe(true);
    expect(matchesRules(cafe, { tags: [], match: 'any', types: ['place'], status: 'todo' })).toBe(false);
  });

  it('empty rules match nothing', () => {
    expect(matchesRules(pasta, { tags: [], match: 'any', types: [], status: 'any' })).toBe(false);
  });

  it('describes rules for humans', () => {
    expect(describeRules({ tags: ['pasta'], match: 'any', types: ['recipe'], status: 'todo' })).toBe('#pasta · recipe · not done yet');
  });
});

describe('library', () => {
  it('saves shared content with classification', async () => {
    const item = await saveShared({ text: 'Amazing ramen restaurant in Shibuya https://www.tiktok.com/@a/video/1' });
    expect(item.type).toBe('place');
    expect(item.source).toBe('tiktok');
    expect(item.status).toBe('todo');
    expect(await db.items.count()).toBe(1);
  });

  it('marks done with a review and back again', async () => {
    const item = await addItem({ title: 'Thing', type: 'note' });
    await markDone(item.id, 4, '  Loved it ');
    let saved = await db.items.get(item.id);
    expect(saved).toMatchObject({ status: 'done', rating: 4, review: 'Loved it' });
    expect(saved?.doneAt).toBeTypeOf('number');
    await markTodo(item.id);
    saved = await db.items.get(item.id);
    expect(saved?.status).toBe('todo');
    expect(saved && ['rating', 'review', 'doneAt'].some((k) => k in saved)).toBe(false);
  });

  it('adds and removes items from manual collections; deleting a collection keeps its items', async () => {
    const col = await addCollection({ name: 'Trip', emoji: '✈️', color: '#000000', kind: 'manual' });
    const item = await addItem({ title: 'Museum', type: 'place' });
    await toggleItemInCollection(item.id, col.id);
    expect(itemsInCollection(await db.items.toArray(), col)).toHaveLength(1);
    await deleteCollection(col.id);
    expect(await db.collections.count()).toBe(0);
    expect((await db.items.get(item.id))?.collectionIds).toEqual([]);
  });

  it('loads sample data', async () => {
    await addSampleData();
    expect(await db.items.count()).toBeGreaterThan(10);
    const cols = await db.collections.toArray();
    const dinner = cols.find((c) => c.name === 'Dinner ideas')!;
    const items = await db.items.toArray();
    expect(itemsInCollection(items, dinner).length).toBeGreaterThan(0);
    expect(items.filter((i) => i.place).length).toBeGreaterThanOrEqual(6);
  });
});

describe('sharing collections', () => {
  it('round-trips through a compressed link and imports safely', async () => {
    const col: Collection = { id: 'c1', name: 'Tokyo', emoji: '🗼', color: '#e11d48', kind: 'manual', createdAt: 0, updatedAt: 0 };
    const items = [
      buildItem({ title: 'Ichiran', type: 'place', url: 'https://example.com/ichiran', place: { lat: 35.66, lng: 139.7 }, tags: ['ramen'] }),
      buildItem({ title: 'Evil', type: 'link', url: 'javascript:alert(1)', image: 'data:text/html,hi' }),
    ];
    const payload = await encodeShare(toShared(col, items));
    expect(payload.startsWith('z')).toBe(true);
    const url = shareUrl(payload, 'https://me.example/magpie/?x=1#/collections/c1');
    expect(url).toBe(`https://me.example/magpie/#/import/${payload}`);

    const decoded = await decodeShare(payload);
    expect(decoded.name).toBe('Tokyo');
    expect(decoded.items).toHaveLength(2);

    const imported = await importSharedCollection(decoded);
    const saved = await db.items.where('collectionIds').equals(imported.id).toArray();
    expect(saved).toHaveLength(2);
    const evil = saved.find((i) => i.title === 'Evil')!;
    expect(evil.url).toBeUndefined();
    expect(evil.image).toBeUndefined();
    expect(saved.find((i) => i.title === 'Ichiran')?.place).toEqual({ lat: 35.66, lng: 139.7, address: undefined });
  });

  it('rejects garbage', async () => {
    await expect(decodeShare('zzzz')).rejects.toThrow();
    await expect(decodeShare('xabc')).rejects.toThrow();
  });
});

describe('backups', () => {
  it('exports and re-imports everything', async () => {
    await addSampleData();
    const backup = await exportBackup();
    const count = backup.items.length;
    await db.items.clear();
    await db.collections.clear();
    const res = await importBackup(JSON.parse(JSON.stringify(backup)));
    expect(res.items).toBe(count);
    expect(await db.items.count()).toBe(count);
    expect(await db.collections.count()).toBe(3);
  });

  it('refuses files that are not backups', async () => {
    await expect(importBackup({ hello: 'world' })).rejects.toThrow(/backup/);
  });
});
