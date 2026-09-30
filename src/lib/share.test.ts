import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildItem } from './db';
import {
  appUrl,
  backupToPayload,
  decodeShare,
  decodeShareInput,
  encodeShare,
  getDeviceId,
  isWhenString,
  LINK_BUDGET,
  MAX_SHARE_ITEMS,
  normalizePayload,
  parseShareInput,
  payloadEmoji,
  payloadTitle,
  planShare,
  readShareFile,
  shareCollection,
  shareItem,
  shareLibrary,
  shareUrl,
  shortHash,
  slimPayload,
  slugify,
  toShared,
  toShareFile,
  type SharedPayloadV2,
} from './share';
import { findSharePayload } from './receive';
import type { Collection, Item } from './types';

const BASE = 'https://me.example/magpie/';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function toB64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deflateB64(s: string): Promise<string> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Incompressible text, so tests can control link length. */
function noise(n: number): string {
  let out = '';
  while (out.length < n) out += Math.random().toString(36).slice(2);
  return out.slice(0, n);
}

const col = (over: Partial<Collection> = {}): Collection => ({
  id: 'c1',
  name: 'Weekend in Lisbon',
  emoji: '🇵🇹',
  color: '#0ea5a4',
  kind: 'manual',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const pasteis = (): Item =>
  buildItem({
    title: 'Pastéis de Belém',
    type: 'place',
    url: 'https://pasteisdebelem.pt/',
    image: 'https://img.example/pastel.jpg',
    description: 'Famous custard tarts since 1837.',
    siteName: 'Pastéis de Belém',
    tags: ['food', 'lisbon'],
    note: 'Go early, queue is huge',
    status: 'done',
    rating: 5,
    review: 'Best tarts ever',
    place: { lat: 38.6975123456, lng: -9.2032, name: 'Pastéis de Belém', city: 'Lisbon', country: 'Portugal', countryCode: 'PT', address: 'R. de Belém 84-92' },
    sharedText: 'Check this out! https://pasteisdebelem.pt/',
    collectionIds: ['c1'],
  });

const fado = (): Item =>
  buildItem({
    title: 'Fado night',
    type: 'event',
    url: 'https://tickets.example/fado?utm_source=x',
    when: { start: '2026-10-12T19:30', end: '2026-10-12T22:00', source: 'Mon 12 Oct 7:30pm' },
    collectionIds: ['c1'],
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('v1 links', () => {
  it('still decode, as a normalised v2 collection', async () => {
    const payload = await encodeShare(toShared(col(), [pasteis(), fado()]));
    const d = await decodeShare(payload);
    expect(d.v).toBe(2);
    expect(d.kind).toBe('collection');
    expect(d.name).toBe('Weekend in Lisbon');
    expect(d.emoji).toBe('🇵🇹');
    expect(d.color).toBe('#0ea5a4');
    expect(d.items).toHaveLength(2);
    expect(d.items[0]).toMatchObject({ t: 'place', n: 'Pastéis de Belém', u: 'https://pasteisdebelem.pt/', d: 'Go early, queue is huge' });
    expect(d.shareId).toMatch(/^v1:/);
    // Same link → same id, so opening it twice merges.
    expect((await decodeShare(payload)).shareId).toBe(d.shareId);
  });

  it('decode the plain-JSON "j" format too', async () => {
    const v1 = { v: 1, name: 'Old', emoji: '📌', color: '#6d5dfc', items: [{ t: 'link', n: 'A' }] };
    const d = await decodeShare(`j${toB64Url(JSON.stringify(v1))}`);
    expect(d).toMatchObject({ v: 2, kind: 'collection', name: 'Old', items: [{ t: 'link', n: 'A' }] });
  });
});

describe('v2 round trips', () => {
  it('item: keeps place details, dates, the original post — but not personal notes by default', async () => {
    const item = pasteis();
    const p = shareItem(item, { from: '  Sam  ' });
    expect(p).toMatchObject({ v: 2, kind: 'item', shareId: `i:${item.id}`, from: 'Sam' });
    const s = p.items[0];
    expect(s.p).toEqual({ lat: 38.697512, lng: -9.2032, name: 'Pastéis de Belém', city: 'Lisbon', country: 'Portugal', countryCode: 'PT', address: 'R. de Belém 84-92' });
    expect(s.x).toBe('Check this out! https://pasteisdebelem.pt/');
    expect(s.ds).toBe('Famous custard tarts since 1837.');
    expect(s.sn).toBe('Pastéis de Belém');
    expect(s.g).toEqual(['food', 'lisbon']);
    expect(s.d).toBeUndefined();
    expect(s.r).toBeUndefined();
    expect(s.rv).toBeUndefined();
    expect(s.st).toBeUndefined();

    const back = await decodeShare(await encodeShare(p));
    expect(back).toEqual(p);
  });

  it('item: includes notes, rating, review and status when opted in', () => {
    const s = shareItem(pasteis(), { includePersonal: true }).items[0];
    expect(s).toMatchObject({ d: 'Go early, queue is huge', r: 5, rv: 'Best tarts ever', st: 'done' });
  });

  it("item: a note's text is its content, so it's always shared", () => {
    const note = buildItem({ title: 'Packing list', type: 'note', note: 'Sunscreen, hat' });
    expect(shareItem(note).items[0].d).toBe('Sunscreen, hat');
  });

  it('item: event dates travel without the parsed phrase', async () => {
    const back = await decodeShare(await encodeShare(shareItem(fado())));
    expect(back.items[0].w).toEqual({ start: '2026-10-12T19:30', end: '2026-10-12T22:00' });
  });

  it('collection: stable id, name, emoji, colour and items', async () => {
    const c = col();
    const p = shareCollection(c, [pasteis(), fado()], { from: 'Sam' });
    expect(p.shareId).toBe('c:c1');
    expect(shareCollection(c, []).shareId).toBe('c:c1');
    const back = await decodeShare(await encodeShare(p));
    expect(back).toEqual(p);
    expect(back.collections).toBeUndefined();
  });

  it('library: collections get short keys; smart collections are resolved; empty ones are skipped', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const a = pasteis();
    const b = fado();
    const loose = buildItem({ title: 'Loose', type: 'link', url: 'https://loose.example/' });
    const cols: Collection[] = [
      col(),
      col({ id: 'c2', name: 'Empty', emoji: '🫙' }),
      col({ id: 'c3', name: 'Events', emoji: '🎟️', kind: 'smart', rules: { tags: [], match: 'any', types: ['event'], status: 'any' } }),
    ];
    const p = shareLibrary([a, b, loose], cols, { from: 'Sam' });
    expect(p.kind).toBe('library');
    expect(p.collections).toEqual([
      { key: '0', name: 'Weekend in Lisbon', emoji: '🇵🇹', color: '#0ea5a4', id: shortHash(cols[0].id) },
      { key: '1', name: 'Events', emoji: '🎟️', color: '#0ea5a4', id: shortHash('c3') },
    ]);
    expect(p.items.map((i) => i.c)).toEqual([['0'], ['0', '1'], undefined]);
    const back = await decodeShare(await encodeShare(p));
    expect(back).toEqual(p);
  });
});

describe('share ids', () => {
  it('library ids use a per-device id kept in localStorage', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const id = getDeviceId();
    expect(id).toMatch(/^[a-z0-9]{6,40}$/);
    expect(getDeviceId()).toBe(id);
    expect(storage.getItem('magpie:device-id')).toBe(id);
    expect(shareLibrary([], []).shareId).toBe(`l:${id}`);
    expect(shareLibrary([pasteis()], [col()]).shareId).toBe(`l:${id}`);
  });

  it('survive when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const id = getDeviceId();
    expect(id).toMatch(/^[a-z0-9]+$/);
    expect(getDeviceId()).toBe(id);
  });
});

describe('normalizePayload', () => {
  it('rejects things that are not shares', () => {
    for (const bad of [null, 42, 'x', [], {}, { v: 3, items: [] }, { v: 2, kind: 'bogus', items: [] }, { v: 2, kind: 'collection' }, { v: 1, items: [] }]) {
      expect(() => normalizePayload(bad)).toThrow();
    }
    expect(() => normalizePayload({ v: 2, kind: 'item', shareId: 'i:1', items: [] })).toThrow(/empty/);
  });

  it('cleans up hostile or broken values', () => {
    const p = normalizePayload({
      v: 2,
      kind: 'library',
      shareId: '<script>',
      from: '  Mallory  ',
      color: 'red; background:url(x)',
      collections: [
        { key: 'a', name: 'Good', emoji: '✅', color: '#fff' },
        { key: 'a', name: 'Duplicate key' },
        { key: '../evil', name: 'Bad key' },
      ],
      items: [
        {
          t: 'virus',
          n: 'x'.repeat(1000),
          g: ['ok', 7, null],
          w: { start: '2026-02-30' },
          p: { lat: 999, lng: 0 },
          c: ['a', 'zzz'],
          st: 'maybe',
          r: 'five',
        },
        { t: 'event', n: 'Gig', w: { start: '2026-10-12T19:30', end: '2026-10-11' }, p: { lat: 1, lng: 2, countryCode: 'Portugal' } },
        'not an item',
      ],
    });
    expect(p.shareId).toMatch(/^h:/);
    expect(p.from).toBe('Mallory');
    expect(p.color).toBeUndefined();
    expect(p.collections).toEqual([{ key: 'a', name: 'Good', emoji: '✅', color: '#fff' }]);
    expect(p.items).toHaveLength(2);
    const [a, b] = p.items;
    expect(a.t).toBe('link');
    expect(Array.from(a.n)).toHaveLength(300);
    expect(a.g).toEqual(['ok']);
    expect(a.w).toBeUndefined();
    expect(a.p).toBeUndefined();
    expect(a.c).toEqual(['a']);
    expect(a.st).toBeUndefined();
    expect(a.r).toBeUndefined();
    expect(b.w).toEqual({ start: '2026-10-12T19:30' });
    expect(b.p).toEqual({ lat: 1, lng: 2 });
  });

  it('keeps event ends only when they come after the start', () => {
    const w = (start: string, end: string) => normalizePayload({ v: 2, kind: 'item', shareId: 'i:1', items: [{ t: 'event', n: 'E', w: { start, end } }] }).items[0].w;
    expect(w('2026-10-12T19:30', '2026-10-12T22:00')).toEqual({ start: '2026-10-12T19:30', end: '2026-10-12T22:00' });
    expect(w('2026-10-12T19:30', '2026-10-12T18:00')).toEqual({ start: '2026-10-12T19:30' });
    expect(w('2026-10-12T19:30', '2026-10-12')).toEqual({ start: '2026-10-12T19:30', end: '2026-10-12' });
    expect(w('2026-10-12', '2026-10-14T10:00')).toEqual({ start: '2026-10-12', end: '2026-10-14T10:00' });
    expect(w('2026-10-12', '2026-10-11')).toEqual({ start: '2026-10-12' });
  });

  it('never splits an emoji when clipping', () => {
    const p = normalizePayload({ v: 2, kind: 'collection', shareId: 'c:1', emoji: '👨‍👩‍👧‍👦👨‍👩‍👧‍👦', items: [] });
    expect(p.emoji && /[\uD800-\uDBFF]$/.test(p.emoji)).toBe(false);
  });

  it('validates event dates', () => {
    expect(isWhenString('2026-10-12')).toBe(true);
    expect(isWhenString('2026-10-12T23:59')).toBe(true);
    expect(isWhenString('2028-02-29')).toBe(true);
    expect(isWhenString('2026-02-29')).toBe(false);
    expect(isWhenString('2026-13-01')).toBe(false);
    expect(isWhenString('2026-10-12T24:00')).toBe(false);
    expect(isWhenString('2026-10-12T19:30:00')).toBe(false);
    expect(isWhenString('tomorrow')).toBe(false);
    expect(isWhenString(20261012)).toBe(false);
  });
});

describe('decodeShare', () => {
  it('ignores punctuation stuck to the end of a pasted link', async () => {
    const payload = await encodeShare(shareItem(pasteis()));
    expect((await decodeShare(`${payload}).`)).kind).toBe('item');
  });

  it('rejects garbage, truncated links and zip bombs', async () => {
    await expect(decodeShare('')).rejects.toThrow();
    await expect(decodeShare('xabc')).rejects.toThrow();
    await expect(decodeShare('zzzz')).rejects.toThrow();
    const payload = await encodeShare(shareCollection(col(), [pasteis(), fado()]));
    await expect(decodeShare(payload.slice(0, Math.floor(payload.length / 2)))).rejects.toThrow();
    const bomb = await deflateB64(`{"v":2,"kind":"item","shareId":"i:1","items":[{"t":"link","n":"${' '.repeat(17 * 1024 * 1024)}"}]}`);
    await expect(decodeShare(`z${bomb}`)).rejects.toThrow(/too big/);
  });

  it('builds share URLs on the app page', async () => {
    expect(shareUrl('zabc', 'https://me.example/magpie/?x=1#/collections/c1')).toBe('https://me.example/magpie/#/import/zabc');
  });
});

describe('planShare', () => {
  it('uses the full payload when it fits', async () => {
    const plan = await planShare(shareItem(pasteis()), BASE);
    expect(plan.slim).toBe(false);
    expect(plan.tooLong).toBe(false);
    expect(plan.url).toMatch(/^https:\/\/me\.example\/magpie\/#\/import\/z[A-Za-z0-9_-]+$/);
    expect(plan.length).toBe(plan.url!.length);
    expect(plan.length).toBeLessThanOrEqual(LINK_BUDGET);
    const back = await decodeShare(parseShareInput(plan.url)!);
    expect(back.items[0].i).toBe('https://img.example/pastel.jpg');
  });

  it('slims big shares (no images, descriptions or original posts; short notes)', async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      buildItem({
        title: `Place ${i}`,
        type: 'place',
        url: `https://example.com/place/${i}`,
        image: `https://images.example.com/${noise(60)}.jpg`,
        description: noise(150),
        sharedText: noise(80),
      }),
    );
    const plan = await planShare(shareCollection(col(), items), BASE);
    expect(plan.tooLong).toBe(false);
    expect(plan.slim).toBe(true);
    expect(plan.url!.length).toBeLessThanOrEqual(LINK_BUDGET);
    const back = await decodeShare(parseShareInput(plan.url)!);
    expect(back.items).toHaveLength(12);
    expect(back.items.every((s) => !s.i && !s.ds && !s.x)).toBe(true);
    expect(back.items[3].u).toBe('https://example.com/place/3');
  });

  it('says tooLong when even the slim link is over budget', async () => {
    const items = Array.from({ length: 100 }, (_, i) => buildItem({ title: `Item ${i} ${noise(12)}`, type: 'link', url: `https://example.com/${noise(12)}` }));
    const plan = await planShare(shareCollection(col(), items), BASE);
    expect(plan.tooLong).toBe(true);
    expect(plan.slim).toBe(true);
    expect(plan.url).toBeUndefined();
    expect(plan.length).toBeGreaterThan(LINK_BUDGET);
  });

  it('slimPayload truncates long notes and reviews to 280 characters', () => {
    const p = shareItem(buildItem({ title: 'T', type: 'note', note: 'n'.repeat(1000), image: 'https://x.example/i.png' }));
    const slim = slimPayload(p);
    expect(Array.from(slim.items[0].d!)).toHaveLength(280);
    expect(slim.items[0].d!.endsWith('…')).toBe(true);
    expect(slim.items[0].i).toBeUndefined();
    expect(p.items[0].i).toBe('https://x.example/i.png'); // original untouched
  });
});

describe('parseShareInput', () => {
  it('finds the payload in links and messages', async () => {
    const payload = await encodeShare(shareItem(pasteis()));
    const url = shareUrl(payload, BASE);
    expect(parseShareInput(url)).toBe(payload);
    expect(parseShareInput(`🍮 Pastéis\nhttps://pasteisdebelem.pt/\n\nAdd it to your Magpie: ${url}`)).toBe(payload);
    expect(parseShareInput(url.replace('#', '%23'))).toBe(payload);
    expect(parseShareInput(`https://l.facebook.com/l.php?u=${encodeURIComponent(url)}&h=AT0`)).toBe(payload);
    expect(parseShareInput(`  ${payload}  `)).toBe(payload);
    expect(parseShareInput('https://example.com/#/item/123')).toBeUndefined();
    expect(parseShareInput('zebra')).toBeUndefined();
    expect(parseShareInput('')).toBeUndefined();
    expect(parseShareInput(undefined)).toBeUndefined();
    expect((await decodeShareInput(`look: ${url}`)).kind).toBe('item');
    await expect(decodeShareInput('no link here')).rejects.toThrow(/Magpie link/);
  });

  it("doesn't mistake a lone word shared from another app for a share", async () => {
    const payload = await encodeShare(shareItem(pasteis()));
    const url = shareUrl(payload, BASE);
    // What the service worker / GET share handling sees: "<url>\n<text>\n<title>".
    for (const word of ['justsomerandomword', 'zebrasAreAwesome123', 'j'.repeat(39), `z${'a'.repeat(38)}`]) {
      expect(findSharePayload(word)).toBeUndefined();
      expect(findSharePayload(`\n${word}\n`)).toBeUndefined();
      expect(parseShareInput(word, { bare: false })).toBeUndefined();
      expect(parseShareInput(word)).toBeUndefined(); // too short to be a payload even when pasted on its own
    }
    expect(payload.length).toBeGreaterThanOrEqual(40);
    expect(findSharePayload(payload)).toBeUndefined();
    expect(findSharePayload(payload, true)).toBe(payload);
    expect(parseShareInput(payload, { bare: false })).toBeUndefined();
    expect(parseShareInput(`\n${payload}\n`)).toBe(payload);
    // Links are always found.
    expect(findSharePayload(`\nSam sent you this: ${url}\nMagpie`)).toBe(payload);
    expect(parseShareInput(url, { bare: false })).toBe(payload);
    // A file with only a payload in it isn't a share file.
    await expect(readShareFile(new Blob([payload], { type: 'text/plain' }))).rejects.toThrow(/Magpie share/);
  });
});

describe('share files', () => {
  it('writes a pretty .magpie.json file at full fidelity', async () => {
    const p = shareCollection(col(), [pasteis(), fado()], { from: 'Sam', includePersonal: true });
    const file = toShareFile(p);
    expect(file.name).toBe('weekend-in-lisbon.magpie.json');
    expect(file.type).toBe('application/json');
    const text = await file.text();
    expect(text).toContain('\n  "app": "magpie-share"');
    expect(JSON.parse(text)).toEqual({ app: 'magpie-share', ...p });
    expect(await readShareFile(file)).toEqual(p);

    const txt = toShareFile(p, 'text');
    expect(txt.name).toBe('weekend-in-lisbon.magpie.txt');
    expect(txt.type).toBe('text/plain');
    expect(await readShareFile(txt)).toEqual(p);
  });

  it('slugs file names', () => {
    expect(slugify('Café & Crème — Paris!')).toBe('cafe-creme-paris');
    expect(slugify('🎉🎉')).toBe('magpie-share');
    expect(slugify('東京 ラーメン')).toBe('東京-ラーメン');
    expect(toShareFile(shareItem(buildItem({ title: '', type: 'link' }))).name).toBe('magpie-share.magpie.json');
  });

  it('reads full backups as a library share (with notes and ratings)', async () => {
    const backup = {
      app: 'magpie',
      version: 1,
      exportedAt: '2026-09-01T10:00:00.000Z',
      items: [
        { ...pasteis(), collectionIds: ['c1'] },
        { ...fado(), collectionIds: [] },
        { id: 'weird', type: 'nope', title: 42, tags: 'x', place: { lat: 'a' } },
        'junk',
      ],
      collections: [col(), { id: 'c9', name: 'Smart', kind: 'smart', rules: { tags: [], match: 'any', types: ['event'], status: 'any' } }, { name: 'no id' }],
    };
    const p = await readShareFile(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    expect(p.kind).toBe('library');
    expect(p.shareId).toMatch(/^b:/);
    expect(p.collections?.map((c) => c.name)).toEqual(['Weekend in Lisbon', 'Smart']);
    expect(p.items).toHaveLength(3);
    expect(p.items[0]).toMatchObject({ n: 'Pastéis de Belém', r: 5, st: 'done', c: ['0'] });
    expect(p.items[1]).toMatchObject({ n: 'Fado night', c: ['1'] });
    expect(p.items[2]).toMatchObject({ t: 'link', n: 'Untitled' });
    expect(p.items[2].p).toBeUndefined();
    // Same backup → same id.
    expect(backupToPayload(backup).shareId).toBe(p.shareId);
  });

  it("doesn't mix up backup items that have no id", () => {
    const p = backupToPayload({
      app: 'magpie',
      items: [
        { title: 'In the collection', collectionIds: ['c1'] },
        { title: 'Not in it', collectionIds: [] },
      ],
      collections: [col()],
    });
    expect(p.items.map((i) => i.c)).toEqual([['0'], undefined]);
  });

  it('reads text files with a Magpie link, and rejects everything else', async () => {
    const url = shareUrl(await encodeShare(shareItem(fado())), BASE);
    const fromText = await readShareFile(new Blob([`Sam sent you this:\n${url}\n`], { type: 'text/plain' }));
    expect(fromText.items[0].n).toBe('Fado night');
    await expect(readShareFile(new Blob(['hello world']))).rejects.toThrow(/Magpie share/);
    await expect(readShareFile(new Blob(['{"app":"other","items":[]}']))).rejects.toThrow(/Magpie share/);
    await expect(readShareFile(new Blob([new Uint8Array([0, 159, 146, 150])]))).rejects.toThrow();
  });
});

describe('titles', () => {
  it('names shares for people', () => {
    const lib: SharedPayloadV2 = { v: 2, kind: 'library', shareId: 'l:x', from: 'Sam', items: [] };
    expect(payloadTitle(lib)).toBe("Sam's saves");
    expect(payloadTitle({ ...lib, from: undefined })).toBe('Shared saves');
    expect(payloadEmoji(lib)).toBe('📚');
    const item = shareItem(fado());
    expect(payloadTitle(item)).toBe('Fado night');
    expect(payloadEmoji(item)).toBe('🎟️');
    const c = shareCollection(col(), []);
    expect(payloadTitle(c)).toBe('Weekend in Lisbon');
    expect(payloadEmoji(c)).toBe('🇵🇹');
  });
});

describe('privacy and safety of what goes out', () => {
  it("takes per-sharer tracking tokens out of links and the original post, and leaves clean links as they are", () => {
    const reel = buildItem({
      title: 'Reel',
      type: 'video',
      url: 'https://www.instagram.com/reel/x/?igsh=TOKEN123&utm_source=ig_web',
      sharedText: 'So good! https://www.instagram.com/reel/x/?igsh=TOKEN123. Also https://youtu.be/abc?si=XYZ&t=42',
    });
    const [s] = shareItem(reel).items;
    expect(s.u).toBe('https://www.instagram.com/reel/x/');
    expect(s.x).toBe('So good! https://www.instagram.com/reel/x/. Also https://youtu.be/abc?t=42');
    const clean = buildItem({ title: 'Clean', type: 'link', url: 'https://example.com/a?b=1&c=%20', sharedText: 'see https://example.com/a?b=1' });
    expect(shareItem(clean).items[0]).toMatchObject({ u: 'https://example.com/a?b=1&c=%20', x: 'see https://example.com/a?b=1' });
  });

  it('gives saves without a link a short key, so they are recognised in the same friend’s other shares', () => {
    const note = buildItem({ title: 'Pack sunscreen', type: 'note' });
    expect(shareItem(note).items[0].k).toBe(shortHash(note.id));
    expect(shareItem(pasteis()).items[0].k).toBeUndefined();
  });

  it('leaves text notes out of a library share unless notes are included; a collection or a single note keeps them', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const secret = buildItem({ title: 'Door code 4821', type: 'note', note: 'wifi pass hunter2' });
    const items = [pasteis(), secret];
    expect(shareLibrary(items, []).items.map((i) => i.n)).toEqual(['Pastéis de Belém']);
    expect(shareLibrary(items, [], { includePersonal: true }).items.map((i) => i.n)).toEqual(['Pastéis de Belém', 'Door code 4821']);
    expect(shareCollection(col(), items).items.map((i) => i.n)).toEqual(['Pastéis de Belém', 'Door code 4821']);
    expect(shareItem(secret).items[0]).toMatchObject({ n: 'Door code 4821', d: 'wifi pass hunter2' });
  });

  it('sends at most MAX_SHARE_ITEMS saves, and says how many a bigger share had when opening it', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const many = Array.from({ length: MAX_SHARE_ITEMS + 5 }, (_, i) => buildItem({ title: `Link ${i}`, type: 'link', url: `https://ex.example/${i}` }));
    const p = shareLibrary(many, []);
    expect(p.items).toHaveLength(MAX_SHARE_ITEMS);
    expect(p.items[0].n).toBe('Link 0');
    const big = normalizePayload({ ...p, items: many.map((i) => ({ t: 'link', n: i.title, u: i.url })) });
    expect(big.items).toHaveLength(MAX_SHARE_ITEMS);
    expect(big.total).toBe(MAX_SHARE_ITEMS + 5);
    expect(normalizePayload(p).total).toBeUndefined();
  });

  it('drops sources that are not plain ids (e.g. "__proto__")', () => {
    const p = normalizePayload({
      v: 2,
      kind: 'collection',
      shareId: 'c:x',
      items: [
        { t: 'link', n: 'A', s: '__proto__' },
        { t: 'link', n: 'B', s: 'constructor' },
        { t: 'link', n: 'C', s: 'google-maps' },
        { t: 'link', n: 'D', s: 'Not An Id!' },
      ],
    });
    expect(p.items.map((i) => i.s)).toEqual([undefined, 'constructor', 'google-maps', undefined]);
  });

  it('knows the app address without the route', () => {
    expect(appUrl('https://me.example/magpie/?x=1#/import/zabc')).toBe('https://me.example/magpie/');
  });
});
