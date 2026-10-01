import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./enrich', () => ({ enrichItem: vi.fn(async () => {}) }));

import { buildItem, db, saveItem } from './db';
import { isAlreadySaved } from './dbHealth';
import {
  clearDrafts,
  confirmDraft,
  draftFor,
  findDraft,
  forgetDraft,
  isConfirmed,
  markSaving,
  rememberDraft,
  resetDrafts,
  settleDrafts,
  type UnsavedDraft,
} from './drafts';
import { enrichItem } from './enrich';

const enrich = vi.mocked(enrichItem);
const KEY = 'magpie:unsaved-drafts';

/** A sessionStorage that lives as long as the test (Node has none). */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
  };
}

function draft(over: Partial<UnsavedDraft> = {}): UnsavedDraft {
  return {
    id: over.id ?? buildItem({ type: 'note', title: '' }).id,
    text: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    handed: ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    type: 'video',
    title: 'My title',
    tags: null,
    note: null,
    when: null,
    place: { value: undefined },
    collectionIds: ['c1'],
    enrich: { replaceTitle: false, reclassify: false, dates: true, locate: false },
    at: Date.now(),
    ...over,
  };
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('sessionStorage', storage);
  resetDrafts();
  enrich.mockClear();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.items.clear();
});

describe('unsaved drafts', () => {
  it('keeps a draft, with what the user chose, until it is forgotten', () => {
    const d = draft();
    rememberDraft(d);
    expect(findDraft(d.id)).toEqual(d);
    expect(JSON.parse(storage.getItem(KEY)!)).toEqual([d]);
    // Remembering it again (a second attempt) replaces it.
    rememberDraft({ ...d, title: 'Edited' });
    expect(JSON.parse(storage.getItem(KEY)!)).toHaveLength(1);
    expect(findDraft(d.id)?.title).toBe('Edited');
    forgetDraft(d.id);
    expect(findDraft(d.id)).toBeUndefined();
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('survives a reload of the tab', () => {
    const d = draft();
    rememberDraft(d);
    resetDrafts(); // what's in memory is gone…
    storage.setItem(KEY, JSON.stringify([d])); // …what's in sessionStorage isn't
    expect(findDraft(d.id)?.collectionIds).toEqual(['c1']);
  });

  it('finds the latest draft with the same text, so sharing it again reuses the id', () => {
    const a = draft({ at: 1 });
    const b = draft({ at: 2 });
    rememberDraft(a);
    rememberDraft(b);
    expect(draftFor(`  ${a.text}\n`)?.id).toBe(b.id);
    expect(draftFor('something else')).toBeUndefined();
    expect(draftFor('')).toBeUndefined();
  });

  it('lets go of old drafts and keeps only a few', () => {
    storage.setItem(KEY, JSON.stringify([draft({ id: 'old', at: Date.now() - 2 * 86400000 })]));
    expect(findDraft('old')).toBeUndefined();
    for (let i = 0; i < 8; i++) rememberDraft(draft({ id: `d${i}` }));
    expect(JSON.parse(storage.getItem(KEY)!).map((d: UnsavedDraft) => d.id)).toEqual(['d3', 'd4', 'd5', 'd6', 'd7']);
  });

  it('notices a draft whose write landed after all: fetches its preview once, then lets it go', async () => {
    const missing = draft({ at: 1 });
    const landed = draft({ at: 2 });
    rememberDraft(missing);
    rememberDraft(landed);
    await db.items.put({ ...buildItem({ type: 'video', title: 'My title' }), id: landed.id });
    expect(await settleDrafts()).toEqual([landed.id]);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith(landed.id, landed.enrich);
    expect(findDraft(landed.id)).toBeUndefined();
    expect(isConfirmed(landed.id)).toBe(true);
    // Sharing the same text again picks the draft that's still unsaved, never the one in the library.
    expect(draftFor(landed.text)?.id).toBe(missing.id);
    // Already handled: not asked again.
    expect(await settleDrafts()).toEqual([]);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(findDraft(missing.id)).toBeDefined();
    expect(isConfirmed(missing.id)).toBe(false);
  });

  it("doesn't offer a saved draft's id for the same text shared again", async () => {
    const d = draft();
    rememberDraft(d);
    confirmDraft(d.id); // its save went through
    expect(draftFor(d.text)).toBeUndefined();
    expect(JSON.parse(storage.getItem(KEY) ?? '[]')).toEqual([]);
  });

  it('forgets every draft when everything is deleted', () => {
    rememberDraft(draft({ id: 'a' }));
    rememberDraft(draft({ id: 'b', text: 'Pasta night' }));
    clearDrafts();
    expect(findDraft('a')).toBeUndefined();
    expect(draftFor('Pasta night')).toBeUndefined();
    expect(storage.getItem(KEY)).toBeNull();
    // Still gone after a reload of the tab.
    resetDrafts();
    expect(findDraft('b')).toBeUndefined();
  });

  it('leaves a draft that is still being saved to its save', async () => {
    const d = draft();
    rememberDraft(d);
    markSaving(d.id, true);
    await db.items.put({ ...buildItem({ type: 'video', title: 'x' }), id: d.id });
    expect(await settleDrafts()).toEqual([]);
    markSaving(d.id, false);
    expect(await settleDrafts()).toEqual([d.id]);
  });

  it('gives up for now when storage still doesn’t answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    rememberDraft(draft());
    vi.spyOn(db.items, 'get').mockImplementation(() => new Promise(() => {}) as never);
    const p = settleDrafts();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual([]);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe('saving a draft again', () => {
  it("never writes over a save that's already in the library under the same id", async () => {
    // A failed save whose write landed later, and was then edited, rated and reviewed.
    const id = buildItem({ type: 'link', title: '' }).id;
    const edited = {
      ...buildItem({ type: 'link', title: 'My edited title', tags: ['mine'], url: 'https://example.com/a' }, Date.now() - 86400000),
      id,
      status: 'done' as const,
      rating: 5,
      review: 'Loved it',
    };
    await db.items.add(edited);
    const again = { ...buildItem({ type: 'link', title: 'example.com', url: 'https://example.com/a' }), id };
    const e = await saveItem(again).catch((err: unknown) => err);
    expect(isAlreadySaved(e)).toBe(true);
    expect(await db.items.get(id)).toEqual(edited);
  });

  it('saves a draft whose earlier write never landed, under its id', async () => {
    const item = buildItem({ type: 'note', title: 'Pasta night' });
    await expect(saveItem(item)).resolves.toBe(item);
    expect(await db.items.get(item.id)).toEqual(item);
  });
});
