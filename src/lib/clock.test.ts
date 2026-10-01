import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clockNow, subscribeClock, TICK_MS } from './clock';
import { timeAgo } from './format';
import { whenBadge } from './when';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 1, 9, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clock', () => {
  it('ticks each minute while something listens, so "just now" moves on', () => {
    const savedAt = Date.now();
    const seen: string[] = [];
    const off = subscribeClock(() => seen.push(timeAgo(savedAt, clockNow())));
    expect(timeAgo(savedAt, clockNow())).toBe('just now');
    vi.advanceTimersByTime(TICK_MS);
    vi.advanceTimersByTime(TICK_MS);
    expect(seen).toEqual(['1 minute ago', '2 minutes ago']);
    off();
  });

  it('shares one timer, and stops it once nobody listens', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeClock(a);
    const offB = subscribeClock(b);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds still between ticks, and reads the real time while nobody listens', () => {
    const off = subscribeClock(() => {});
    const at = clockNow();
    vi.setSystemTime(Date.now() + 30000);
    expect(clockNow()).toBe(at); // same answer within a render
    off();
    expect(clockNow()).toBe(Date.now());
  });

  it('moves a date pill from "Tomorrow" to "Today" at midnight', () => {
    vi.setSystemTime(new Date(2026, 9, 1, 23, 59, 30));
    const pill = () => whenBadge({ start: '2026-10-02' }, new Date(clockNow()))?.text;
    const seen: (string | undefined)[] = [];
    const off = subscribeClock(() => seen.push(pill()));
    expect(pill()).toBe('Tomorrow');
    vi.advanceTimersByTime(TICK_MS);
    expect(seen).toEqual(['Today']);
    off();
  });

  it('catches up as soon as the app is back in view', () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const listener = vi.fn();
    const off = subscribeClock(listener);
    vi.setSystemTime(Date.now() + 5 * 3600000); // timers don't run while the phone sleeps
    expect(listener).not.toHaveBeenCalled();
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(clockNow()).toBe(Date.now());
    off();
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(listener).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
