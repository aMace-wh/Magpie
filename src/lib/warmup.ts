import { classify, cleanTitle, hashtags, warmRegExps as classifyRegExps } from './classify';
import { extractLocationHints, guessCountry, warmRegExps as locationRegExps, warmTablesStep } from './location';
import { findWhen, warmRegExps as whenRegExps } from './when';

/**
 * Work done in small slices while the browser is idle, so none of it shows up as a long task: the warm-up that
 * gets the text analysis ready before the first paste or share, and (via whenIdle) the library grid adding its
 * cards bit by bit.
 */

export interface IdleDeadlineLike {
  timeRemaining(): number;
}

/** A slice stops once less than this is left of the idle period… */
export const MIN_IDLE_MS = 2;
/** …or after this long, so a tap or a database answer never waits long behind it. */
export const MAX_SLICE_MS = 12;
/** While someone waits on the warm-up (the save sheet has text to analyse), slices run back to back, this long each. */
export const HURRY_SLICE_MS = 40;
// Without requestIdleCallback (Safari): slices this long, each after a short pause.
const FALLBACK_SLICE_MS = 8;
const FALLBACK_DELAY_MS = 25;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Calls `cb` once the browser is idle (or after a short pause where it can't tell). Returns a cancel function. */
export function whenIdle(cb: (deadline: IdleDeadlineLike) => void, opts: { timeout?: number } = {}): () => void {
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(cb, opts.timeout ? { timeout: opts.timeout } : undefined);
    return () => cancelIdleCallback(id);
  }
  const t = setTimeout(() => {
    const start = now();
    cb({ timeRemaining: () => Math.max(0, FALLBACK_SLICE_MS - (now() - start)) });
  }, FALLBACK_DELAY_MS);
  return () => clearTimeout(t);
}

/** Calls `cb` as soon as the browser has handled what's waiting (input, a frame), without timer clamping. */
function soon(cb: () => void): () => void {
  if (typeof MessageChannel === 'function') {
    let live = true;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      if (live) cb();
    };
    channel.port2.postMessage(null);
    return () => {
      live = false;
      channel.port1.close();
    };
  }
  const t = setTimeout(cb, 0);
  return () => clearTimeout(t);
}

/**
 * Runs steps while the deadline leaves at least MIN_IDLE_MS and the slice is under `maxMs` (MAX_SLICE_MS). Each
 * step should be small: a step is never cut short. True once every step has run.
 */
export function runSlice(steps: Iterator<unknown>, deadline: IdleDeadlineLike, clock: () => number = now, maxMs = MAX_SLICE_MS): boolean {
  const end = clock() + maxMs;
  while (deadline.timeRemaining() >= MIN_IDLE_MS && clock() < end) {
    if (steps.next().done) return true;
  }
  return false;
}

/** Works through `steps` a slice per idle period. Returns a cancel function. */
export function runWhenIdle(steps: Iterator<unknown>, onDone?: () => void): () => void {
  let stopped = false;
  let cancel = () => {};
  const slice = (deadline: IdleDeadlineLike) => {
    if (stopped) return;
    if (runSlice(steps, deadline)) onDone?.();
    else cancel = whenIdle(slice);
  };
  cancel = whenIdle(slice);
  return () => {
    stopped = true;
    cancel();
  };
}

// ---------------------------------------------------------------------------
// Warm-up

/**
 * How an engine stores a piece of text: one byte a character when it's all Latin-1, two otherwise (an emoji, CJK,
 * curly quotes…). A regex compiles separately for each.
 */
export type TextKind = 'one' | 'two';
const KINDS: readonly TextKind[] = ['one', 'two'];

/** How `text` is stored, so the warm-up can get the analysis ready for that kind of text first. */
export function textKind(text: string): TextKind {
  return /[^\0-\xff]/.test(text) ? 'two' : 'one';
}

// From 1,000 characters V8 compiles a regex straight to machine code rather than to bytecode first, and
// one-byte and two-byte text get separate code (in JavaScriptCore too), so one of each. Neither has letters,
// digits or spaces, so no pattern gets far into them before failing.
const WARM_TEXT: Record<TextKind, string> = { one: '\0'.repeat(1000), two: '\uFFFF'.repeat(1000) };

// A typical short share, so each analysis runs its usual paths once and its smaller inline regexes compile too.
const SAMPLE = 'Dinner at Café Luz in Lisbon 🇵🇹 Sat 12 Oct, 8pm #food https://example.com/menu-for-two';

function compile(re: RegExp, kind: TextKind): void {
  const last = re.lastIndex;
  re.lastIndex = 0;
  re.test(WARM_TEXT[kind]);
  re.lastIndex = last;
}

/**
 * Compiles each regex not seen yet, a step per regex and kind of text. While `focus()` names a kind (someone waits
 * on text of that kind), only that kind is compiled now and the other is added to `later`. Leaves lastIndex as it was.
 */
export function* compileSteps(
  patterns: RegExp[],
  seen = new Set<RegExp>(),
  focus: () => TextKind | undefined = () => undefined,
  later: (() => void)[] = [],
): Generator<void> {
  for (const re of patterns) {
    if (seen.has(re)) continue;
    seen.add(re);
    for (const kind of KINDS) {
      const only = focus();
      if (only && only !== kind) {
        later.push(() => compile(re, kind));
        continue;
      }
      compile(re, kind);
      yield;
    }
  }
}

/** The parts of the analysis, in the order the warm-up gets them ready. */
export type WarmStage = 'classify' | 'dates' | 'places';
const STAGES: readonly WarmStage[] = ['classify', 'dates', 'places'];

function quietly(run: () => unknown): void {
  try {
    run();
  } catch {
    // Only a warm-up: the real call reports its own errors.
  }
}

/**
 * The warm-up, one small step at a time, a stage per part of the analysis so each can be used as soon as it's
 * ready: classify (it runs on everything pasted or shared), then dates, then places (whose hints skip dates).
 * Each stage compiles its keyword regexes, then runs its analysis on a sample, twice (a regex's second run
 * compiles it again, to machine code), which also compiles its smaller inline regexes. Yields a stage's name
 * once it is done.
 *
 * While `focus()` names a kind of text, someone is waiting to analyse text of that kind: a stage then only
 * compiles for that kind and skips the sample (the real analysis, coming next, does the same work for its own
 * text), so it's ready in about half the time. What was skipped runs at the end.
 */
export function* warmSteps(focus: () => TextKind | undefined = () => undefined): Generator<WarmStage | void> {
  const seen = new Set<RegExp>();
  const later: (() => unknown)[] = [];
  const compileAll = (patterns: RegExp[]) => compileSteps(patterns, seen, focus, later);
  function* samples(runs: (() => unknown)[]): Generator<void> {
    if (focus()) {
      later.push(...runs);
      return;
    }
    for (const run of runs) {
      quietly(run);
      yield;
    }
  }

  yield* compileAll(classifyRegExps());
  yield* samples([() => hashtags(SAMPLE), () => cleanTitle(SAMPLE), () => classify({ text: SAMPLE }), () => classify({ text: SAMPLE })]);
  yield 'classify';
  yield* compileAll(whenRegExps());
  yield* samples([() => findWhen(SAMPLE), () => findWhen(SAMPLE)]);
  yield 'dates';
  while (!warmTablesStep()) yield;
  yield;
  yield* compileAll(locationRegExps());
  yield* samples([() => extractLocationHints(SAMPLE), () => extractLocationHints(SAMPLE), () => guessCountry(SAMPLE)]);
  yield 'places';
  // What was skipped while someone waited.
  for (const run of later) {
    quietly(run);
    yield;
  }
}

// ---------------------------------------------------------------------------
// Running it

/** Stages done so far (0 to STAGES.length). */
let reached = 0;
/** Every step has run, including what was skipped for someone waiting. */
let finished = false;
let steps: Iterator<void> | undefined;
/** startWarmup() calls past their delay and not cancelled. */
let runs = 0;
/** hurryWarmup() calls not released, each with the kind of text it waits on (if it said). */
const hurries: { kind?: TextKind }[] = [];
/** The next slice, if one is scheduled, and whether it was scheduled in a hurry. */
let next: { cancel: () => void; hurry: boolean } | undefined;
const listeners = new Set<() => void>();

/** The kind of text everyone waiting has, if they agree. */
function focus(): TextKind | undefined {
  const kind = hurries[0]?.kind;
  return hurries.every((h) => h.kind === kind) ? kind : undefined;
}

function reach(stage: WarmStage) {
  const n = STAGES.indexOf(stage) + 1;
  if (n <= reached) return;
  reached = n;
  listeners.forEach((l) => l());
}

function* tracked(): Generator<void> {
  for (const stage of warmSteps(focus)) {
    if (stage) reach(stage);
    yield;
  }
  finished = true;
}

/** Schedules the next slice: right away while someone is waiting, otherwise when the browser is idle. */
function pump() {
  const hurry = hurries.length > 0;
  if (finished || (!runs && !hurry)) {
    next?.cancel();
    next = undefined;
    return;
  }
  if (next && (next.hurry || !hurry)) return;
  next?.cancel();
  const slice = (deadline: IdleDeadlineLike) => {
    next = undefined;
    if (finished || (!runs && !hurries.length)) return;
    steps ??= tracked();
    runSlice(steps, deadline, now, hurries.length ? HURRY_SLICE_MS : MAX_SLICE_MS);
    pump();
  };
  next = hurry ? { cancel: soon(() => slice({ timeRemaining: () => HURRY_SLICE_MS })), hurry } : { cancel: whenIdle(slice), hurry };
}

/** Whether `stage` (by default all three) is done, so that part of the analysis is quick now. */
export function isWarm(stage: WarmStage = 'places'): boolean {
  return reached > STAGES.indexOf(stage);
}

/** Calls `listener` whenever a stage finishes. Returns the unsubscribe. */
export function subscribeWarm(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolves once `stage` is done. Doesn't start or hurry the warm-up by itself. */
export function whenWarm(stage: WarmStage = 'places'): Promise<void> {
  if (isWarm(stage)) return Promise.resolve();
  return new Promise((resolve) => {
    const off = subscribeWarm(() => {
      if (!isWarm(stage)) return;
      off();
      resolve();
    });
  });
}

/**
 * Gets the text analysis ready in idle time: compiles its regexes and builds its place tables in small slices,
 * starting `delay` ms from now. Otherwise the first paste or share does it all at once, which freezes a phone for
 * a second or two. Returns a cancel function; once finished, later calls do nothing.
 */
export function startWarmup(delay = 0): () => void {
  if (finished) return () => {};
  let started = false;
  const timer = setTimeout(() => {
    started = true;
    runs++;
    pump();
  }, delay);
  return () => {
    clearTimeout(timer);
    if (!started) return;
    started = false;
    runs--;
    pump();
  };
}

/**
 * Someone is waiting on the analysis (the save sheet has text in it): runs the rest of the warm-up now, in
 * back-to-back slices short enough to keep taps and typing responsive, rather than waiting for idle time.
 * Starts it if it hasn't started. Given the kind of text waiting (textKind), the stages get ready for that kind
 * first. Returns a release; the warm-up goes back to idle time once nobody waits.
 */
export function hurryWarmup(kind?: TextKind): () => void {
  if (finished) return () => {};
  const hurry = { kind };
  hurries.push(hurry);
  pump();
  return () => {
    const i = hurries.indexOf(hurry);
    if (i < 0) return;
    hurries.splice(i, 1);
    pump();
  };
}
