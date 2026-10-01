import 'fake-indexeddb/auto';
import { Dexie, liveQuery, type EntityTable } from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardQuerier } from './live';
import {
  CHECK_DELAYS_MS,
  formatDiagnostics,
  isAlreadySaved,
  isStorageFailure,
  monitorDb,
  PROBE_TIMEOUT_MS,
  REOPEN_TIMEOUT_MS,
  RESUME_PROBE_MS,
  RETRY_TIMEOUT_MS,
  SAVE_BUDGET_MS,
  SAVE_TIMEOUT_MS,
  saveWithRetry,
  SLOW_MS,
  STUCK_MS,
  TimeoutError,
  withTimeout,
  type DbMonitor,
  type VisibilitySource,
} from './dbHealth';

interface Row {
  id: string;
  n?: number;
}
type TestDb = Dexie & { rows: EntityTable<Row, 'id'> };

const realIDB = indexedDB;
let seq = 0;
const cleanup: (() => unknown)[] = [];

/** An IndexedDB whose open() can be made to hang, like WebKit's stalled connections. */
function stallableIDB() {
  const ctl = { stall: false, opens: 0 };
  const factory = {
    open: (name: string, version?: number) => {
      ctl.opens++;
      // Dexie sets its handlers on this and waits; nothing ever fires.
      if (ctl.stall) return {} as IDBOpenDBRequest;
      return version === undefined ? realIDB.open(name) : realIDB.open(name, version);
    },
    deleteDatabase: (name: string) => realIDB.deleteDatabase(name),
    cmp: (a: unknown, b: unknown) => realIDB.cmp(a, b),
    databases: () => realIDB.databases(),
  };
  return { ctl, factory: factory as unknown as IDBFactory };
}

/** WebKit's lost connection as it usually shows: every request fails at once with UnknownError. */
const lostError = () =>
  Object.assign(new Error('Connection to Indexed Database server lost. Refresh the page to try again'), { name: 'UnknownError' });

/** Makes the database's reads and writes fail with UnknownError while `ctl.failing` is set. */
function failRequests(db: Dexie) {
  const ctl = { failing: false, failed: 0 };
  db.use({
    stack: 'dbcore',
    name: 'fail-requests',
    create: (down) => ({
      ...down,
      table: (name) => {
        const table = down.table(name);
        const fail = <T>(run: () => Promise<T>): Promise<T> => {
          if (!ctl.failing) return run();
          ctl.failed++;
          return Promise.reject(lostError());
        };
        return {
          ...table,
          mutate: (req) => fail(() => table.mutate(req)),
          get: (req) => fail(() => table.get(req)),
          getMany: (req) => fail(() => table.getMany(req)),
          query: (req) => fail(() => table.query(req)),
          count: (req) => fail(() => table.count(req)),
        };
      },
    }),
  });
  return ctl;
}

function makeDb(opts: { indexedDB?: IDBFactory; doc?: VisibilitySource; probe?: () => PromiseLike<unknown> } = {}) {
  const name = `health-${++seq}`;
  const db = new Dexie(name, opts.indexedDB ? { indexedDB: opts.indexedDB, IDBKeyRange } : undefined) as TestDb;
  db.version(1).stores({ rows: 'id' });
  const mon = monitorDb(db, { probe: opts.probe ?? (() => db.rows.count()), doc: opts.doc });
  cleanup.push(() => {
    mon.dispose();
    db.close();
    return Dexie.delete(name);
  });
  return { db, mon, name };
}

const status = (mon: DbMonitor) => mon.getSnapshot().status;

/** Fake time moving on in small steps, letting IndexedDB's own (real) tasks run in between. */
async function advanceSlowly(ms: number, step = 250) {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - t));
    await new Promise((r) => setImmediate(r));
  }
}
const kinds = (mon: DbMonitor) => mon.getSnapshot().events.map((e) => e.kind);

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('passes the value or error through when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('nope')), 100)).rejects.toThrow('nope');
  });

  it('rejects with a TimeoutError naming the step once time is up', async () => {
    const p = withTimeout(new Promise(() => {}), 8000, 'Saving');
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(7999);
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await caught;
    expect(e).toBeInstanceOf(TimeoutError);
    expect((e as Error).name).toBe('TimeoutError');
    expect((e as Error).message).toBe('Saving took longer than 8 s');
    expect(isStorageFailure(e)).toBe(true);
  });

  it('clears its timer once settled', async () => {
    await withTimeout(Promise.resolve(1), 5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('saveWithRetry', () => {
  const item = { id: 'abc', title: 'Pasta' };
  const never = () => new Promise<never>(() => {});

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('saves straight away when the write works', async () => {
    const ops = { write: vi.fn(async () => {}), get: vi.fn(), recover: vi.fn(async () => {}) };
    await expect(saveWithRetry(item, ops)).resolves.toBe(item);
    expect(ops.write).toHaveBeenCalledTimes(1);
    expect(ops.recover).not.toHaveBeenCalled();
  });

  it('reopens and retries once when the write hangs', async () => {
    const add = vi.fn().mockImplementationOnce(never).mockResolvedValueOnce(undefined);
    const ops = { write: add, get: vi.fn(async () => undefined), recover: vi.fn(async () => {}) };
    const p = saveWithRetry(item, ops);
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await expect(p).resolves.toBe(item);
    expect(ops.recover).toHaveBeenCalledTimes(1);
    expect(ops.get).toHaveBeenCalledWith('abc');
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenLastCalledWith(item);
  });

  it("doesn't write again when the first write landed late", async () => {
    const add = vi.fn(never);
    const ops = { write: add, get: vi.fn(async () => item), recover: vi.fn(async () => {}) };
    const p = saveWithRetry(item, ops);
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await expect(p).resolves.toBe(item);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("says already saved when the retry finds an earlier save under the same id, and doesn't write over it", async () => {
    const add = vi.fn(never);
    const earlier = { id: 'abc', title: 'Pasta, edited since' };
    const ops = { write: add, get: vi.fn(async () => earlier), recover: vi.fn(async () => {}), isSame: (s: typeof item, i: typeof item) => s === i };
    const caught = saveWithRetry(item, ops).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    expect(isAlreadySaved(await caught)).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('passes an id that is already taken straight through, without retrying', async () => {
    const dup = Object.assign(new Error('Key already exists'), { name: 'ConstraintError' });
    const ops = { write: vi.fn(async () => Promise.reject(dup)), get: vi.fn(), recover: vi.fn(async () => {}) };
    await expect(saveWithRetry(item, ops)).rejects.toBe(dup);
    expect(ops.recover).not.toHaveBeenCalled();
  });

  it('treats a duplicate key on the retry as saved', async () => {
    const dup = Object.assign(new Error('Key already exists'), { name: 'ConstraintError' });
    const add = vi.fn().mockImplementationOnce(never).mockRejectedValueOnce(dup);
    const ops = { write: add, get: vi.fn(async () => undefined), recover: vi.fn(async () => {}) };
    const p = saveWithRetry(item, ops);
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await expect(p).resolves.toBe(item);
  });

  it('gives up with a TimeoutError when the retry hangs too', async () => {
    const ops = { write: vi.fn(never), get: vi.fn(async () => undefined), recover: vi.fn(async () => {}) };
    const p = saveWithRetry(item, ops);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS + RETRY_TIMEOUT_MS);
    expect(await caught).toBeInstanceOf(TimeoutError);
    expect(ops.write).toHaveBeenCalledTimes(2);
  });

  it('fails when reopening fails, without a second write', async () => {
    const ops = { write: vi.fn(never), get: vi.fn(), recover: vi.fn(async () => Promise.reject(new TimeoutError('Reopening storage', 4000))) };
    const p = saveWithRetry(item, ops);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    expect(((await caught) as Error).message).toMatch(/Reopening storage/);
    expect(ops.write).toHaveBeenCalledTimes(1);
    expect(ops.get).not.toHaveBeenCalled();
  });

  it("passes other errors straight through without retrying", async () => {
    const ops = { write: vi.fn(async () => Promise.reject(new Error('Quota exceeded'))), get: vi.fn(), recover: vi.fn(async () => {}) };
    await expect(saveWithRetry(item, ops)).rejects.toThrow('Quota exceeded');
    expect(ops.recover).not.toHaveBeenCalled();
  });

  it('reopens and retries when storage fails at once (WebKit lost connection), not only when it hangs', async () => {
    const add = vi.fn().mockRejectedValueOnce(lostError()).mockResolvedValueOnce(undefined);
    const onRetry = vi.fn();
    const ops = { write: add, get: vi.fn(async () => undefined), recover: vi.fn(async () => {}), onRetry };
    await expect(saveWithRetry(item, ops)).resolves.toBe(item);
    expect(ops.recover).toHaveBeenCalledWith('A save failed');
    expect(ops.get).toHaveBeenCalledWith('abc');
    expect(add).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ name: 'UnknownError' }));
  });

  it('gives up within the budget when the write and the reopen both hang', async () => {
    const ops = { write: vi.fn(never), get: vi.fn(), recover: vi.fn(never) };
    let settled = false;
    const caught = saveWithRetry(item, ops)
      .catch((e: unknown) => e)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SAVE_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const e = await caught;
    expect(e).toBeInstanceOf(TimeoutError);
    expect((e as Error).message).toMatch(/Reopening storage/);
    expect(SAVE_BUDGET_MS).toBeLessThanOrEqual(9000);
  });

  it('keeps the retry within the budget too', async () => {
    const ops = { write: vi.fn(never), get: vi.fn(async () => undefined), recover: vi.fn(async () => {}) };
    let settled = false;
    const caught = saveWithRetry(item, ops)
      .catch((e: unknown) => e)
      .finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(SAVE_BUDGET_MS);
    expect(settled).toBe(true);
    expect(await caught).toBeInstanceOf(TimeoutError);
    expect(ops.write).toHaveBeenCalledTimes(2);
  });

  it('reopens first when asked, and then only tries once', async () => {
    const order: string[] = [];
    const ops = {
      write: vi.fn(async () => {
        order.push('write');
        throw lostError();
      }),
      get: vi.fn(),
      recover: vi.fn(async () => void order.push('recover')),
      recoverFirst: true,
    };
    await expect(saveWithRetry(item, ops)).rejects.toMatchObject({ name: 'UnknownError' });
    expect(order).toEqual(['recover', 'write']);
  });

  it('saves for real after a stalled database is recovered', async () => {
    vi.useRealTimers();
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const row: Row = { id: 'r1', n: 1 };
    const p = saveWithRetry(row, {
      write: (r) => db.rows.put(r),
      get: (id) => db.rows.get(id),
      recover: (why) => {
        ctl.stall = false; // the reopen gets through
        return mon.recover(why);
      },
    });
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS);
    await expect(p).resolves.toBe(row);
    vi.useRealTimers();
    expect(await db.rows.toArray()).toEqual([row]);
    expect(status(mon)).toBe('ready');
  });
});

describe('monitorDb', () => {
  it('tracks an open from start to ready, with its duration', async () => {
    const { db, mon } = makeDb();
    expect(status(mon)).toBe('idle');
    const p = db.open();
    expect(status(mon)).toBe('opening');
    expect(mon.getSnapshot().openStartedAt).toBeTypeOf('number');
    await p;
    const h = mon.getSnapshot();
    expect(h.status).toBe('ready');
    expect(h.openMs).toBeGreaterThanOrEqual(0);
    expect(h.opens).toBe(1);
    expect(kinds(mon)).toEqual(['open', 'ready']);
  });

  it("notices Dexie's automatic open on the first query", async () => {
    const { db, mon } = makeDb();
    await db.rows.put({ id: 'a' });
    expect(status(mon)).toBe('ready');
    expect(mon.getSnapshot().opens).toBe(1);
  });

  it('notifies subscribers with a new snapshot on each change', async () => {
    const { db, mon } = makeDb();
    const seen: string[] = [];
    const first = mon.getSnapshot();
    const off = mon.subscribe(() => seen.push(mon.getSnapshot().status));
    await db.open();
    off();
    expect(seen).toEqual(['opening', 'ready']);
    expect(mon.getSnapshot()).not.toBe(first);
    // Unchanged state keeps the same snapshot (useSyncExternalStore relies on it).
    expect(mon.getSnapshot()).toBe(mon.getSnapshot());
  });

  it('goes slow, then stuck, while an open hangs; recover() reopens and live data flows again', async () => {
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    await db.rows.put({ id: 'kept' });
    // The connection drops and the next open hangs.
    db.close({ disableAutoOpen: false });
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const read = db.rows.toArray();
    expect(status(mon)).toBe('opening');
    await vi.advanceTimersByTimeAsync(SLOW_MS);
    expect(status(mon)).toBe('slow');
    await vi.advanceTimersByTimeAsync(STUCK_MS - SLOW_MS);
    expect(status(mon)).toBe('stuck');

    ctl.stall = false;
    await mon.recover('test');
    // The read that was stuck behind the hung open fails instead of waiting forever…
    await expect(read).rejects.toMatchObject({ name: 'DatabaseClosedError' });
    // …and the database works again, including Dexie's own reopening later on.
    expect(status(mon)).toBe('ready');
    expect(mon.getSnapshot().recovering).toBe(false);
    expect(await db.rows.toArray()).toEqual([{ id: 'kept' }]);
    db.close({ disableAutoOpen: false });
    await expect(db.rows.count()).resolves.toBe(1);
    expect(kinds(mon)).toEqual(expect.arrayContaining(['slow', 'stuck', 'recover', 'ready']));
  });

  it('re-runs live queries that were waiting on a hung open once it recovers', async () => {
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    await db.rows.put({ id: 'kept' });
    db.close({ disableAutoOpen: false });
    ctl.stall = true;
    const seen: Row[][] = [];
    const sub = liveQuery(() => db.rows.toArray()).subscribe((rows) => seen.push(rows));
    cleanup.push(() => sub.unsubscribe());
    await vi.waitFor(() => expect(status(mon)).toBe('opening'));
    ctl.stall = false;
    await mon.recover('test');
    // liveQuery drops the DatabaseClosedError quietly, so without a nudge this would never arrive.
    await vi.waitFor(() => expect(seen).toEqual([[{ id: 'kept' }]]));
  });

  it('runs one recovery at a time', async () => {
    const { db, mon } = makeDb();
    await db.open();
    const close = vi.spyOn(db, 'close');
    const a = mon.recover('one');
    const b = mon.recover('two');
    expect(b).toBe(a);
    expect(mon.getSnapshot().recovering).toBe(true);
    await Promise.all([a, b]);
    // One recovery closes twice (cancel, then re-enable auto-open) and opens once.
    expect(close).toHaveBeenCalledTimes(2);
    expect(mon.getSnapshot().opens).toBe(2);
    expect(kinds(mon).filter((k) => k === 'recover')).toHaveLength(1);
    // Done: the next call starts a new one.
    const c = mon.recover('three');
    expect(c).not.toBe(a);
    await c;
    expect(mon.getSnapshot().opens).toBe(3);
  });

  it("reports stuck when the reopen doesn't answer in time", async () => {
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    await db.open();
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const p = mon.recover('test');
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REOPEN_TIMEOUT_MS);
    expect(await caught).toBeInstanceOf(TimeoutError);
    expect(status(mon)).toBe('stuck');
    expect(mon.getSnapshot().recovering).toBe(false);
  });

  it('reports a blocked upgrade and recovers by itself once the other connection closes', async () => {
    const name = `health-${++seq}`;
    // An "old tab" holding version 1 (native 10) that ignores requests to close.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = realIDB.open(name, 10);
      req.onupgradeneeded = () => req.result.createObjectStore('rows', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const db = new Dexie(name) as TestDb;
    db.version(2).stores({ rows: 'id, n' });
    const mon = monitorDb(db, { probe: () => db.rows.count() });
    cleanup.push(() => {
      mon.dispose();
      db.close();
      return Dexie.delete(name);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opened = db.open();
    await vi.waitFor(() => expect(status(mon)).toBe('blocked'));
    await expect(mon.recover('test')).rejects.toMatchObject({ name: 'DatabaseBlockedError' });
    old.close();
    await opened;
    expect(status(mon)).toBe('ready');
    expect(kinds(mon)).toEqual(['open', 'blocked', 'ready']);
  });

  it('closes and asks for a reload when another tab upgrades the database', async () => {
    const { db, mon, name } = makeDb();
    await db.open();
    // A newer Magpie in another tab opens a higher version.
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = realIDB.open(name, 30);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    newer.close();
    expect(status(mon)).toBe('outdated');
    expect(kinds(mon)).toContain('versionchange');
    // No quiet reopen with the old schema: reads fail until the reload.
    await expect(db.rows.count()).rejects.toMatchObject({ name: 'DatabaseClosedError' });
    await expect(mon.recover()).rejects.toMatchObject({ name: 'DatabaseClosedError' });
    expect(status(mon)).toBe('outdated');
  });

  it('reports a connection the browser closed, and reopens it', async () => {
    const { db, mon } = makeDb();
    await db.open();
    // What WebKit does on "Connection to Indexed Database server lost".
    const idb = db.backendDB();
    const seen: string[] = [];
    mon.subscribe(() => seen.push(mon.getSnapshot().status));
    idb.onclose?.call(idb, new Event('close'));
    expect(seen[0]).toBe('lost');
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    expect(mon.getSnapshot().opens).toBe(2);
    expect(kinds(mon)).toEqual(['open', 'ready', 'close', 'open', 'ready']);
  });

  it("doesn't report its own closes as lost", async () => {
    const { db, mon } = makeDb();
    await db.open();
    await mon.recover('test');
    expect(kinds(mon)).not.toContain('close');
  });

  it('waits until the app is visible to reopen a lost connection', async () => {
    const doc = fakeDoc('hidden');
    const { db, mon } = makeDb({ doc });
    await db.open();
    db.backendDB().onclose?.call(db.backendDB(), new Event('close'));
    expect(status(mon)).toBe('lost');
    doc.show();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
  });

  it('checks the connection after a long time in the background, and recovers when the check hangs', async () => {
    let hang = false;
    const probe = vi.fn(() => (hang ? new Promise(() => {}) : Promise.resolve(0)));
    const doc = fakeDoc('visible');
    const { db, mon } = makeDb({ doc, probe });
    await db.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    // A short trip away: no check.
    doc.hide();
    vi.setSystemTime(Date.now() + 5000);
    doc.show();
    expect(probe).not.toHaveBeenCalled();

    // A long one, and the connection answers.
    doc.hide();
    vi.setSystemTime(Date.now() + RESUME_PROBE_MS);
    doc.show();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(kinds(mon)).not.toContain('recover');

    // A long one, and the check hangs: reopen.
    hang = true;
    doc.hide();
    vi.setSystemTime(Date.now() + RESUME_PROBE_MS);
    doc.show();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(mon.getSnapshot().recovering).toBe(false));
    expect(kinds(mon)).toEqual(expect.arrayContaining(['probe', 'recover']));
    expect(status(mon)).toBe('ready');
    expect(mon.getSnapshot().opens).toBe(2);
  });

  it('reports an open that fails', async () => {
    const broken = { open: () => {
      throw new Error('IndexedDB is off');
    } } as unknown as IDBFactory;
    const { db, mon } = makeDb({ indexedDB: broken });
    await expect(db.open()).rejects.toThrow();
    expect(status(mon)).toBe('error');
    expect(mon.getSnapshot().lastError).toMatch(/IndexedDB is off/);
  });

  it('marks storage stuck when a write still times out', async () => {
    const { db, mon } = makeDb();
    await db.open();
    mon.reportTimeout('saving');
    expect(status(mon)).toBe('stuck');
    await mon.recover('retry');
    expect(status(mon)).toBe('ready');
  });
});

describe('storage that fails at once', () => {
  it('saves after the connection breaks: reopens, checks by id and writes again', async () => {
    const { db, mon } = makeDb();
    const ctl = failRequests(db);
    await db.open();
    ctl.failing = true;
    const row: Row = { id: 'r1', n: 1 };
    await saveWithRetry(row, {
      write: (r) => db.rows.put(r),
      get: (id) => db.rows.get(id),
      recover: (why) => {
        ctl.failing = false; // a fresh connection works
        return mon.recover(why);
      },
      onRetry: (e) => mon.noteRetry('saving', e),
    });
    expect(ctl.failed).toBe(1);
    expect(await db.rows.toArray()).toEqual([row]);
    expect(mon.getSnapshot().events.find((e) => e.kind === 'error')?.detail).toMatch(/UnknownError.*retrying/);
  });

  it('reopens on the first reported error, then reports error if it keeps failing', async () => {
    const { db, mon } = makeDb();
    await db.open();
    mon.reportError('reading', lostError());
    expect(mon.getSnapshot().recovering).toBe(true);
    await vi.waitFor(() => expect(mon.getSnapshot().recovering).toBe(false));
    expect(status(mon)).toBe('ready');
    expect(mon.getSnapshot().opens).toBe(2);
    // Failing again straight after reopening: no reopen loop, the banner says so instead.
    mon.reportError('reading', lostError());
    expect(status(mon)).toBe('error');
    expect(mon.getSnapshot().recovering).toBe(false);
    expect(mon.getSnapshot().lastError).toMatch(/reading: UnknownError: Connection to Indexed Database server lost/);
    expect(kinds(mon).filter((k) => k === 'recover')).toHaveLength(1);
  });

  it('leaves blocked alone: that needs the other tab closed, not a reopen', async () => {
    const name = `health-${++seq}`;
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = realIDB.open(name, 10);
      req.onupgradeneeded = () => req.result.createObjectStore('rows', { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const db = new Dexie(name) as TestDb;
    db.version(2).stores({ rows: 'id, n' });
    const mon = monitorDb(db, { probe: () => db.rows.count() });
    cleanup.push(() => {
      old.close();
      mon.dispose();
      db.close();
      return Dexie.delete(name);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.open().catch(() => {});
    await vi.waitFor(() => expect(status(mon)).toBe('blocked'));
    mon.reportError('saving', lostError());
    mon.reportTimeout('saving');
    expect(status(mon)).toBe('blocked');
    expect(mon.getSnapshot().recovering).toBe(false);
    expect(kinds(mon)).toEqual(['open', 'blocked', 'error', 'timeout']);
  });
});

describe('clearing stuck and error', () => {
  it('clears stuck as soon as a save works', async () => {
    const { db, mon } = makeDb();
    await db.open();
    mon.reportTimeout('saving');
    expect(status(mon)).toBe('stuck');
    mon.reportOk('saved');
    expect(status(mon)).toBe('ready');
    expect(kinds(mon)).toContain('ok');
  });

  it('checks back after a one-off timeout and clears stuck when storage answers', async () => {
    const { db, mon } = makeDb();
    await db.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mon.reportTimeout('saving');
    expect(status(mon)).toBe('stuck');
    await vi.advanceTimersByTimeAsync(CHECK_DELAYS_MS[0] - 1);
    expect(status(mon)).toBe('stuck');
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    expect(mon.getSnapshot().opens).toBe(1); // no reopen needed
  });

  it('reopens when the check hangs too, and keeps trying until storage answers', async () => {
    const { ctl, factory } = stallableIDB();
    let hang = true;
    const probe = vi.fn(() => (hang ? new Promise(() => {}) : Promise.resolve(0)));
    const { db, mon } = makeDb({ indexedDB: factory, probe });
    await db.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mon.reportTimeout('saving');
    ctl.stall = true; // a fresh connection doesn't answer either
    await vi.advanceTimersByTimeAsync(CHECK_DELAYS_MS[0] + PROBE_TIMEOUT_MS + REOPEN_TIMEOUT_MS);
    expect(status(mon)).toBe('stuck');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(kinds(mon).filter((k) => k === 'recover')).toHaveLength(1);
    // The next check finds the reopen still hanging and tries a fresh one, which the browser answers now.
    ctl.stall = false;
    hang = false;
    await vi.advanceTimersByTimeAsync(CHECK_DELAYS_MS[1]);
    vi.useRealTimers();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    expect(kinds(mon).filter((k) => k === 'recover')).toHaveLength(2);
    // Nothing more scheduled.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await vi.advanceTimersByTimeAsync(120000);
    expect(kinds(mon).filter((k) => k === 'recover')).toHaveLength(2);
  });
});

describe('storage that comes back by itself', () => {
  it('re-runs live queries whose reads failed once a check finds storage working again', async () => {
    const { db, mon } = makeDb();
    await db.rows.put({ id: 'kept' });
    // Reads fail twice (the first run, and the re-run after the automatic reopen), then work again.
    let failuresLeft = 2;
    const querier = guardQuerier(
      () => (failuresLeft > 0 ? (failuresLeft--, Promise.reject(lostError())) : db.rows.toArray()),
      (e) => mon.reportError('reading', e),
    );
    const seen: Row[][] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const sub = liveQuery(querier).subscribe((rows) => seen.push(rows));
    cleanup.push(() => sub.unsubscribe());
    await advanceSlowly(1000);
    expect(status(mon)).toBe('error');
    expect(seen).toEqual([]);
    await advanceSlowly(CHECK_DELAYS_MS[0]);
    expect(status(mon)).toBe('ready');
    vi.useRealTimers();
    // Without a nudge the query would wait for a change that never comes ("Loading your saves…" for good).
    await vi.waitFor(() => expect(seen).toEqual([[{ id: 'kept' }]]));
    expect(kinds(mon)).toContain('ok');
  });

  it('re-runs live queries when a save clears the trouble', async () => {
    const { db, mon } = makeDb();
    await db.rows.put({ id: 'kept' });
    let failing = true;
    const querier = guardQuerier(
      () => (failing ? Promise.reject(lostError()) : db.rows.toArray()),
      () => {},
    );
    const seen: Row[][] = [];
    const sub = liveQuery(querier).subscribe((rows) => seen.push(rows));
    cleanup.push(() => sub.unsubscribe());
    mon.reportTimeout('saving');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
    failing = false;
    mon.reportOk('saved');
    await vi.waitFor(() => expect(seen).toEqual([[{ id: 'kept' }]]));
  });

  it('keeps checking every so often while in view, not just three times', async () => {
    let hang = true;
    const probe = vi.fn(() => (hang ? new Promise(() => {}) : Promise.resolve(0)));
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory, probe });
    await db.open();
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mon.reportTimeout('saving');
    const total = CHECK_DELAYS_MS.reduce((a, b) => a + b, 0) + 3 * CHECK_DELAYS_MS.at(-1)!;
    await vi.advanceTimersByTimeAsync(total + 3 * (PROBE_TIMEOUT_MS + REOPEN_TIMEOUT_MS + 1000));
    expect(status(mon)).toBe('stuck');
    expect(kinds(mon).filter((k) => k === 'recover').length).toBeGreaterThanOrEqual(5);
    ctl.stall = false;
    hang = false;
    await advanceSlowly(CHECK_DELAYS_MS.at(-1)! + REOPEN_TIMEOUT_MS + 2000);
    expect(status(mon)).toBe('ready');
  });

  it('waits while in the background, and checks straight away on coming back', async () => {
    let hang = true;
    const probe = vi.fn(() => (hang ? new Promise(() => {}) : Promise.resolve(0)));
    const doc = fakeDoc('visible');
    const { db, mon } = makeDb({ doc, probe });
    await db.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    mon.reportTimeout('saving');
    doc.hide();
    await vi.advanceTimersByTimeAsync(5 * 60000);
    expect(probe).not.toHaveBeenCalled();
    expect(status(mon)).toBe('stuck');
    hang = false;
    doc.show();
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(status(mon)).toBe('ready');
    expect(mon.getSnapshot().opens).toBe(1); // a quick read was enough
  });

  it('checks again after a reopen that timed out', async () => {
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    await db.open();
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // The resume check's read fails, and its reopen hangs.
    mon.reportError('reading', lostError());
    await vi.advanceTimersByTimeAsync(REOPEN_TIMEOUT_MS);
    expect(status(mon)).toBe('stuck');
    ctl.stall = false;
    await vi.advanceTimersByTimeAsync(CHECK_DELAYS_MS[0]);
    vi.useRealTimers();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    expect(kinds(mon).filter((k) => k === 'recover')).toHaveLength(2);
  });

  it('reopens a connection lost again soon after the last automatic reopen, a little later', async () => {
    const { db, mon } = makeDb();
    await db.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    db.backendDB().onclose?.call(db.backendDB(), new Event('close'));
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Lost again within seconds: not reopened at once (no loop), but by the next check.
    db.backendDB().onclose?.call(db.backendDB(), new Event('close'));
    expect(status(mon)).toBe('lost');
    await vi.advanceTimersByTimeAsync(10);
    expect(status(mon)).toBe('lost');
    await vi.advanceTimersByTimeAsync(CHECK_DELAYS_MS[0]);
    vi.useRealTimers();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    expect(mon.getSnapshot().opens).toBe(3);
  });
});

describe('a hung open', () => {
  it('is retried by itself a few seconds after it counts as stuck, and works once the browser answers', async () => {
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    await db.rows.put({ id: 'kept' });
    db.close({ disableAutoOpen: false });
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const read = db.rows.toArray().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(STUCK_MS);
    expect(status(mon)).toBe('stuck');
    ctl.stall = false; // the browser would answer a new open now
    await vi.advanceTimersByTimeAsync(CHECK_DELAYS_MS[0]);
    vi.useRealTimers();
    await vi.waitFor(() => expect(status(mon)).toBe('ready'));
    expect(kinds(mon)).toContain('recover');
    expect(await read).toMatchObject({ name: 'DatabaseClosedError' });
    expect(await db.rows.toArray()).toEqual([{ id: 'kept' }]);
  });

  it('keeps saying stuck (with Try again) while a reopen tries to fix it', async () => {
    const { ctl, factory } = stallableIDB();
    const { db, mon } = makeDb({ indexedDB: factory });
    await db.open();
    mon.reportTimeout('saving');
    ctl.stall = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const seen = new Set<string>();
    mon.subscribe(() => seen.add(status(mon)));
    const p = mon.recover('Try again tapped').catch((e: unknown) => e);
    expect(mon.getSnapshot().recovering).toBe(true);
    expect(status(mon)).toBe('stuck');
    await vi.advanceTimersByTimeAsync(REOPEN_TIMEOUT_MS);
    expect(await p).toBeInstanceOf(TimeoutError);
    expect(seen.has('opening')).toBe(false);
    expect(status(mon)).toBe('stuck');
  });
});

describe('formatDiagnostics', () => {
  it('lists the status, timings, mode and recent events', () => {
    const text = formatDiagnostics(
      {
        status: 'ready',
        openMs: 182,
        openedAt: Date.UTC(2026, 9, 1, 9, 30, 0),
        opens: 2,
        recovering: false,
        events: [
          { at: Date.UTC(2026, 9, 1, 9, 29, 59), kind: 'open' },
          { at: Date.UTC(2026, 9, 1, 9, 30, 0), kind: 'ready', detail: '182 ms' },
        ],
      },
      { version: '0.1.0', userAgent: 'Mozilla/5.0 (iPhone)', standalone: true, embedded: false, persisted: true, now: Date.UTC(2026, 9, 1, 9, 31) },
    );
    expect(text).toContain('Magpie v0.1.0');
    expect(text).toContain('Storage: ready (Working)');
    expect(text).toContain('Last open: 182 ms at 09:30:00.000; opens: 2');
    expect(text).toContain('Mode: installed app');
    expect(text).toContain('Persistent storage: yes');
    expect(text).toContain('User agent: Mozilla/5.0 (iPhone)');
    expect(text).toContain('09:30:00.000 ready — 182 ms');
  });

  it('says when there is nothing to report yet', () => {
    const text = formatDiagnostics({ status: 'idle', opens: 0, recovering: false, events: [] }, { version: '1', userAgent: 'x', standalone: false, embedded: true });
    expect(text).toContain('Last open: —');
    expect(text).toContain('browser tab, inside another app’s built-in browser');
    expect(text).toMatch(/Storage events \(UTC\):\n {2}none/);
  });
});

function fakeDoc(initial: DocumentVisibilityState) {
  const target = new EventTarget();
  let visibility = initial;
  const set = (v: DocumentVisibilityState) => {
    visibility = v;
    target.dispatchEvent(new Event('visibilitychange'));
  };
  return {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (type: 'visibilitychange', l: () => void) => target.addEventListener(type, l),
    removeEventListener: (type: 'visibilitychange', l: () => void) => target.removeEventListener(type, l),
    hide: () => set('hidden'),
    show: () => set('visible'),
  };
}
