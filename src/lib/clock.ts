import { useSyncExternalStore } from 'react';

/**
 * One clock for everything on screen that depends on the time ("2 minutes ago", "Today", "On now"), so cards
 * that are otherwise left alone between library writes still move on. A single timer ticks each minute (and
 * when the app comes back into view), only while something is listening.
 */

export const TICK_MS = 60000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function tick(): void {
  now = Date.now();
  listeners.forEach((l) => l());
}

const onVisibility = () => {
  if (document.visibilityState === 'visible') tick();
};

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = undefined;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** The time as of the last tick (or now, while nothing listens). */
export function clockNow(): number {
  if (!timer) now = Date.now();
  return now;
}

/**
 * `compute(now)`, worked out again on each tick. The component only redraws when the result changes, so
 * return something small and comparable, like a string.
 */
export function useClock<T extends string | number | boolean>(compute: (now: number) => T): T {
  const get = () => compute(clockNow());
  return useSyncExternalStore(subscribeClock, get, get);
}
