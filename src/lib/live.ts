import { useLiveQuery as useDexieLiveQuery } from 'dexie-react-hooks';
import { dbHealth } from './db';
import { isStorageFailure } from './dbHealth';

/**
 * Wraps a live query's querier so a broken database (WebKit's "Connection to Indexed Database server lost" and
 * the like) is reported and reopened instead of thrown into the screen's error boundary. The query then waits,
 * as it does for a closed database, and runs again once storage is back. Other errors pass through.
 */
export function guardQuerier<T>(querier: () => T | PromiseLike<T>, onFailure: (e: unknown) => void): () => Promise<T> {
  // An async function, so Dexie keeps tracking what the querier reads across its awaits.
  return async () => {
    try {
      return await querier();
    } catch (e) {
      // A closed database is already waited out quietly by liveQuery.
      if (!isStorageFailure(e) || (e as Error).name === 'DatabaseClosedError') throw e;
      onFailure(e);
      throw Object.assign(new Error('Waiting for storage'), { name: 'DatabaseClosedError' });
    }
  };
}

const onReadFailure = (e: unknown) => dbHealth.reportError('reading', e);

/** dexie-react-hooks' useLiveQuery, but storage failures show as a status banner rather than a crashed screen. */
export function useLiveQuery<T>(querier: () => Promise<T> | T, deps?: unknown[]): T | undefined;
export function useLiveQuery<T, D>(querier: () => Promise<T> | T, deps: unknown[], defaultResult: D): T | D;
export function useLiveQuery<T, D>(querier: () => Promise<T> | T, deps: unknown[] = [], defaultResult?: D): T | D | undefined {
  return useDexieLiveQuery(guardQuerier(querier, onReadFailure), deps, defaultResult);
}
