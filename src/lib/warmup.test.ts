import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SLICE_MS, MIN_IDLE_MS, compileSteps, runSlice, runWhenIdle, startWarmup, textKind, whenIdle, type IdleDeadlineLike, type TextKind } from './warmup';

/** An idle period that has `ms` left at first and loses `per` ms with every look at the clock. */
function deadline(ms: number, per = 0): IdleDeadlineLike {
  let left = ms + per;
  return { timeRemaining: () => Math.max(0, (left -= per)) };
}

function* count(n: number, log: number[]): Generator<void> {
  for (let i = 0; i < n; i++) {
    log.push(i);
    yield;
  }
}

/** Collects requestIdleCallback calls instead of running them. */
function fakeIdle() {
  const queue: ((d: IdleDeadlineLike) => void)[] = [];
  const cancelled: number[] = [];
  vi.stubGlobal('requestIdleCallback', (cb: (d: IdleDeadlineLike) => void) => queue.push(cb));
  vi.stubGlobal('cancelIdleCallback', (id: number) => cancelled.push(id));
  return { queue, cancelled };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runSlice', () => {
  it('stops once less than MIN_IDLE_MS is left', () => {
    const log: number[] = [];
    // 10 → 7 → 4 → 1: three steps fit.
    expect(runSlice(count(10, log), deadline(10, 3))).toBe(false);
    expect(log).toEqual([0, 1, 2]);
    expect(MIN_IDLE_MS).toBe(2);
  });

  it('does nothing when the idle period is already over', () => {
    const log: number[] = [];
    expect(runSlice(count(3, log), deadline(1.9))).toBe(false);
    expect(log).toEqual([]);
  });

  it('never runs longer than MAX_SLICE_MS, however much idle time is offered', () => {
    const log: number[] = [];
    let t = 0;
    const clock = () => (t += 5);
    expect(runSlice(count(10, log), deadline(50), clock)).toBe(false);
    expect(log.length).toBe(Math.floor((MAX_SLICE_MS - 1) / 5));
  });

  it('takes a longer limit when given one', () => {
    const log: number[] = [];
    let t = 0;
    expect(runSlice(count(20, log), deadline(50), () => (t += 5), 40)).toBe(false);
    expect(log.length).toBe(7);
  });

  it('reports when every step has run', () => {
    const log: number[] = [];
    expect(runSlice(count(3, log), deadline(50))).toBe(true);
    expect(log).toEqual([0, 1, 2]);
  });
});

describe('runWhenIdle', () => {
  it('works through the steps a slice per idle period', () => {
    const { queue } = fakeIdle();
    const log: number[] = [];
    const done = vi.fn();
    runWhenIdle(count(7, log), done);
    let slices = 0;
    while (queue.length) {
      slices++;
      // Room for three steps each time.
      queue.shift()!(deadline(9, 3));
    }
    expect(log).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(slices).toBe(3);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('stops when cancelled', () => {
    const { queue, cancelled } = fakeIdle();
    const log: number[] = [];
    const done = vi.fn();
    const cancel = runWhenIdle(count(7, log), done);
    queue.shift()!(deadline(9, 3));
    cancel();
    expect(cancelled.length).toBe(1);
    // A callback that was already on its way does nothing.
    queue.shift()?.(deadline(50));
    expect(log).toEqual([0, 1, 2]);
    expect(done).not.toHaveBeenCalled();
  });
});

describe('whenIdle', () => {
  it('falls back to short timed slices without requestIdleCallback', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const cb = vi.fn((d: IdleDeadlineLike) => d.timeRemaining());
    const cancel = whenIdle(cb);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    const left = cb.mock.results[0].value as number;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(8);
    cancel();
  });

  it('can be cancelled before it runs', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const cb = vi.fn();
    whenIdle(cb)();
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('compileSteps', () => {
  it('runs each regex on one-byte and two-byte text, a step each, and leaves lastIndex alone', () => {
    const global = /a+/g;
    const sticky = /b/y;
    global.lastIndex = 3;
    sticky.lastIndex = 5;
    const seen = new Set<RegExp>();
    const spy = vi.spyOn(global, 'test');
    const steps = [...compileSteps([global, sticky, global], seen)];
    expect(steps.length).toBe(4); // the repeat is skipped
    expect(spy).toHaveBeenCalledTimes(2);
    const texts = spy.mock.calls.map(([t]) => t);
    expect(texts.every((t) => t.length >= 1000)).toBe(true);
    expect(texts.some((t) => [...t].some((c) => c.charCodeAt(0) > 0xff))).toBe(true);
    expect(global.lastIndex).toBe(3);
    expect(sticky.lastIndex).toBe(5);
    // Already seen in an earlier batch: nothing to do.
    expect([...compileSteps([sticky], seen)].length).toBe(0);
  });
});

describe('textKind', () => {
  it('tells Latin-1 text from text that needs two bytes a character', () => {
    expect(textKind('https://www.instagram.com/p/abc/')).toBe('one');
    expect(textKind('Café Luz, São Paulo — no, wait')).toBe('two'); // the dash
    expect(textKind('Café Luz, São Paulo')).toBe('one');
    expect(textKind('Lisbon 🇵🇹')).toBe('two');
    expect(textKind('灣仔')).toBe('two');
    expect(textKind('It’s great')).toBe('two');
  });
});

describe('compileSteps with a focus', () => {
  it('compiles only the kind someone waits on, and leaves the other for later', () => {
    const re = /a+/u;
    const spy = vi.spyOn(re, 'test');
    let focus: TextKind | undefined = 'two';
    const later: (() => void)[] = [];
    const steps = [...compileSteps([re], new Set(), () => focus, later)];
    expect(steps.length).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...(spy.mock.calls[0][0] as string)].every((c) => c.charCodeAt(0) > 0xff)).toBe(true);
    expect(later.length).toBe(1);
    later[0]();
    expect([...(spy.mock.calls[1][0] as string)].every((c) => c.charCodeAt(0) <= 0xff)).toBe(true);
    // Nobody waiting: both kinds, as usual.
    focus = undefined;
    const other = /b+/u;
    expect([...compileSteps([other], new Set(), () => focus, later)].length).toBe(2);
    expect(later.length).toBe(1);
  });
});

describe('warmSteps', () => {
  it('builds the place tables in many small steps, ending up exactly as an on-demand build', async () => {
    vi.resetModules();
    const stepped = await import('./location');
    let steps = 1;
    while (!stepped.warmTablesStep()) steps++;
    expect(steps).toBeGreaterThan(20);

    vi.resetModules();
    const direct = await import('./location');
    // Built all at once by lookups: the gazetteer, then the device-language names.
    direct.guessCountry('Lisbon');
    expect(direct.warmTablesStep()).toBe(false);
    direct.countryCodeFor('Narnia');
    expect(direct.warmTablesStep()).toBe(true);

    vi.resetModules();
    const mixed = await import('./location');
    for (let i = 0; i < 5; i++) mixed.warmTablesStep();
    // A lookup halfway through finishes the build on the spot.
    expect(mixed.countryCodeFor('Portugal')).toBe('PT');
    expect(mixed.countryCodeFor('Narnia')).toBeUndefined();
    expect(mixed.warmTablesStep()).toBe(true);

    const source = (m: typeof stepped) => m.warmRegExps()[0].source;
    expect(source(stepped).length).toBeGreaterThan(1000);
    expect(source(direct)).toBe(source(stepped));
    expect(source(mixed)).toBe(source(stepped));

    const texts = [
      'Weekend in Lisbon 🇵🇹 then Porto',
      'Best ramen in Kyoto, Japan',
      '📍 Borough Market, London',
      'Roast turkey recipe for Thanksgiving',
      'Moving to LA next month',
      'Austin, TX — BBQ crawl',
    ];
    for (const m of [direct, mixed]) {
      for (const t of texts) {
        expect(m.guessCountry(t)).toEqual(stepped.guessCountry(t));
        expect(m.extractLocationHints(t)).toEqual(stepped.extractLocationHints(t));
      }
      expect(m.countryCodeFor('Deutschland', 'de')).toBe(stepped.countryCodeFor('Deutschland', 'de'));
    }
  });

  it('runs to the end in small steps and leaves the analysis working as before', async () => {
    vi.resetModules();
    const warm = await import('./warmup');
    const { classify } = await import('./classify');
    const { findWhen } = await import('./when');
    const { extractLocationHints, warmTablesStep } = await import('./location');
    const text = 'Live fado at Tasca do Chico, Lisbon — Sat 12 Oct 9pm #fado https://www.instagram.com/p/abc/';
    const before = { c: classify({ text }), w: findWhen(text, new Date(2026, 9, 1)), h: extractLocationHints(text) };
    let steps = 0;
    for (const _ of warm.warmSteps()) steps++;
    expect(steps).toBeGreaterThan(200);
    expect(warmTablesStep()).toBe(true);
    expect(classify({ text })).toEqual(before.c);
    expect(findWhen(text, new Date(2026, 9, 1))).toEqual(before.w);
    expect(extractLocationHints(text)).toEqual(before.h);
  });

  it('gets each stage ready sooner for the kind of text someone waits on, then does the rest', async () => {
    vi.resetModules();
    const warm = await import('./warmup');
    const run = (focus?: TextKind) => {
      const at: Record<string, number> = {};
      let steps = 0;
      for (const stage of warm.warmSteps(() => focus)) {
        steps++;
        if (stage) at[stage] = steps;
      }
      return { at, steps };
    };
    run(); // builds the place tables, which later runs then skip
    const plain = run();
    const focused = run('two');
    expect(Object.keys(focused.at)).toEqual(['classify', 'dates', 'places']);
    for (const stage of ['classify', 'dates', 'places']) expect(focused.at[stage]).toBeLessThan(plain.at[stage] * 0.6);
    // Nothing is dropped: what was skipped runs once the stages are done.
    expect(focused.steps).toBe(plain.steps);
  });
});

describe('startWarmup', () => {
  it('waits for the delay, then runs in idle slices; once done, later calls do nothing', async () => {
    vi.resetModules();
    const { startWarmup: start } = await import('./warmup');
    vi.useFakeTimers();
    const { queue } = fakeIdle();
    start(1000);
    vi.advanceTimersByTime(999);
    expect(queue.length).toBe(0);
    vi.advanceTimersByTime(1);
    expect(queue.length).toBe(1);
    let slices = 0;
    while (queue.length) {
      slices++;
      queue.shift()!(deadline(50, 1));
    }
    expect(slices).toBeGreaterThan(1);
    start(0);
    vi.advanceTimersByTime(10);
    expect(queue.length).toBe(0);
  });

  it('can be cancelled before it starts', () => {
    vi.useFakeTimers();
    const { queue } = fakeIdle();
    startWarmup(500)();
    vi.advanceTimersByTime(1000);
    expect(queue.length).toBe(0);
  });
});

describe('stages and hurrying', () => {
  it('reports each stage as it finishes, in order', async () => {
    vi.resetModules();
    const warm = await import('./warmup');
    const { queue } = fakeIdle();
    const seen: string[] = [];
    const off = warm.subscribeWarm(() => seen.push((['classify', 'dates', 'places'] as const).filter((s) => warm.isWarm(s)).join('+')));
    const classified = warm.whenWarm('classify');
    vi.useFakeTimers();
    warm.startWarmup(0);
    vi.advanceTimersByTime(0);
    expect(warm.isWarm('classify')).toBe(false);
    while (queue.length) queue.shift()!(deadline(50, 1));
    off();
    expect(seen).toEqual(['classify', 'classify+dates', 'classify+dates+places']);
    expect(warm.isWarm()).toBe(true);
    await expect(classified).resolves.toBeUndefined();
    await expect(warm.whenWarm('places')).resolves.toBeUndefined();
  });

  /** A clock that moves on with every look, so slices end after a few steps however fast this machine is. */
  function slowClock(perLook = 5) {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (t += perLook));
  }

  it('runs back to back while hurried, without waiting for idle time, and stops hurrying once released', async () => {
    vi.resetModules();
    const warm = await import('./warmup');
    const { queue } = fakeIdle();
    slowClock();
    const release = warm.hurryWarmup();
    // No idle callback runs here: the hurried slices get there on their own.
    await warm.whenWarm('classify');
    expect(queue.length).toBe(0);
    release();
    // Nobody waits and nothing started it: it pauses where it is…
    await new Promise((r) => setTimeout(r, 20));
    expect(warm.isWarm('places')).toBe(false);
    // …and carries on in idle time once started.
    warm.startWarmup(0);
    await vi.waitFor(() => expect(queue.length).toBe(1));
    const again = warm.hurryWarmup();
    // A hurry takes over from the idle callback.
    await warm.whenWarm('places');
    again();
    expect(warm.isWarm()).toBe(true);
  });

  it('gets ready for the kind of text waiting first, unless those waiting have different kinds', async () => {
    vi.resetModules();
    const warm = await import('./warmup');
    fakeIdle();
    slowClock();
    const kinds = new Set<TextKind>();
    const test = RegExp.prototype.test;
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, s: string) {
      if (s.length === 1000) kinds.add(s.charCodeAt(0) > 0xff ? 'two' : 'one');
      return test.call(this, s);
    });
    const shared = warm.hurryWarmup('two');
    await warm.whenWarm('classify');
    expect([...kinds]).toEqual(['two']);
    kinds.clear();
    const typed = warm.hurryWarmup('one');
    await warm.whenWarm('dates');
    expect([...kinds].sort()).toEqual(['one', 'two']);
    shared();
    typed();
  });

  it("yields between hurried slices, so taps and typing aren't held up", async () => {
    vi.resetModules();
    const warm = await import('./warmup');
    fakeIdle();
    slowClock();
    let ticked = false;
    setTimeout(() => (ticked = !warm.isWarm()), 0);
    const release = warm.hurryWarmup();
    await warm.whenWarm('places');
    release();
    // A timer set before the warm-up got its turn before the warm-up was done.
    expect(ticked).toBe(true);
  });
});
