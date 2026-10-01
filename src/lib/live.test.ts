import 'fake-indexeddb/auto';
import { Dexie, liveQuery, type EntityTable } from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorDb } from './dbHealth';
import { guardQuerier } from './live';

interface Row {
  id: string;
}

const lost = () => Object.assign(new Error('Connection to Indexed Database server lost'), { name: 'UnknownError' });
const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const name = `live-${Math.random()}`;
  const db = new Dexie(name) as Dexie & { rows: EntityTable<Row, 'id'> };
  db.version(1).stores({ rows: 'id' });
  const mon = monitorDb(db, { probe: () => db.rows.count() });
  await db.rows.put({ id: 'kept' });
  cleanup.push(() => {
    mon.dispose();
    db.close();
    return Dexie.delete(name);
  });
  return { db, mon };
}

describe('guardQuerier', () => {
  it('turns a broken connection into a reopen and a re-run, not an error for the screen', async () => {
    const { db, mon } = await setup();
    let failing = true;
    const failures: unknown[] = [];
    const querier = guardQuerier(
      () => (failing ? Promise.reject(lost()) : db.rows.toArray()),
      (e) => {
        failures.push(e);
        mon.reportError('reading', e);
        failing = false; // the reopened connection works
      },
    );
    const seen: Row[][] = [];
    const errors: unknown[] = [];
    const sub = liveQuery(querier).subscribe({ next: (rows) => seen.push(rows), error: (e) => errors.push(e) });
    cleanup.push(() => sub.unsubscribe());
    await vi.waitFor(() => expect(seen).toEqual([[{ id: 'kept' }]]));
    expect(errors).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(mon.getSnapshot().opens).toBe(2);
    expect(mon.getSnapshot().status).toBe('ready');
  });

  it('passes other errors through to the screen', async () => {
    const onFailure = vi.fn();
    const bug = new TypeError('bad record');
    const errors: unknown[] = [];
    const sub = liveQuery(
      guardQuerier(() => {
        throw bug;
      }, onFailure),
    ).subscribe({ error: (e) => errors.push(e) });
    cleanup.push(() => sub.unsubscribe());
    await vi.waitFor(() => expect(errors).toEqual([bug]));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('returns what the querier returns, sync or async', async () => {
    await expect(guardQuerier(() => 3, vi.fn())()).resolves.toBe(3);
    await expect(guardQuerier(async () => 4, vi.fn())()).resolves.toBe(4);
  });
});
