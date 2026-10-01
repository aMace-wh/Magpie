import { Dexie, RangeSet } from 'dexie';

/**
 * Keeps an eye on the IndexedDB connection, so a database that is slow to open, blocked by another tab or
 * dropped by the browser shows up as a status (with a way to retry) instead of an endless spinner or an
 * empty-looking library. Safari / iOS in particular can lose the connection while the app is in the
 * background; requests then never settle.
 */

export type DbStatus =
  /** Not opened yet. */
  | 'idle'
  | 'opening'
  /** Opening for longer than SLOW_MS. */
  | 'slow'
  /** Opening for longer than STUCK_MS, or a read / write timed out and reopening didn't help. */
  | 'stuck'
  | 'ready'
  /** Another tab or window holds an older version open, so the upgrade waits. */
  | 'blocked'
  /** The browser closed the connection (e.g. WebKit's "Connection to Indexed Database server lost"). */
  | 'lost'
  /** Another tab upgraded or deleted the database: this one has to reload. */
  | 'outdated'
  /** Opening failed, or reads / writes keep failing even after reopening. */
  | 'error';

export type DbEventKind =
  | 'open'
  | 'ready'
  | 'slow'
  | 'stuck'
  | 'blocked'
  | 'versionchange'
  | 'close'
  | 'error'
  | 'timeout'
  | 'recover'
  | 'probe'
  /** Storage answered again after a timeout or error. */
  | 'ok';

export interface DbEvent {
  at: number;
  kind: DbEventKind;
  detail?: string;
}

export interface DbHealth {
  status: DbStatus;
  /** When the current (or last) open started. */
  openStartedAt?: number;
  /** How long the last successful open took, in ms. */
  openMs?: number;
  /** When the last successful open finished. */
  openedAt?: number;
  /** Successful opens so far (more than one means it was reopened). */
  opens: number;
  lastError?: string;
  /** True while recover() closes and reopens the database. */
  recovering: boolean;
  /** Most recent last, at most MAX_EVENTS. */
  events: DbEvent[];
}

export const SLOW_MS = 4000;
export const STUCK_MS = 10000;
/** How long a reopen in recover() may take. */
export const REOPEN_TIMEOUT_MS = 4000;
/** How long the health check's read may take. */
export const PROBE_TIMEOUT_MS = 3000;
/** Coming back after at least this long in the background runs the health check. */
export const RESUME_PROBE_MS = 30000;
/** A save's first attempt. A write that takes this long is stuck, not slow. */
export const SAVE_TIMEOUT_MS = 6000;
/** Each step of the retry after reopening (checking for the first write, writing again). */
export const RETRY_TIMEOUT_MS = 5000;
/** A whole save, retry included: the spinner never turns longer than this. */
export const SAVE_BUDGET_MS = 8500;
/**
 * While storage is stuck (or lost), it's checked again after each of these, then every last one while Magpie is in
 * view: a quick read when the connection is open (a one-off slow write clears), or a fresh reopen when an open
 * hangs or nothing is open (the browser may answer a new one).
 */
export const CHECK_DELAYS_MS = [5000, 15000, 45000];
const MAX_EVENTS = 20;
/** At most one automatic reopen in this long (lost connection, failing reads), so a flapping connection can't loop. */
const AUTO_REOPEN_GAP_MS = 10000;

// ---------------------------------------------------------------------------
// Timeouts

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} took longer than ${Math.round(ms / 100) / 10} s`);
    this.name = 'TimeoutError';
  }
}

/** Settles like `promise`, or rejects with a TimeoutError after `ms`. The work itself isn't cancelled. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label = 'Storage'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export const isTimeout = (e: unknown): boolean => (e as Error | null)?.name === 'TimeoutError';

const STORAGE_FAILURES = new Set([
  'TimeoutError',
  'DatabaseClosedError',
  'DatabaseBlockedError',
  'OpenFailedError',
  'InvalidStateError',
  'UnknownError',
  'MissingAPIError',
]);

/** Errors that mean the database itself isn't working, as opposed to a problem with what was written. */
export function isStorageFailure(e: unknown): boolean {
  return STORAGE_FAILURES.has((e as Error | null)?.name ?? '');
}

function describe(e: unknown): string {
  if (!e) return 'Unknown error';
  const err = e as Error;
  const msg = err.message || String(e);
  return err.name && !msg.startsWith(err.name) ? `${err.name}: ${msg}` : msg;
}

const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const noop = () => {};

// ---------------------------------------------------------------------------
// Saving without hanging

export interface SaveOps<T extends { id: string }> {
  /** Writes the item. An add is best: it never writes over a save that's already there (a ConstraintError instead). */
  write: (item: T) => PromiseLike<unknown>;
  get: (id: string) => PromiseLike<T | undefined>;
  /** Whether a stored item with this id is this one, rather than an earlier save under the same id. Default: yes. */
  isSame?: (stored: T, item: T) => boolean;
  /** Closes and reopens the database. */
  recover: (reason: string) => Promise<void>;
  /** Reopen before the first attempt (storage is already known to be stuck). */
  recoverFirst?: boolean;
  /** Told about a failed attempt that is about to be retried (for diagnostics). */
  onRetry?: (error: unknown) => void;
  /** First attempt's limit (SAVE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Limit for each step of the retry (RETRY_TIMEOUT_MS). */
  retryTimeoutMs?: number;
  /** Limit for the whole save, retry included (SAVE_BUDGET_MS). */
  budgetMs?: number;
}

/** The id is taken: something was already saved under it (an add's ConstraintError). */
export const isAlreadySaved = (e: unknown): boolean => (e as Error | null)?.name === 'ConstraintError';

/**
 * Writes `item` without ever waiting forever. If the write hangs, or fails because storage itself is broken
 * (say, WebKit's "Connection to Indexed Database server lost"), reopens the database and tries once more, first
 * checking by the item's id that the first write didn't land late, so nothing is saved twice. All of it within
 * the budget. Rejects with a TimeoutError (or the storage error) when that fails too; other errors (a bad item,
 * a full disk, an id that's already taken: see isAlreadySaved) aren't retried.
 */
export async function saveWithRetry<T extends { id: string }>(item: T, ops: SaveOps<T>): Promise<T> {
  const end = Date.now() + (ops.budgetMs ?? SAVE_BUDGET_MS);
  const within = (ms: number) => Math.max(0, Math.min(ms, end - Date.now()));
  const step = ops.retryTimeoutMs ?? RETRY_TIMEOUT_MS;
  let reopened = false;
  const reopen = async (reason: string) => {
    reopened = true;
    await withTimeout(ops.recover(reason), within(REOPEN_TIMEOUT_MS), 'Reopening storage');
  };

  if (ops.recoverFirst) await reopen('Saving while storage was stuck');
  let failure: unknown;
  try {
    await withTimeout(ops.write(item), within(ops.timeoutMs ?? SAVE_TIMEOUT_MS), 'Saving');
    return item;
  } catch (e) {
    // Freshly reopened and still failing: another go wouldn't fare better.
    if (!isStorageFailure(e) || reopened) throw e;
    failure = e;
    ops.onRetry?.(e);
  }
  await reopen(isTimeout(failure) ? 'A save timed out' : 'A save failed');
  const stored = await withTimeout(ops.get(item.id), within(step), 'Saving');
  if (stored) {
    // The first write landed late, unless what's there was saved before under the same id.
    if (ops.isSame && !ops.isSame(stored, item)) throw named('ConstraintError', 'Already saved');
    return item;
  }
  try {
    await withTimeout(ops.write(item), within(step), 'Saving');
  } catch (e) {
    // Same id: the first write landed in the meantime.
    if ((e as Error | null)?.name !== 'ConstraintError') throw e;
  }
  return item;
}

// ---------------------------------------------------------------------------
// The monitor

/** The bits of `document` the monitor needs (a stand-in in tests). */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface DbMonitorOptions {
  /** A cheap read that shows the connection still answers. */
  probe: () => PromiseLike<unknown>;
  /** Visibility changes to watch for coming back to the app; omit outside the browser. */
  doc?: VisibilitySource;
}

export interface DbMonitor {
  getSnapshot: () => DbHealth;
  subscribe: (listener: () => void) => () => void;
  /**
   * Closes and reopens the database once (concurrent calls share the same attempt), then re-runs live queries.
   * Rejects when the reopen fails or takes longer than REOPEN_TIMEOUT_MS, and right away while blocked or outdated.
   */
  recover: (reason?: string) => Promise<void>;
  /** Runs the cheap read with a timeout; on failure, recovers. Resolves true when the database answered. */
  probe: (ms?: number) => Promise<boolean>;
  /** A read or write took too long even after reopening. Checks back a little later whether storage answers. */
  reportTimeout: (label: string) => void;
  /**
   * A read or write failed because storage itself is broken (UnknownError, InvalidStateError…), as WebKit does
   * after losing its connection. Reopens, unless that was just tried; then reports 'error' and checks back later.
   */
  reportError: (label: string, error: unknown) => void;
  /** Notes a failed attempt that is being retried, for Diagnostics. */
  noteRetry: (label: string, error: unknown) => void;
  /** A read or write worked: clears 'stuck' / 'error'. */
  reportOk: (label: string) => void;
  /** Detaches the listeners (tests). */
  dispose: () => void;
}

/**
 * Tracks every open of `db` (explicit, Dexie's own automatic reopen, or recover()) and its 'blocked',
 * 'versionchange' and 'close' events. Dexie reopens by itself after an unexpected close; this only watches
 * that happen and nudges it along when the app is visible.
 */
export function monitorDb(db: Dexie, opts: DbMonitorOptions): DbMonitor {
  const { doc } = opts;
  let state: DbHealth = { status: db.isOpen() ? 'ready' : 'idle', opens: 0, recovering: false, events: [] };
  const listeners = new Set<() => void>();

  const update = (patch: Partial<DbHealth>, event?: { kind: DbEventKind; detail?: string }) => {
    state = { ...state, ...patch };
    if (event) state.events = [...state.events, { at: Date.now(), ...event }].slice(-MAX_EVENTS);
    listeners.forEach((l) => l());
  };

  // --- Opens. Every open goes through db.open(), including Dexie's automatic ones, so wrap it to time them.
  let pending: { id: number; promise: PromiseLike<unknown> } | null = null;
  let openCount = 0;
  const origOpen = db.open.bind(db);
  db.open = () => {
    const fresh = !pending && !db.isOpen();
    const promise = origOpen();
    if (fresh) track(promise);
    return promise;
  };

  function track(promise: PromiseLike<unknown>) {
    const id = ++openCount;
    const startedAt = Date.now();
    pending = { id, promise };
    // A reopen to fix a problem keeps reporting the problem (and its Try again) until it works.
    const fixing = state.status === 'stuck' || state.status === 'error';
    update(fixing ? { openStartedAt: startedAt } : { status: 'opening', openStartedAt: startedAt }, { kind: 'open' });
    const slow = setTimeout(() => {
      if (pending?.id === id && state.status === 'opening') update({ status: 'slow' }, { kind: 'slow', detail: `${SLOW_MS} ms` });
    }, SLOW_MS);
    const stuck = setTimeout(() => {
      if (pending?.id !== id || (state.status !== 'opening' && state.status !== 'slow')) return;
      update({ status: 'stuck' }, { kind: 'stuck', detail: `still opening after ${STUCK_MS} ms` });
      scheduleCheck();
    }, STUCK_MS);
    const done = (error?: unknown) => {
      clearTimeout(slow);
      clearTimeout(stuck);
      // Cancelled by recover(), which reports its own outcome.
      if (pending?.id !== id) return;
      pending = null;
      if (error === undefined) {
        const ms = Date.now() - startedAt;
        update({ status: 'ready', openMs: ms, openedAt: Date.now(), opens: state.opens + 1, lastError: undefined }, { kind: 'ready', detail: `${ms} ms` });
        // Live queries whose reads failed while the database was down only re-run on a change: nudge them all.
        if (id > 1) requeryAll();
      } else if (state.status !== 'outdated') {
        update({ status: 'error', lastError: describe(error) }, { kind: 'error', detail: describe(error) });
        scheduleCheck();
      }
    };
    promise.then(
      () => done(),
      (e: unknown) => done(e ?? new Error('Opening failed')),
    );
  }

  // --- Events
  let closing = 0; // > 0 while closing on purpose, so our own close isn't reported as lost
  const closeOnPurpose = (disableAutoOpen: boolean) => {
    closing++;
    try {
      db.close({ disableAutoOpen });
    } finally {
      closing--;
    }
  };

  const onBlocked = (ev: IDBVersionChangeEvent) => {
    update({ status: 'blocked' }, { kind: 'blocked', detail: `another connection holds v${ev.oldVersion / 10}` });
  };

  const onVersionChange = (ev: IDBVersionChangeEvent) => {
    // Per Dexie's guidance: stop using the old schema and ask for a reload. Its default would close and then
    // quietly reopen with this tab's older schema.
    closeOnPurpose(true);
    update({ status: 'outdated' }, { kind: 'versionchange', detail: ev.newVersion ? `upgrade to v${ev.newVersion / 10}` : 'database deleted' });
    return false;
  };

  let lastAutoReopen = 0;
  /** When recover() last started, so failing reads don't reopen over and over. */
  let lastRecoverAt = Number.NEGATIVE_INFINITY;
  const onClose = () => {
    // Our own closes, and Dexie tidying up after a failed open, aren't a lost connection.
    if (closing || state.status !== 'ready') return;
    const visible = !doc || doc.visibilityState === 'visible';
    update({ status: 'lost' }, { kind: 'close', detail: visible ? 'connection closed' : 'connection closed while in the background' });
    if (visible) autoReopen();
  };

  function autoReopen() {
    // Reopened just now: a check a little later does it (live queries wait quietly for a closed database).
    if (Date.now() - lastAutoReopen < AUTO_REOPEN_GAP_MS) return scheduleCheck();
    lastAutoReopen = Date.now();
    // The same reopen Dexie would do on the next query, just sooner. Dexie fires 'close' before it has
    // finished closing, so wait for that.
    queueMicrotask(() => {
      if (!db.isOpen()) db.open().catch(noop);
    });
  }

  db.on('blocked', onBlocked);
  db.on('versionchange', onVersionChange);
  db.on('close', onClose);

  // --- Recovery
  let recovering: Promise<void> | null = null;

  function recover(reason = 'Retry'): Promise<void> {
    if (state.status === 'outdated') return Promise.reject(named('DatabaseClosedError', 'Magpie was updated in another tab. Reload to keep going.'));
    if (state.status === 'blocked') return Promise.reject(named('DatabaseBlockedError', 'Magpie is open in another tab or window.'));
    recovering ??= run(reason).finally(() => {
      recovering = null;
      update({ recovering: false });
    });
    return recovering;
  }

  async function run(reason: string) {
    lastRecoverAt = Date.now();
    update({ recovering: true }, { kind: 'recover', detail: reason });
    const stalled = pending?.promise;
    pending = null;
    // Cancels an open that hangs, and makes reads and writes queued behind it fail fast instead of waiting forever.
    closeOnPurpose(true);
    if (stalled) await withTimeout(Promise.resolve(stalled).then(noop, noop), 1000).catch(noop);
    // Closing again this way turns Dexie's automatic reopening back on.
    closeOnPurpose(false);
    try {
      await withTimeout(db.open(), REOPEN_TIMEOUT_MS, 'Reopening storage');
    } catch (e) {
      // A slow reopen keeps going, and is tracked like any other open. Blocked says more than stuck.
      if (isTimeout(e)) {
        update(state.status === 'blocked' ? {} : { status: 'stuck', lastError: describe(e) }, { kind: 'timeout', detail: 'reopening' });
        scheduleCheck();
      }
      throw e;
    }
  }

  // --- Health check
  async function probe(ms = PROBE_TIMEOUT_MS): Promise<boolean> {
    try {
      await withTimeout(opts.probe(), ms, 'Storage check');
      return true;
    } catch (e) {
      update({}, { kind: 'probe', detail: describe(e) });
      await recover('Storage check failed').catch(noop);
      return false;
    }
  }

  // While stuck, check back: with the connection open, a quick read tells whether storage works again (so a
  // one-off slow write doesn't leave the "isn't responding" banner up for good); with an open that hangs, or none,
  // a fresh reopen may get through. Quickly at first, then every 45 s while in view, and straight away on coming
  // back to Magpie. The banner's Try again does the same at any time.
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const visible = () => !doc || doc.visibilityState === 'visible';
  const isTroubled = () => state.status === 'stuck' || state.status === 'error';
  const needsCheck = () => isTroubled() || state.status === 'lost';

  function scheduleCheck(attempt = 0) {
    clearTimeout(checkTimer);
    if (disposed) return;
    checkTimer = setTimeout(() => {
      // In the background it waits: coming back checks.
      if (visible()) void checkNow(attempt + 1);
    }, CHECK_DELAYS_MS[Math.min(attempt, CHECK_DELAYS_MS.length - 1)]);
  }

  async function checkNow(next = 0) {
    clearTimeout(checkTimer);
    if (!needsCheck()) return;
    if (!recovering) {
      if (pending || !db.isOpen()) {
        await recover('Still not responding').catch(noop);
      } else {
        try {
          await withTimeout(opts.probe(), PROBE_TIMEOUT_MS, 'Storage check');
          ok('check');
        } catch (e) {
          update({}, { kind: 'probe', detail: describe(e) });
          // Reads hang or fail on this connection: a fresh one is the known fix (unless one was just tried).
          if (Date.now() - lastRecoverAt >= AUTO_REOPEN_GAP_MS) await recover('Storage check failed').catch(noop);
        }
      }
    }
    if (needsCheck()) scheduleCheck(next);
  }

  function ok(label: string) {
    // An open still going (or failing) reports for itself.
    if (!isTroubled() || pending) return;
    clearTimeout(checkTimer);
    update({ status: 'ready' }, { kind: 'ok', detail: label });
    // Live queries whose reads failed meanwhile are waiting for a change: run them again.
    requeryAll();
  }

  // Blocked and outdated say more than stuck or error, and need the other tab or a reload, not a reopen.
  const settled = () => state.status === 'blocked' || state.status === 'outdated';

  function reportTimeout(label: string) {
    if (settled()) {
      update({}, { kind: 'timeout', detail: label });
      return;
    }
    update({ status: state.status === 'error' ? 'error' : 'stuck' }, { kind: 'timeout', detail: label });
    scheduleCheck();
  }

  function reportError(label: string, error: unknown) {
    const detail = `${label}: ${describe(error)}`;
    if (settled() || recovering) {
      update({}, { kind: 'error', detail });
      return;
    }
    if (Date.now() - lastRecoverAt >= AUTO_REOPEN_GAP_MS) {
      // Closing and reopening is the known fix for a connection the browser broke.
      update({ lastError: detail }, { kind: 'error', detail });
      recover(`${label} failed`).catch(noop);
      return;
    }
    update({ status: 'error', lastError: detail }, { kind: 'error', detail });
    scheduleCheck();
  }

  // Back from the background: a lost connection reopens, storage that was stuck is checked straight away, and
  // after a long time away a quick read checks that the connection still answers (WebKit can leave it hanging
  // without saying so).
  let hiddenAt = doc?.visibilityState === 'hidden' ? Date.now() : 0;
  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (state.status === 'lost') autoReopen();
    else if (isTroubled()) void checkNow();
    else if (away >= RESUME_PROBE_MS && state.status === 'ready') void probe();
  };
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    recover,
    probe,
    reportTimeout,
    reportError,
    noteRetry(label, error) {
      update({}, { kind: isTimeout(error) ? 'timeout' : 'error', detail: `${label}: ${describe(error)} — retrying` });
    },
    reportOk: ok,
    dispose() {
      disposed = true;
      clearTimeout(checkTimer);
      db.on.blocked.unsubscribe(onBlocked);
      db.on.versionchange.unsubscribe(onVersionChange);
      db.on.close.unsubscribe(onClose);
      doc?.removeEventListener('visibilitychange', onVisibility);
      db.open = origOpen;
      listeners.clear();
    },
  };
}

/** Re-runs every live query (as Dexie does itself when a page comes back from the back/forward cache). */
function requeryAll() {
  try {
    Dexie.on.storagemutated.fire({ all: new RangeSet(-Infinity, [[]]) });
  } catch {
    // Nothing listening.
  }
}

// ---------------------------------------------------------------------------
// Diagnostics

export const STATUS_LABEL: Record<DbStatus, string> = {
  idle: 'Not opened yet',
  opening: 'Opening',
  slow: 'Slow to open',
  stuck: 'Not responding',
  ready: 'Working',
  blocked: 'Blocked by another tab or window',
  lost: 'Connection lost',
  outdated: 'Updated in another tab',
  error: 'Not working',
};

export interface DiagnosticsEnv {
  version: string;
  userAgent: string;
  standalone: boolean;
  embedded: boolean;
  online?: boolean;
  persisted?: boolean;
  usage?: string;
  now?: number;
}

const clock = (t: number) => new Date(t).toISOString().slice(11, 23);

/** Plain text a user can paste into a bug report. */
export function formatDiagnostics(h: DbHealth, env: DiagnosticsEnv): string {
  const lines = [
    `Magpie v${env.version} — ${new Date(env.now ?? Date.now()).toISOString()}`,
    `Storage: ${h.status} (${STATUS_LABEL[h.status]})`,
    `Last open: ${h.openMs !== undefined ? `${h.openMs} ms` : '—'}${h.openedAt ? ` at ${clock(h.openedAt)}` : ''}; opens: ${h.opens}`,
  ];
  if (h.lastError) lines.push(`Last error: ${h.lastError}`);
  lines.push(
    `Mode: ${env.standalone ? 'installed app' : 'browser tab'}${env.embedded ? ', inside another app’s built-in browser' : ''}`,
    ...(env.online === undefined ? [] : [`Online: ${env.online ? 'yes' : 'no'}`]),
    ...(env.persisted === undefined ? [] : [`Persistent storage: ${env.persisted ? 'yes' : 'no'}`]),
    ...(env.usage ? [`Storage used: ${env.usage}`] : []),
    `User agent: ${env.userAgent}`,
    'Storage events (UTC):',
    ...(h.events.length ? h.events.map((e) => `  ${clock(e.at)} ${e.kind}${e.detail ? ` — ${e.detail}` : ''}`) : ['  none']),
  );
  return lines.join('\n');
}
