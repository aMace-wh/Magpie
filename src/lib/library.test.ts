import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCollection, addItem, buildItem, db, deleteCollection, markDone, markTodo, saveShared, toggleItemInCollection, updateItem } from './db';
import { groupByCountry } from './location';
import { addSampleData } from './samples';
import { decodeShare, encodeShare, readShareFile, shareCollection, shareItem, shareLibrary, shareUrl, shortHash, toShared, type SharedPayloadV2 } from './share';
import { describeRules, itemsInCollection, matchesRules } from './smart';
import { countSelection, exportBackup, importBackup, importShare, importSharedCollection, planImport, urlKey } from './transfer';
import type { Collection, Item } from './types';
import { whenStatus } from './when';
import { importButtonLabel } from '../screens/ImportScreen';

beforeEach(async () => {
  await db.items.clear();
  await db.collections.clear();
});

describe('updateItem', () => {
  it('remembers what the user changed by hand, so the automatic analysis leaves it alone', async () => {
    const item = await addItem({ type: 'video', title: 'Reel', tags: ['a'], place: { lat: 1, lng: 2 }, locatePending: true });
    await updateItem(item.id, { title: 'Reel', type: 'video', note: 'mine' });
    expect((await db.items.get(item.id))!.edited).toBeUndefined();
    await updateItem(item.id, { type: 'recipe', tags: ['a', 'b'] });
    await updateItem(item.id, { place: undefined, when: { start: '2026-10-24' } });
    const saved = (await db.items.get(item.id))!;
    expect(saved.edited).toEqual(['type', 'tags', 'when', 'place']);
    expect(saved).toMatchObject({ type: 'recipe', tags: ['a', 'b'], note: 'mine', when: { start: '2026-10-24' } });
    expect('place' in saved).toBe(false);
    expect(saved.locatePending).toBeUndefined();
  });
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
    expect(cols).toHaveLength(3);
    const dinner = cols.find((c) => c.name === 'Dinner ideas')!;
    const items = await db.items.toArray();
    expect(itemsInCollection(items, dinner).length).toBeGreaterThan(0);
    expect(items.filter((i) => i.place).length).toBeGreaterThanOrEqual(8);
    // Only the fields that belong on a save.
    expect(items.some((i) => 'reasons' in i || 'confidence' in i || 'alternatives' in i)).toBe(false);
  });

  it('sample places have full details and group into three countries', async () => {
    await addSampleData();
    const items = await db.items.toArray();
    for (const i of items.filter((x) => x.place)) {
      expect(i.place, i.title).toMatchObject({ name: expect.any(String), city: expect.any(String), country: expect.any(String), countryCode: expect.stringMatching(/^[A-Z]{2}$/) });
    }
    expect(groupByCountry(items).map((g) => g.code).sort()).toEqual(['GB', 'JP', 'PT']);
  });

  it('sample data has events (coming up, on now, been) and original captions', async () => {
    await addSampleData();
    const items = await db.items.toArray();
    const events = items.filter((i) => i.type === 'event');
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.when && e.place)).toBe(true);
    expect(events.map((e) => whenStatus(e.when!)).sort()).toEqual(['ongoing', 'past', 'upcoming']);
    const past = events.find((e) => whenStatus(e.when!) === 'past')!;
    expect(past).toMatchObject({ status: 'done', rating: expect.any(Number), review: expect.any(String) });
    const jazz = events.find((e) => whenStatus(e.when!) === 'upcoming')!;
    expect(jazz.when!.start).toMatch(/T\d{2}:\d{2}$/);
    const lisbon = (await db.collections.toArray()).find((c) => c.name === 'Weekend in Lisbon')!;
    expect(jazz.collectionIds).toContain(lisbon.id);
    const captions = items.filter((i) => i.sharedText);
    expect(captions.length).toBeGreaterThanOrEqual(2);
    expect(items.find((i) => i.title.includes('orzo'))?.sharedText).toMatch(/#pasta/);
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

  it('keeps why a save is bare, but not once it has a preview, and never in a share', async () => {
    const bare = await addItem({ type: 'video', title: 'Instagram reel', url: 'https://www.instagram.com/reel/AbC123/', source: 'instagram' });
    const filled = await addItem({ type: 'video', title: 'Night market', url: 'https://www.instagram.com/reel/XyZ789/', source: 'instagram', siteName: 'Instagram' });
    await db.items.update(bare.id, { previewIssue: 'unavailable' });
    await db.items.update(filled.id, { previewIssue: 'unavailable' });
    const backup = JSON.parse(JSON.stringify(await exportBackup()));
    await db.items.clear();
    await importBackup(backup);
    expect((await db.items.get(bare.id))?.previewIssue).toBe('unavailable');
    expect((await db.items.get(filled.id))?.previewIssue).toBeUndefined();
    const shared = JSON.stringify(await decodeShare(await encodeShare(shareItem((await db.items.get(bare.id))!))));
    expect(shared).toContain('AbC123');
    expect(shared).not.toContain('unavailable');
  });
});

// ---------------------------------------------------------------------------
// Friend shares (v2)

const lisbon: Collection = { id: 'sam-c1', name: 'Weekend in Lisbon', emoji: '🇵🇹', color: '#0ea5a4', kind: 'manual', createdAt: 0, updatedAt: 0 };

function samItems(): Item[] {
  return [
    buildItem({
      title: 'Pastéis de Belém',
      type: 'place',
      url: 'https://pasteisdebelem.pt/',
      tags: ['food'],
      place: { lat: 38.6975, lng: -9.2032, name: 'Pastéis de Belém', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' },
      sharedText: 'omg these tarts https://pasteisdebelem.pt/',
    }),
    buildItem({ title: 'Fado night', type: 'event', url: 'https://tickets.example/fado', when: { start: '2026-10-12T19:30' } }),
    buildItem({ title: 'Pack a jumper', type: 'note' }),
  ];
}

const colItems = async (id: string) => db.items.where('collectionIds').equals(id).toArray();

describe('importShare: collections', () => {
  it('creates a collection attributed to the sender', async () => {
    const p = shareCollection(lisbon, samItems(), { from: 'Sam' });
    const res = await importShare(await decodeShare(await encodeShare(p)));
    expect(res).toMatchObject({ added: 3, updated: 0, skipped: 0 });
    const col = await db.collections.get(res.collectionId!);
    expect(col).toMatchObject({ name: 'Weekend in Lisbon', emoji: '🇵🇹', color: '#0ea5a4', kind: 'manual', from: { name: 'Sam', shareId: 'c:sam-c1' } });
    expect(col?.from?.at).toBeTypeOf('number');
    const items = await colItems(col!.id);
    expect(items).toHaveLength(3);
    const tarts = items.find((i) => i.title === 'Pastéis de Belém')!;
    expect(tarts.from).toMatchObject({ name: 'Sam', shareId: 'c:sam-c1' });
    expect(tarts.place).toEqual({ lat: 38.6975, lng: -9.2032, name: 'Pastéis de Belém', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' });
    expect(tarts.sharedText).toBe('omg these tarts https://pasteisdebelem.pt/');
    expect(tarts.status).toBe('todo');
    expect(items.find((i) => i.title === 'Fado night')?.when).toEqual({ start: '2026-10-12T19:30' });
  });

  it('merges an updated share: new saves added, shared fields updated, your own fields untouched, nothing deleted', async () => {
    const original = samItems();
    const first = await importShare(shareCollection(lisbon, original, { from: 'Sam' }));
    const mine = await colItems(first.collectionId!);
    const tarts = mine.find((i) => i.title === 'Pastéis de Belém')!;
    await markDone(tarts.id, 4, 'Worth the queue');
    await updateItem(tarts.id, { note: 'my note', tags: [...tarts.tags, 'mine'] });

    const [t, f] = original;
    const updated = [
      { ...t, title: 'Pastéis de Belém (original)', image: 'https://img.example/tarts.jpg', tags: ['food', 'dessert'], status: 'todo' as const, rating: undefined },
      { ...f, when: { start: '2026-10-13T20:00' } },
      buildItem({ title: 'Miradouro da Graça', type: 'place', url: 'https://maps.example/graca' }),
    ];
    const res = await importShare(shareCollection(lisbon, updated, { from: 'Sam' }));
    expect(res).toMatchObject({ added: 1, updated: 2, skipped: 0, collectionId: first.collectionId });
    expect(await db.collections.count()).toBe(1);
    const after = await colItems(first.collectionId!);
    expect(after).toHaveLength(4); // "Pack a jumper" was left out of the new share but isn't deleted
    const t2 = after.find((i) => i.id === tarts.id)!;
    expect(t2).toMatchObject({ title: 'Pastéis de Belém (original)', image: 'https://img.example/tarts.jpg', status: 'done', rating: 4, review: 'Worth the queue', note: 'my note' });
    expect(t2.tags).toEqual(['food', 'mine', 'dessert']);
    expect(t2.sharedText).toBe('omg these tarts https://pasteisdebelem.pt/'); // not cleared
    expect(after.find((i) => i.title === 'Fado night')?.when).toEqual({ start: '2026-10-13T20:00' });

    // Same share again: nothing changes.
    const again = await importShare(shareCollection(lisbon, updated, { from: 'Sam' }));
    expect(again).toMatchObject({ added: 0, updated: 0, skipped: 3 });
    expect(await db.items.count()).toBe(4);
  });

  it("doesn't put back a save you took out of the shared collection", async () => {
    const res = await importShare(shareCollection(lisbon, samItems(), { from: 'Sam' }));
    const fado = (await colItems(res.collectionId!)).find((i) => i.title === 'Fado night')!;
    await toggleItemInCollection(fado.id, res.collectionId!);
    await importShare(shareCollection(lisbon, samItems(), { from: 'Sam' }));
    expect((await db.items.get(fado.id))?.collectionIds).toEqual([]);
    expect(await db.items.count()).toBe(3);
  });

  it("links saves you already have instead of duplicating them (even with tracking params, www and trailing slashes)", async () => {
    const own = await addItem({ title: 'My tarts', type: 'place', url: 'http://www.pasteisdebelem.pt?utm_source=ig&fbclid=abc', status: 'done', rating: 5 });
    const res = await importShare(shareCollection(lisbon, samItems(), { from: 'Sam' }));
    expect(res).toMatchObject({ added: 2, skipped: 1 });
    expect(await db.items.count()).toBe(3);
    const linked = await db.items.get(own.id);
    expect(linked?.collectionIds).toEqual([res.collectionId]);
    expect(linked).toMatchObject({ title: 'My tarts', status: 'done', rating: 5 });
    expect(linked?.from).toBeUndefined();
  });

  it('imports only the selected saves; an empty selection changes nothing', async () => {
    const p = shareCollection(lisbon, samItems(), { from: 'Sam' });
    const none = await importShare(p, { itemIds: [] });
    expect(none).toMatchObject({ added: 0, updated: 0, skipped: 0, collectionIds: [] });
    expect(await db.collections.count()).toBe(0);
    const some = await importShare(p, { itemIds: ['0', '2'] });
    expect(some.added).toBe(2);
    expect((await colItems(some.collectionId!)).map((i) => i.title).sort()).toEqual(['Pack a jumper', 'Pastéis de Belém']);
  });

  it("keeps the sender's notes and ratings (when shared) as a note on new saves", async () => {
    const items = samItems();
    items[0] = { ...items[0], note: 'Go early', status: 'done', rating: 4, review: 'Crispy!' };
    await importShare(shareCollection(lisbon, items, { from: 'Sam', includePersonal: true }));
    const t = (await db.items.toArray()).find((i) => i.title === 'Pastéis de Belém')!;
    expect(t.status).toBe('todo');
    expect(t.rating).toBeUndefined();
    expect(t.review).toBeUndefined();
    expect(t.note).toBe('Go early\n\nSam: Visited · ★★★★☆\n“Crispy!”');
  });

  it('shows what will happen before importing', async () => {
    const p = shareCollection(lisbon, samItems(), { from: 'Sam' });
    let preview = await planImport(p);
    expect(preview).toMatchObject({ rows: ['new', 'new', 'new'], counts: { new: 3, update: 0, have: 0 }, own: false });
    expect(preview.existing).toBeUndefined();

    await importShare(p);
    await addItem({ title: 'Graça', type: 'place', url: 'https://maps.example/graca' });
    preview = await planImport(shareCollection(lisbon, [...samItems(), buildItem({ title: 'Graça!', type: 'place', url: 'https://maps.example/graca/' }), buildItem({ title: 'New', type: 'link' })], { from: 'Sam' }));
    // Unchanged since the last import: already saved, nothing to update.
    expect(preview.rows).toEqual(['have', 'have', 'have', 'have', 'new']);
    expect(preview.existing?.name).toBe('Weekend in Lisbon');
    const renamed = samItems().map((i) => (i.title === 'Fado night' ? { ...i, title: 'Fado night at Tasca' } : i));
    expect((await planImport(shareCollection(lisbon, renamed, { from: 'Sam' }))).rows).toEqual(['have', 'update', 'have']);
  });

  it('recognises your own collection', async () => {
    const mine = await addCollection({ name: 'Mine', emoji: '⭐', color: '#000000', kind: 'manual' });
    expect((await planImport(shareCollection(mine, []))).own).toBe(true);
    expect((await planImport(shareCollection(lisbon, []))).own).toBe(false);
  });
});

describe('importShare: single saves', () => {
  it('adds one save from a friend, and updates it (not duplicates it) next time', async () => {
    const [tarts] = samItems();
    const p = shareItem(tarts, { from: 'Sam' });
    const res = await importShare(p);
    expect(res).toMatchObject({ added: 1, collectionIds: [] });
    expect(res.collectionId).toBeUndefined();
    const saved = await db.items.get(res.itemId!);
    expect(saved).toMatchObject({ title: 'Pastéis de Belém', collectionIds: [], from: { name: 'Sam', shareId: `i:${tarts.id}` } });

    const again = await importShare(shareItem({ ...tarts, title: 'Pastéis!' }, { from: 'Sam' }));
    expect(again).toMatchObject({ added: 0, updated: 1, itemId: res.itemId });
    expect((await db.items.get(res.itemId!))?.title).toBe('Pastéis!');
    expect(await db.items.count()).toBe(1);
  });

  it("skips a save you already have and points at yours", async () => {
    const own = await addItem({ title: 'Tarts', type: 'place', url: 'https://pasteisdebelem.pt' });
    const res = await importShare(shareItem(samItems()[0], { from: 'Sam' }));
    expect(res).toMatchObject({ added: 0, updated: 0, skipped: 1, itemId: own.id });
    expect((await planImport(shareItem(samItems()[0]))).existingItem?.id).toBe(own.id);
  });
});

describe('importShare: libraries', () => {
  it("creates a collection per shared collection, plus \"<Sender>'s saves\" for the rest, and merges next time", async () => {
    const [tarts, fado, note] = samItems();
    const events: Collection = { ...lisbon, id: 'sam-c2', name: 'Gigs', emoji: '🎸' };
    tarts.collectionIds = [lisbon.id];
    fado.collectionIds = [lisbon.id, events.id];
    const opts = { from: 'Sam', includePersonal: true };
    const p: SharedPayloadV2 = { ...shareLibrary([tarts, fado, note], [lisbon, events], opts), shareId: 'l:samsphone' };
    const res = await importShare(p);
    expect(res.added).toBe(3);
    expect(res.collectionIds).toHaveLength(3);
    expect(res.collectionId).toBeUndefined();
    const cols = await db.collections.toArray();
    expect(cols.map((c) => c.name).sort()).toEqual(['Gigs', "Sam's saves", 'Weekend in Lisbon']);
    // Filed by Sam's own collections (so they match the same collections shared on their own); loose saves by the library.
    expect(cols.map((c) => c.from?.shareId).sort()).toEqual([`cf:${shortHash('sam-c1')}`, `cf:${shortHash('sam-c2')}`, 'l:samsphone:_'].sort());
    const byName = (n: string) => cols.find((c) => c.name === n)!.id;
    const saved = await db.items.toArray();
    expect(saved.find((i) => i.title === 'Fado night')?.collectionIds.sort()).toEqual([byName('Weekend in Lisbon'), byName('Gigs')].sort());
    expect(saved.find((i) => i.title === 'Pack a jumper')?.collectionIds).toEqual([byName("Sam's saves")]);

    const preview = await planImport(p);
    expect(Object.keys(preview.existingByKey).sort()).toEqual(['0', '1', '_']);

    const extra = buildItem({ title: 'Tram 28', type: 'place', collectionIds: [events.id] });
    const res2 = await importShare({ ...shareLibrary([tarts, fado, note, extra], [lisbon, events], opts), shareId: 'l:samsphone' });
    expect(res2).toMatchObject({ added: 1, updated: 0, skipped: 3 });
    expect(await db.collections.count()).toBe(3);
    expect((await db.items.toArray()).find((i) => i.title === 'Tram 28')?.collectionIds).toEqual([byName('Gigs')]);
  });

  it('calls the loose-saves collection "Shared saves" when the sender has no name', async () => {
    const res = await importShare({ ...shareLibrary(samItems(), []), shareId: 'l:anon' });
    expect(res.collectionId).toBeDefined();
    expect((await db.collections.get(res.collectionId!))?.name).toBe('Shared saves');
  });

  it('imports a friend’s backup file as a library', async () => {
    await addSampleData();
    const backup = await exportBackup();
    await db.items.clear();
    await db.collections.clear();
    const res = await importShare(await readShareFile(new Blob([JSON.stringify(backup)])));
    expect(res.added).toBe(backup.items.length);
    expect(await db.collections.count()).toBeGreaterThanOrEqual(3);
  });
});

describe('importShare: sanitising', () => {
  const evil: SharedPayloadV2 = {
    v: 2,
    kind: 'collection',
    shareId: 'c:evil',
    from: '  Mallory  ',
    name: 'Totally normal list',
    emoji: '📌',
    color: 'url(javascript:alert(1))',
    items: [
      { t: 'link', n: 'Script link', u: 'javascript:alert(1)', i: 'data:image/svg+xml,<svg onload=alert(1)>' },
      { t: 'event', n: 'Bad dates', w: { start: '2026-02-30' } },
      { t: 'event', n: 'Backwards', w: { start: '2026-10-12', end: '2026-10-01' } },
      { t: 'event', n: 'Late', w: { start: '2026-10-12T25:00' } },
      { t: 'place', n: 'Bad country', p: { lat: 1, lng: 2, countryCode: '<b>', country: 'X' } },
      { t: 'place', n: 'Lower country', p: { lat: 1, lng: 2, countryCode: 'pt' } },
      { t: 'place', n: 'Off the map', p: { lat: 123, lng: 2 } },
      { t: 'note', n: 'Long post', x: 'x'.repeat(9000), g: ['#Food Truck', 'FOOD truck', '', '  '] },
      { t: 'recipe', n: 'Ratings', r: 42, rv: 'ok', st: 'done' },
      { t: 'hacker' as never, n: 'y'.repeat(900) },
    ],
  };

  it('drops unsafe links, bad dates and bad country codes; clips and normalises the rest', async () => {
    const res = await importShare(evil);
    expect(res.added).toBe(evil.items.length);
    const col = await db.collections.get(res.collectionId!);
    expect(col?.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(col?.from?.name).toBe('Mallory');
    const items = await db.items.toArray();
    const get = (prefix: string) => items.find((i) => i.title.startsWith(prefix))!;
    expect(get('Script link').url).toBeUndefined();
    expect(get('Script link').image).toBeUndefined();
    expect(get('Bad dates').when).toBeUndefined();
    expect(get('Backwards').when).toEqual({ start: '2026-10-12' });
    expect(get('Late').when).toBeUndefined();
    expect(get('Bad country').place).toEqual({ lat: 1, lng: 2, country: 'X' });
    expect(get('Lower country').place?.countryCode).toBe('PT');
    expect(get('Off the map').place).toBeUndefined();
    expect(get('Long post').sharedText).toHaveLength(5000);
    expect(get('Long post').tags).toEqual(['food-truck']);
    const rated = get('Ratings');
    expect(rated).toMatchObject({ status: 'todo', note: 'Mallory: Cooked · ★★★★★\n“ok”' });
    expect(rated.rating).toBeUndefined();
    const hacker = get('yyy');
    expect(hacker.type).toBe('link');
    expect(hacker.title).toHaveLength(300);
  });

  it('keeps the old v1 entry point working and refuses non-collections there', async () => {
    const col = await importSharedCollection(shareCollection(lisbon, samItems(), { from: 'Sam' }));
    expect(col.name).toBe('Weekend in Lisbon');
    await expect(importSharedCollection(shareItem(samItems()[0]))).rejects.toThrow();
  });

  it('compares links sensibly', () => {
    expect(urlKey('https://www.Example.com/a/?utm_source=x&b=2&a=1#section')).toBe('example.com/a?a=1&b=2');
    expect(urlKey('http://example.com/a')).toBe(urlKey('https://m.example.com/a/'));
    expect(urlKey('https://example.com/a?id=1')).not.toBe(urlKey('https://example.com/a?id=2'));
    expect(urlKey('https://app.example/#/item/1')).not.toBe(urlKey('https://app.example/#/item/2'));
    expect(urlKey('javascript:alert(1)')).toBeUndefined();
    expect(urlKey('not a url')).toBeUndefined();
  });
});

describe('backups: new fields', () => {
  it('round-trip events, original posts, share attribution and place details', async () => {
    const col = await addCollection({ name: 'From Sam', emoji: '🎁', color: '#0ea5a4', kind: 'manual', from: { name: 'Sam', shareId: 'c:abc', at: 123 } });
    await addItem({
      title: 'Fado night',
      type: 'event',
      when: { start: '2026-10-12T19:30', end: '2026-10-12T22:00', source: 'Mon 12 Oct 7:30pm' },
      sharedText: 'Fado tonight! https://tickets.example/fado',
      from: { name: 'Sam', shareId: 'c:abc', at: 123 },
      place: { lat: 38.71, lng: -9.13, name: 'Clube de Fado', city: 'Lisbon', country: 'Portugal', countryCode: 'PT', address: 'Rua S. João da Praça 94' },
      collectionIds: [col.id],
    });
    const backup = JSON.parse(JSON.stringify(await exportBackup()));
    await db.items.clear();
    await db.collections.clear();
    await importBackup(backup);
    const [item] = await db.items.toArray();
    expect(item.when).toEqual({ start: '2026-10-12T19:30', end: '2026-10-12T22:00', source: 'Mon 12 Oct 7:30pm' });
    expect(item.sharedText).toBe('Fado tonight! https://tickets.example/fado');
    expect(item.from).toEqual({ name: 'Sam', shareId: 'c:abc', at: 123 });
    expect(item.place).toEqual({ lat: 38.71, lng: -9.13, name: 'Clube de Fado', city: 'Lisbon', country: 'Portugal', countryCode: 'PT', address: 'Rua S. João da Praça 94' });
    expect((await db.collections.get(col.id))?.from).toEqual({ name: 'Sam', shareId: 'c:abc', at: 123 });
    // Re-importing a share after restoring still merges into the restored collection.
    expect((await planImport({ v: 2, kind: 'collection', shareId: 'c:abc', items: [] })).existing?.id).toBe(col.id);
  });

  it('sanitises the new fields in backups', async () => {
    await importBackup({
      app: 'magpie',
      version: 1,
      items: [
        {
          id: 'x',
          type: 'event',
          title: 'Bad',
          tags: [],
          collectionIds: [],
          status: 'todo',
          when: { start: '2026-99-99' },
          sharedText: 5,
          from: { name: 'Eve', shareId: 'bad id with spaces', at: 'yesterday' },
          place: { lat: 1, lng: 2, countryCode: 'Narnia', city: 7 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      collections: [{ id: 'k', name: 'K', emoji: '📌', color: '#fff', kind: 'manual', from: 'nope', createdAt: 1, updatedAt: 1 }],
    });
    const item = (await db.items.get('x'))!;
    expect(item.when).toBeUndefined();
    expect(item.sharedText).toBeUndefined();
    expect(item.from?.name).toBe('Eve');
    expect(item.from?.shareId).toBeUndefined();
    expect(item.from?.at).toBeTypeOf('number');
    expect(item.place).toEqual({ lat: 1, lng: 2 });
    expect((await db.collections.get('k'))?.from).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Merging updated shares: generic titles, duplicates, labels

const reel = (id: string, title = 'Instagram'): SharedPayloadV2['items'][number] => ({ t: 'video', n: title, u: `https://www.instagram.com/reel/${id}/` });
const col1 = (items: SharedPayloadV2['items'], from = 'Sam'): SharedPayloadV2 => ({ v: 2, kind: 'collection', shareId: 'c:abc', from, name: 'Reels', items });
const urls = async () => (await db.items.toArray()).map((i) => i.url).sort();

describe('importShare: saves with the same title', () => {
  it('adds a new link instead of overwriting an earlier save that has the same generic title', async () => {
    const first = await importShare(col1([reel('AAA')]));
    const [aaa] = await db.items.toArray();
    await markDone(aaa.id, 5, 'So good');

    const p = col1([reel('AAA'), reel('BBB')]);
    expect((await planImport(p)).rows).toEqual(['have', 'new']);
    const res = await importShare(p);
    expect(res).toMatchObject({ added: 1, updated: 0, skipped: 1, collectionId: first.collectionId });
    expect(await urls()).toEqual(['https://www.instagram.com/reel/AAA/', 'https://www.instagram.com/reel/BBB/']);
    // Your rating stays on the video you rated.
    expect(await db.items.get(aaa.id)).toMatchObject({ url: 'https://www.instagram.com/reel/AAA/', status: 'done', rating: 5, review: 'So good' });
    const bbb = (await db.items.toArray()).find((i) => i.id !== aaa.id)!;
    expect(bbb).toMatchObject({ status: 'todo', collectionIds: [first.collectionId] });
    expect(bbb.rating).toBeUndefined();
  });

  it("matches by link before title, so a new same-titled save listed first isn't dropped", async () => {
    await importShare(col1([reel('1', 'Film on Letterboxd')]));
    const p = col1([reel('2', 'Film on Letterboxd'), reel('1', 'Film on Letterboxd')]);
    const preview = await planImport(p);
    expect(preview.rows).toEqual(['new', 'have']);
    expect(preview.counts).toEqual({ new: 1, update: 0, have: 1 });
    const res = await importShare(p);
    expect(res).toMatchObject({ added: 1, updated: 0, skipped: 1 });
    expect(await urls()).toEqual(['https://www.instagram.com/reel/1/', 'https://www.instagram.com/reel/2/']);
  });

  it('matches each earlier save once: a second note with the same title is added', async () => {
    await importShare(col1([{ t: 'note', n: 'Idea', d: 'first' }]));
    const p = col1([{ t: 'note', n: 'Idea', d: 'first', g: ['x'] }, { t: 'note', n: 'Idea', d: 'second' }]);
    expect((await planImport(p)).rows).toEqual(['update', 'new']);
    const res = await importShare(p);
    expect(res).toMatchObject({ added: 1, updated: 1 });
    const notes = await db.items.toArray();
    expect(notes).toHaveLength(2);
    expect(notes.map((i) => i.note).sort()).toEqual(['first', 'second']);
  });

  it('still matches by title when only one side has a link (a link added or removed later)', async () => {
    await importShare(col1([{ t: 'event', n: 'Fado night' }, { t: 'place', n: 'Tram 28', u: 'https://tram.example/28' }]));
    const res = await importShare(col1([{ t: 'event', n: 'Fado night', u: 'https://tickets.example/fado' }, { t: 'place', n: 'Tram 28' }]));
    expect(res).toMatchObject({ added: 0, updated: 1, skipped: 1 });
    expect(await urls()).toEqual(['https://tickets.example/fado', 'https://tram.example/28']);
  });

  it("doesn't give an earlier save a link you already have (links yours instead)", async () => {
    const first = await importShare(col1([{ t: 'event', n: 'Fado night' }]));
    const own = await addItem({ title: 'My fado', type: 'event', url: 'https://tickets.example/fado' });
    const p = col1([{ t: 'event', n: 'Fado night', u: 'https://tickets.example/fado' }]);
    expect((await planImport(p)).rows).toEqual(['have']);
    await importShare(p);
    expect(await db.items.count()).toBe(2);
    expect((await db.items.toArray()).filter((i) => i.url).map((i) => i.id)).toEqual([own.id]);
    expect((await db.items.get(own.id))?.collectionIds).toEqual([first.collectionId]);
  });

  it('turns the same link listed twice into one save, in every collection it was listed in', async () => {
    const trips: Collection = { ...lisbon, id: 'c-trips', name: 'Trips' };
    const food: Collection = { ...lisbon, id: 'c-food', name: 'Food' };
    const a = buildItem({ title: 'Tarts', type: 'place', url: 'https://pasteisdebelem.pt/', collectionIds: [trips.id] });
    const b = buildItem({ title: 'Best tarts', type: 'place', url: 'https://www.pasteisdebelem.pt', collectionIds: [food.id] });
    const p: SharedPayloadV2 = { ...shareLibrary([a, b], [trips, food], { from: 'Sam' }), shareId: 'l:sam' };
    expect((await planImport(p)).rows).toEqual(['new', 'have']);
    const res = await importShare(p);
    expect(res).toMatchObject({ added: 1, skipped: 1 });
    const [saved] = await db.items.toArray();
    expect(await db.items.count()).toBe(1);
    expect(saved.collectionIds).toHaveLength(2);
    const names = (await db.collections.bulkGet(saved.collectionIds)).map((c) => c?.name).sort();
    expect(names).toEqual(['Food', 'Trips']);
  });

  it('links a save you already have each time the share is opened, unless you untick it', async () => {
    const own = await addItem({ title: 'Mine', type: 'link', url: 'https://a.example/x' });
    const p = col1([{ t: 'link', n: 'A', u: 'https://a.example/x' }, { t: 'link', n: 'B', u: 'https://b.example/' }]);
    const first = await importShare(p, { itemIds: ['1'] });
    // The friend's list includes a save you already had: opening it again links yours in.
    await importShare(p);
    expect((await db.items.get(own.id))?.collectionIds).toEqual([first.collectionId]);
    // Took it out again, and unticked it in the preview: it stays out.
    await toggleItemInCollection(own.id, first.collectionId!);
    await importShare(p, { itemIds: ['1'] });
    expect((await db.items.get(own.id))?.collectionIds).toEqual([]);
    expect(await db.items.count()).toBe(2);
  });
});

describe('importShare: picking some saves agrees with the preview', () => {
  it('matches over the whole share, so an unticked row still claims its earlier save', async () => {
    await importShare(col1([{ t: 'event', n: 'Fado night', u: 'https://tickets.example/fado' }]));
    const p = col1([{ t: 'event', n: 'Fado night' }, { t: 'event', n: 'Fado night', u: 'https://tickets.example/fado' }]);
    expect((await planImport(p)).rows).toEqual(['new', 'have']);
    const res = await importShare(p, { itemIds: ['0'] });
    expect(res).toMatchObject({ added: 1, updated: 0 });
    expect(await urls()).toEqual(['https://tickets.example/fado', undefined]);
  });

  it('adds a repeated link once, even when only later copies are picked', async () => {
    const x = { t: 'link' as const, n: 'X', u: 'https://x.example/' };
    const p = col1([x, { ...x, n: 'X again' }, { ...x, n: 'X once more' }]);
    const preview = await planImport(p);
    expect(preview.rows).toEqual(['new', 'have', 'have']);
    expect(preview.sameAs).toEqual({ 1: '0', 2: '0' });
    expect(countSelection(preview, 3, new Set(['0', '1', '2']))).toEqual({ new: 1, update: 0, have: 2 });
    expect(countSelection(preview, 3, new Set(['1', '2']))).toEqual({ new: 1, update: 0, have: 1 });
    expect(countSelection(preview, 3, new Set(['2']))).toEqual({ new: 1, update: 0, have: 0 });
    const res = await importShare(p, { itemIds: ['1', '2'] });
    expect(res).toMatchObject({ added: 1, skipped: 1 });
    const [saved] = await db.items.toArray();
    expect(await db.items.count()).toBe(1);
    expect(saved).toMatchObject({ title: 'X again', collectionIds: [res.collectionId] });
  });
});

describe('import button label', () => {
  const all = (p: SharedPayloadV2) => new Set(p.items.map((_, i) => String(i)));

  it('counts only saves that will be added or updated', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ t: 'link' as const, n: `Link ${i}`, u: `https://ex.example/${i}` }));
    for (const s of ten.slice(0, 9)) await addItem({ title: s.n, type: 'link', url: s.u });
    const p = col1(ten);
    const preview = await planImport(p);
    expect(importButtonLabel(p, preview, all(p))).toBe('Add 1 to my Magpie');
    expect(importButtonLabel(p, preview, new Set(['0', '1']))).toBe('Add the collection');
    expect(importButtonLabel(p, preview, new Set())).toBe('Add to my Magpie');
    expect(importButtonLabel(p, undefined, all(p))).toBe('Add 10 to my Magpie');
  });

  it('mentions updates, says "Update my collection" when nothing is new, and "Open my collection" when nothing changed', async () => {
    await importShare(col1([reel('A'), reel('B')]));
    const p = col1([reel('A', 'Renamed'), reel('B'), reel('C')]);
    const preview = await planImport(p);
    expect(preview.rows).toEqual(['update', 'have', 'new']);
    expect(importButtonLabel(p, preview, all(p))).toBe('Add 1 new · update 1');
    expect(importButtonLabel(p, preview, new Set(['0']))).toBe('Update my collection');
    expect(importButtonLabel(p, preview, new Set(['1']))).toBe('Open my collection');
  });

  it('labels single saves', async () => {
    const [tarts] = samItems();
    const item = shareItem(tarts, { from: 'Sam' });
    expect(importButtonLabel(item, await planImport(item), all(item))).toBe('Add to my Magpie');
    await importShare(item);
    // Nothing changed since: it's just there.
    expect(importButtonLabel(item, await planImport(item), all(item))).toBe('Open my save');
    const changedItem = shareItem({ ...tarts, title: 'Pastéis (the originals)' }, { from: 'Sam' });
    expect(importButtonLabel(changedItem, await planImport(changedItem), all(changedItem))).toBe('Update my save');
    await db.items.clear();
    await addItem({ title: 'Mine', type: 'place', url: 'https://pasteisdebelem.pt' });
    expect(importButtonLabel(item, await planImport(item), all(item))).toBe('Open my save');
  });
});

describe('importShare: coordinates', () => {
  it('keeps places with tiny coordinates (which print as 1e-7)', async () => {
    const res = await importShare({ v: 2, kind: 'item', shareId: 'i:gh', items: [{ t: 'place', n: 'Null Island-ish', p: { lat: 0.0000001, lng: 5, countryCode: 'gh', city: 'Accra' } }] });
    expect((await db.items.get(res.itemId!))?.place).toEqual({ lat: 0.0000001, lng: 5, city: 'Accra', countryCode: 'GH' });
  });

  it('checks coordinates as numbers in backups', async () => {
    const base = { type: 'place', title: 'P', tags: [], collectionIds: [], status: 'todo', createdAt: 1, updatedAt: 1 };
    await importBackup({
      app: 'magpie',
      version: 1,
      collections: [],
      items: [
        { ...base, id: 'tiny', place: { lat: -1e-9, lng: 1e-8 } },
        { ...base, id: 'text', place: { lat: ' 38.7 ', lng: '-9.14' } },
        { ...base, id: 'edge', place: { lat: 90, lng: -180 } },
        { ...base, id: 'nan', place: { lat: NaN, lng: 2 } },
        { ...base, id: 'inf', place: { lat: 1, lng: Infinity } },
        { ...base, id: 'exp', place: { lat: '1e5', lng: 2 } },
        { ...base, id: 'far', place: { lat: 90.0001, lng: 2 } },
        { ...base, id: 'none', place: { lat: 1 } },
      ],
    });
    const place = async (id: string) => (await db.items.get(id))?.place;
    expect(await place('tiny')).toEqual({ lat: -1e-9, lng: 1e-8 });
    expect(await place('text')).toEqual({ lat: 38.7, lng: -9.14 });
    expect(await place('edge')).toEqual({ lat: 90, lng: -180 });
    for (const id of ['nan', 'inf', 'exp', 'far', 'none']) expect(await place(id)).toBeUndefined();
  });
});

describe('importShare: opening the same share again keeps your edits', () => {
  const cafe = (over: Partial<SharedPayloadV2['items'][number]> = {}): SharedPayloadV2['items'][number] => ({
    t: 'place',
    n: 'Cafe',
    u: 'https://cafe.example/',
    g: ['coffee'],
    p: { lat: 38.7, lng: -9.1 },
    w: { start: '2026-11-01' },
    ...over,
  });
  const share = (items: SharedPayloadV2['items']): SharedPayloadV2 => ({ v: 2, kind: 'collection', shareId: 'c:trip1', from: 'Sam', name: 'Trip', items });

  it("doesn't undo a rename, a new date, place details or a removed tag when nothing changed on your friend's side", async () => {
    await importShare(share([cafe()]));
    const [saved] = await db.items.toArray();
    await updateItem(saved.id, {
      title: 'My cafe name',
      when: { start: '2026-11-05' },
      place: { lat: 38.7, lng: -9.1, city: 'Lisbon', country: 'Portugal', countryCode: 'PT' },
      tags: [],
    });

    const again = share([cafe()]);
    expect((await planImport(again)).rows).toEqual(['have']);
    const res = await importShare(again);
    expect(res).toMatchObject({ added: 0, updated: 0, skipped: 1 });
    expect(await db.items.get(saved.id)).toMatchObject({
      title: 'My cafe name',
      when: { start: '2026-11-05' },
      place: { lat: 38.7, lng: -9.1, city: 'Lisbon', country: 'Portugal', countryCode: 'PT' },
      tags: [],
    });
  });

  it('applies what your friend changed since, and adds details to the same spot without losing yours', async () => {
    await importShare(share([cafe()]));
    const [saved] = await db.items.toArray();
    await updateItem(saved.id, { title: 'My cafe name', place: { lat: 38.7, lng: -9.1, city: 'Lisbon', countryCode: 'PT' } });

    const res = await importShare(share([cafe({ w: { start: '2026-11-08' }, g: ['coffee', 'brunch'], p: { lat: 38.7, lng: -9.1, name: 'Cafe Sol', city: 'Lisboa' } })]));
    expect(res).toMatchObject({ updated: 1 });
    const after = await db.items.get(saved.id);
    expect(after).toMatchObject({ title: 'My cafe name', when: { start: '2026-11-08' }, tags: ['coffee', 'brunch'] });
    expect(after?.place).toEqual({ lat: 38.7, lng: -9.1, city: 'Lisbon', countryCode: 'PT', name: 'Cafe Sol' });

    // Moved to a different spot: the friend's place wins.
    await importShare(share([cafe({ w: { start: '2026-11-08' }, g: ['coffee', 'brunch'], p: { lat: 41.1, lng: -8.6, city: 'Porto' } })]));
    expect((await db.items.get(saved.id))?.place).toEqual({ lat: 41.1, lng: -8.6, city: 'Porto' });
  });

  it('keeps the record of what was shared in backups', async () => {
    await importShare(share([cafe(), { t: 'note', n: 'Pack sunscreen', k: 'abc123' }]));
    const backup = await exportBackup();
    await db.items.clear();
    await importBackup(JSON.parse(JSON.stringify(backup)));
    const items = await db.items.toArray();
    expect(items.find((i) => i.title === 'Cafe')?.from?.shared?.tags).toEqual(['coffee']);
    expect(items.find((i) => i.title === 'Pack sunscreen')?.from?.key).toBe('abc123');
    await importBackup({ ...backup, items: [{ ...backup.items[0], from: { at: 1, key: 'NOT OK!', shared: { sig: { title: 'x y', __proto__: 'a' }, tags: 'nope' } } }] });
    const bad = await db.items.get(backup.items[0].id);
    expect(bad?.from).toEqual({ at: 1, shared: { sig: {}, tags: [] } });
  });
});

describe('importShare: the same friend sharing things different ways', () => {
  const trip: Collection = { ...lisbon, id: 'sam-trip', name: 'Weekend in Lisbon' };
  const tripItems = () => {
    const items = samItems();
    for (const i of items) i.collectionIds = [trip.id];
    return items;
  };

  it("merges a library share into the collection added from Sam's collection link before (and says so)", async () => {
    const items = tripItems();
    const first = await importShare(shareCollection(trip, items, { from: 'Sam' }));
    const other: Collection = { ...lisbon, id: 'sam-other', name: 'Other' };
    const extra = buildItem({ title: 'Tram 28', type: 'place', url: 'https://tram.example/28', collectionIds: [other.id] });
    const lib: SharedPayloadV2 = { ...shareLibrary([...items, extra], [other, trip], { from: 'Sam', includePersonal: true }), shareId: 'l:samsphone' };

    const preview = await planImport(lib);
    const tripKey = lib.collections!.find((c) => c.name === 'Weekend in Lisbon')!.key;
    expect(preview.existingByKey[tripKey]?.id).toBe(first.collectionId);
    expect(preview.rows).toEqual(['have', 'have', 'have', 'new']);

    await importShare(lib);
    const names = (await db.collections.toArray()).map((c) => c.name).sort();
    expect(names).toEqual(['Other', 'Weekend in Lisbon']);
    // The note without a link isn't added twice either.
    expect(await db.items.count()).toBe(4);
    expect((await colItems(first.collectionId!)).map((i) => i.title).sort()).toEqual(['Fado night', 'Pack a jumper', 'Pastéis de Belém']);
  });

  it('works the other way round, and when the order of collections changes', async () => {
    const items = tripItems();
    const other: Collection = { ...lisbon, id: 'sam-other', name: 'Other' };
    await importShare({ ...shareLibrary(items, [trip], { from: 'Sam', includePersonal: true }), shareId: 'l:samsphone' });
    const res = await importShare({ ...shareLibrary(items, [other, trip], { from: 'Sam', includePersonal: true }), shareId: 'l:samsphone' });
    expect(res.added).toBe(0);
    const again = await importShare(shareCollection(trip, items, { from: 'Sam' }));
    expect(await db.collections.count()).toBe(1);
    expect(again).toMatchObject({ added: 0 });
    expect((await db.collections.get(again.collectionId!))?.from?.shareId).toBe('c:sam-trip');
    // Back to the library: still the same collection.
    await importShare({ ...shareLibrary(items, [trip], { from: 'Sam', includePersonal: true }), shareId: 'l:samsphone' });
    expect(await db.collections.count()).toBe(1);
  });

  it('still merges an older library share whose collections carry no fingerprint', async () => {
    const lib = (): SharedPayloadV2 => ({
      v: 2,
      kind: 'library',
      shareId: 'l:old',
      from: 'Sam',
      collections: [{ key: '0', name: 'Trip', emoji: '✈️', color: '#0ea5a4' }],
      items: [{ t: 'link', n: 'A', u: 'https://a.example/', c: ['0'] }],
    });
    await importShare(lib());
    expect((await db.collections.toArray()).map((c) => c.from?.shareId)).toEqual(['l:old:0']);
    const preview = await planImport(lib());
    expect(Object.keys(preview.existingByKey)).toEqual(['0']);
    await importShare(lib());
    expect(await db.collections.count()).toBe(1);
  });

  it('recognises a save without a link from the same friend, but not a stranger’s save with the same key', async () => {
    const note = buildItem({ title: 'Pack sunscreen', type: 'note' });
    await importShare(shareCollection(trip, [note], { from: 'Sam' }));
    await importShare(shareItem(note, { from: 'Sam' }));
    expect(await db.items.count()).toBe(1);
    await importShare(shareItem({ ...note, title: 'Pack sunscreen (SPF 50)' }, { from: 'Sam' }));
    expect(await db.items.count()).toBe(1);
    await importShare(shareItem(note, { from: 'Alex' }));
    expect(await db.items.count()).toBe(2);
  });

  it('knows a short link you saved before it was replaced by where it leads', async () => {
    await addItem({ title: 'Video', type: 'video', url: 'https://www.tiktok.com/@x/video/7234', sharedText: 'https://vm.tiktok.com/ZMabc123/' });
    const p: SharedPayloadV2 = { v: 2, kind: 'item', shareId: 'i:v', from: 'Sam', items: [{ t: 'video', n: 'TikTok', u: 'https://vm.tiktok.com/ZMabc123/' }] };
    expect((await planImport(p)).rows).toEqual(['have']);
    await importShare(p);
    expect(await db.items.count()).toBe(1);
    // A caption that merely mentions a link isn't the save's link.
    await addItem({ title: 'Recipe', type: 'recipe', url: 'https://recipes.example/1', sharedText: 'Pan I use: https://shop.example/pan' });
    const pan: SharedPayloadV2 = { v: 2, kind: 'item', shareId: 'i:p', items: [{ t: 'product', n: 'Pan', u: 'https://shop.example/pan' }] };
    expect((await planImport(pan)).rows).toEqual(['new']);
  });
});

describe('importShare: odd sources', () => {
  it('never stores a source like "__proto__" (it would crash every card showing it)', async () => {
    const res = await importShare({ v: 2, kind: 'item', shareId: 'i:cat', items: [{ t: 'link', n: 'Cute cat', u: 'https://example.com/cat', s: '__proto__' }] });
    expect((await db.items.get(res.itemId!))?.source).toBeUndefined();
    const base = { type: 'link', title: 'T', tags: [], collectionIds: [], status: 'todo', createdAt: 1, updatedAt: 1 };
    await importBackup({ app: 'magpie', version: 1, collections: [], items: [{ ...base, id: 'b1', source: '__proto__' }, { ...base, id: 'b2', source: 'youtube' }] });
    expect((await db.items.get('b1'))?.source).toBeUndefined();
    expect((await db.items.get('b2'))?.source).toBe('youtube');
  });
});

describe('importShare: big shares', () => {
  // Many awaits inside one Dexie transaction used to make it commit early ("Transaction committed too early").
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => buildItem({ title: `Spot ${i}`, type: 'place', url: `https://spots.example/${i}`, tags: ['spot'] }));

  it('imports a 150-save collection in one go', async () => {
    const res = await importShare(await decodeShare(await encodeShare(shareCollection(lisbon, many(150), { from: 'Ana' }))));
    expect(res).toMatchObject({ added: 150, updated: 0, skipped: 0 });
    expect(await colItems(res.collectionId!)).toHaveLength(150);
  });

  it('imports a 300-save library spread over collections', async () => {
    const items = many(300);
    const a: Collection = { ...lisbon, id: 'ana-a', name: 'A' };
    const b: Collection = { ...lisbon, id: 'ana-b', name: 'B' };
    items.forEach((it, i) => (it.collectionIds = i % 3 === 0 ? [] : [i % 3 === 1 ? a.id : b.id]));
    const res = await importShare(shareLibrary(items, [a, b], { from: 'Ana' }));
    expect(res.added).toBe(300);
    expect(await db.items.count()).toBe(300);
    // A, B and the "Ana's saves" collection for the loose ones.
    expect(res.collectionIds).toHaveLength(3);
  });
});
