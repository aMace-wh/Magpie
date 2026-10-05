import { CalendarPlus, ClipboardPaste, Gift, X, Zap } from 'lucide-react';
import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { classify, cleanTitle, handedText, itemFieldsFrom, parseShared, type Classification, type SharedInput } from '../lib/classify';
import { allTags, buildItem, db, dbHealth, saveItem } from '../lib/db';
import { isAlreadySaved, isStorageFailure } from '../lib/dbHealth';
import { confirmDraft, draftFor, findDraft, isConfirmed, markSaving, rememberDraft, type Choice, type UnsavedDraft } from '../lib/drafts';
import { countryHint, enrichItem, locationHints, pickResult, placeFromResult, type EnrichOptions } from '../lib/enrich';
import { searchPlaces } from '../lib/geo';
import { useLiveQuery } from '../lib/live';
import { flagEmoji, placeCountryCode, placeLabel } from '../lib/location';
import { navigate } from '../lib/router';
import { useSettings } from '../lib/settings';
import { parseShareInput } from '../lib/share';
import { matchesRules } from '../lib/smart';
import { EDITED_FIELDS, TYPE_INFO, type Item, type ItemType, type Place, type When } from '../lib/types';
import { hurryWarmup, isWarm, subscribeWarm, textKind, whenWarm, type WarmStage } from '../lib/warmup';
import { findWhen, formatWhen, type WhenMatch } from '../lib/when';
import { DbStatus } from './DbStatus';
import { DetectedInfo } from './DetectedInfo';
import { Sheet } from './Sheet';
import { TagInput } from './TagInput';
import { useToast } from './Toast';
import { WhenBadge } from './WhenBadge';
import { WhenEditor } from './WhenEditor';
import './SaveSheet.css';

interface Props {
  open: boolean;
  initial?: SharedInput;
  /** Pre-select a collection (when saving from inside one). */
  collectionId?: string;
  /** The id of an unsaved draft to bring back (Magpie was reloaded to get its storage working). */
  draft?: string;
  onClose: () => void;
}

// What the sheet works with while it's closed or empty, so nothing has to be analysed then (the first
// analysis compiles hundreds of regexes, which is slow on a phone).
const NO_GUESS: Classification = { type: 'note', title: '', tags: [], reasons: [], confidence: 'medium', alternatives: [] };
const NO_HINTS: string[] = [];
const NO_TAGS: { tag: string; count: number }[] = [];
/** While typing, the analysis waits for a pause this long, so each keystroke paints straight away. */
const TYPING_PAUSE_MS = 150;

/** Remembers the last answer, so a render React throws away (or Save straight after) doesn't redo the work. */
const forgetters: (() => void)[] = [];
function last<T>(fn: (text: string) => T): (text: string) => T {
  let key: string | undefined;
  let value: T;
  forgetters.push(() => (key = undefined));
  return (text) => {
    if (text !== key) {
      value = fn(text);
      key = text;
    }
    return value;
  };
}
const guessOf = last((text) => classify({ text }));
const shareOf = last((text) => parseShareInput(text, { bare: false }));
const dateOf = last((text) => findWhen(text));
const hintsOf = last((text) => locationHints(text, 3));

/** Reloads Magpie and reopens this sheet with the same draft (and id), the way shared links arrive. */
function reloadWithDraft(draft: UnsavedDraft) {
  rememberDraft(draft);
  const params = new URLSearchParams({ text: draft.text, draft: draft.id });
  if (draft.collectionIds[0]) params.set('collection', draft.collectionIds[0]);
  const url = new URL(location.href);
  url.search = `?${params}`;
  url.hash = '#/';
  location.replace(url.href);
}

/** Whether a part of the text analysis is warmed up (quick) yet. */
function useWarm(stage: WarmStage): boolean {
  return useSyncExternalStore(
    subscribeWarm,
    () => isWarm(stage),
    () => false,
  );
}

/** Joins the pieces a share sheet hands us into one editable blob. */
function initialText(input?: SharedInput): string {
  if (!input) return '';
  const parts = [input.title, input.text].map((s) => s?.trim()).filter(Boolean) as string[];
  const url = input.url?.trim();
  if (url && !parts.some((p) => p.includes(url))) parts.push(url);
  return [...new Set(parts)].join('\n');
}

/** "Hot Clube de Portugal · Lisbon, Portugal" */
function placeText(place: Place): string {
  const label = placeLabel(place);
  const name = place.name?.trim();
  if (name && label && !label.toLowerCase().startsWith(name.toLowerCase())) return `${name} · ${label}`;
  return name || label || 'Location found in the link';
}

export function SaveSheet({ open, initial, collectionId, draft, onClose }: Props) {
  const toast = useToast();
  const { previews } = useSettings();
  const [raw, setRaw] = useState('');
  // What the analysis looks at: the box, except while typing, when it catches up once typing pauses.
  const [settled, setSettled] = useState('');
  const shown = useRef('');
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pasting = useRef(false);
  // Text other apps handed over (share sheet, clipboard, paste, drop): the only text kept as the original post.
  const [handed, setHanded] = useState<string[]>([]);
  const [type, setType] = useState<ItemType | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [tags, setTags] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [when, setWhen] = useState<Choice<When>>(null);
  const [place, setPlace] = useState<Choice<Place>>(null);
  const [editingWhen, setEditingWhen] = useState(false);
  const [locating, setLocating] = useState<string | null>(null);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const search = useRef<AbortController | null>(null);
  // Counts openings, so a slow save doesn't close a sheet opened since; `busy` is the opening whose save is
  // under way (a double tap does nothing, but a slow save from before doesn't block a new one).
  const session = useRef(0);
  const busy = useRef(0);
  // One id for every attempt to save this draft: trying again after a failure can't make a copy, even if
  // the first write was only held up (say, behind another tab) and lands later.
  const draftId = useRef('');

  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').toArray(), []) ?? [];
  const knownTags = useLiveQuery(() => (open ? allTags() : []), [open]) ?? NO_TAGS;
  // Stable props, so typing doesn't redraw the parts of the form it doesn't change.
  const tagSuggestions = useMemo(() => knownTags.map((t) => t.tag), [knownTags]);
  const saveWhen = useCallback((w: When | undefined) => setWhen({ value: w }), []);
  const closeWhen = useCallback(() => setEditingWhen(false), []);

  /** Puts text in the box. Typed text reaches the analysis after a pause; pasted or shared text right away. */
  const setText = (value: string, typed = false) => {
    setRaw(value);
    clearTimeout(pause.current);
    const analyse = () => {
      shown.current = value;
      setSettled(value);
    };
    // The first letters typed into an empty box go straight through, so "Detecting…" doesn't flash.
    if (typed && shown.current.trim()) pause.current = setTimeout(analyse, TYPING_PAUSE_MS);
    else analyse();
  };

  useEffect(() => () => clearTimeout(pause.current), []);

  useEffect(() => {
    session.current++;
    if (!open) {
      // Nothing to analyse while closed; the next opening starts afresh anyway.
      setText('');
      return;
    }
    // A draft whose save didn't go through comes back as it was, under the same id: brought back after a
    // reload, or the same text shared again. (Saving only adds, so if it's in the library by now, Save says so.)
    const restored = draft ? findDraft(draft) : undefined;
    const text = restored?.text ?? initialText(initial);
    const earlier = restored ?? draftFor(text);
    setText(text);
    setHanded(earlier?.handed ?? (text ? [text] : []));
    setType(earlier?.type ?? null);
    setTitle(earlier?.title ?? null);
    setTags(earlier?.tags ?? null);
    setNote(earlier?.note ?? null);
    setWhen(earlier?.when ?? null);
    setPlace(earlier?.place ?? null);
    setEditingWhen(false);
    setLocating(null);
    setCollectionIds(earlier?.collectionIds ?? (collectionId ? [collectionId] : []));
    setSaving(false);
    // A draft brought back after a reload keeps its id even if its details are gone (it landed and was let go).
    draftId.current = earlier?.id ?? draft ?? '';
    // Fresh answers for each opening ("tomorrow" moves on).
    forgetters.forEach((forget) => forget());
    return () => {
      // Closing the sheet cancels a place search that's still queued.
      search.current?.abort();
      search.current = null;
    };
  }, [open, initial, collectionId, draft]);

  // The analysis follows the box a step behind (useDeferredValue), so typed and pasted text shows first, and
  // only runs while the sheet is open with something in it. Run cold, its first go compiles hundreds of regexes
  // in one block (a second or more on a phone), so each part waits for its stage of the warm-up, which is hurried
  // along in short slices meanwhile, for this kind of text first. Dates and places follow in a pass of their own.
  const hasContent = raw.trim().length > 0;
  const kind = hasContent ? textKind(raw) : undefined;
  const warmType = useWarm('classify');
  const warmDates = useWarm('dates');
  const warmPlaces = useWarm('places');
  useEffect(() => (open && kind && !warmPlaces ? hurryWarmup(kind) : undefined), [open, kind, warmPlaces]);
  const text = useDeferredValue(settled, '');
  const [later, setLater] = useState('');
  useEffect(() => startTransition(() => setLater(text)), [text]);
  const live = open && text.trim() !== '' && warmType;
  const liveLater = live && later.trim() !== '';
  const guess = useMemo(() => (live ? guessOf(text) : NO_GUESS), [live, text]);
  const sharePayload = useMemo(() => (live ? shareOf(text) : undefined), [live, text]);
  const found = useMemo(() => (liveLater && warmDates ? dateOf(later) : undefined), [liveLater, warmDates, later]);
  const hints = useMemo(() => (liveLater && warmPlaces ? hintsOf(later) : NO_HINTS), [liveLater, warmPlaces, later]);
  const detecting = hasContent && text !== raw;
  const share = hasContent ? sharePayload : undefined;

  /** What will be saved: the user's choices, with Magpie's guesses for the rest. */
  const resolve = (g: Classification, f: WhenMatch | undefined) => {
    const t = type ?? g.type;
    // Clear dates are filled in straight away (so are loose ones, for events); others are offered.
    const autoWhen = f && (f.confidence === 'high' || t === 'event') ? f.when : undefined;
    return {
      type: t,
      title: title ?? g.title,
      tags: tags ?? g.tags,
      note: note ?? g.note ?? '',
      when: when ? when.value : autoWhen,
      place: place ? place.value : g.place,
    };
  };
  const { type: effType, title: effTitle, tags: effTags, note: effNote, when: effWhen, place: effPlace } = resolve(guess, found);

  const shownGuess = useMemo<Classification>(() => {
    // A clear date in a plain link or note hints it might be an event: offer that as a one-tap alternative.
    const offerEvent = found?.confidence === 'high' && (guess.type === 'link' || guess.type === 'note') && !guess.alternatives.includes('event');
    // Once the user has changed the location, it's no longer "found in the link".
    if (!offerEvent && place === null) return guess;
    return {
      ...guess,
      alternatives: offerEvent ? (['event', ...guess.alternatives] as ItemType[]).slice(0, 3) : guess.alternatives,
      place: place === null ? guess.place : undefined,
    };
  }, [guess, found, place]);

  const preview = useMemo(
    () => buildItem({ type: effType, title: effTitle, tags: effTags, place: effPlace, when: effWhen }),
    [effType, effTitle, effTags, effPlace, effWhen],
  );
  const manual = collections.filter((c) => c.kind === 'manual');
  const smartHits = collections.filter((c) => c.kind === 'smart' && c.rules && matchesRules(preview, c.rules));

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setText(text);
        setHanded((h) => [...h, text]);
      }
    } catch {
      toast('Clipboard access was blocked — long-press the box and paste instead.');
    }
  };

  const openShare = (payload: string | undefined) => {
    if (!payload) return;
    onClose();
    navigate(`/import/${payload}`);
  };

  /** Looks a hint up on the map (only when tapped) and uses the best result. */
  const locate = async (hint: string) => {
    search.current?.abort();
    const ctrl = new AbortController();
    search.current = ctrl;
    setLocating(hint);
    try {
      const results = await searchPlaces(hint, undefined, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      const best = pickResult(results, countryHint(hint, raw));
      if (best) setPlace({ value: placeFromResult(best) });
      else toast(`Couldn't find “${hint}” on the map. You can add a location after saving.`);
    } catch (e) {
      if (!ctrl.signal.aborted) toast((e as Error).message || "Couldn't search for places right now.");
    } finally {
      if (search.current === ctrl) {
        search.current = null;
        setLocating(null);
      }
    }
  };

  /** The sheet as it is, to remember while saving (and bring back after a reload). */
  const snapshot = (enrich: EnrichOptions): UnsavedDraft => {
    draftId.current ||= buildItem({ type: 'note', title: '' }).id;
    return { id: draftId.current, text: raw, handed, type, title, tags, note, when, place, collectionIds, enrich, at: Date.now() };
  };

  const enrichOptions = (): EnrichOptions => ({
    // Boilerplate like "Check out @chef's video!" isn't worth keeping over the page's real title.
    replaceTitle: title === null && !cleanTitle(parseShared({ text: raw }).title),
    reclassify: type === null,
    dates: when === null,
    locate: place === null,
  });

  /** What the user picked in the sheet themselves, which the automatic analysis then leaves alone. */
  const userChoices = (): Pick<Item, 'edited'> => {
    const edited = EDITED_FIELDS.filter((f) => ({ title, type, when, place, tags })[f] !== null);
    return edited.length ? { edited } : {};
  };

  const reloadNow = () => reloadWithDraft(snapshot(enrichOptions()));

  const saveFailed = (e: unknown, kept: UnsavedDraft) => {
    const reload = { label: 'Reload', onClick: () => reloadWithDraft(kept) };
    const status = dbHealth.getSnapshot().status;
    if ((e as Error | null)?.name === 'DatabaseBlockedError' || status === 'blocked') {
      toast('Not saved yet — Magpie is open in another tab or window. Close it, then tap Save again.', undefined, { duration: 8000 });
    } else if (status === 'outdated') {
      toast('Not saved — Magpie was updated in another tab. Reload to keep going; your draft stays.', reload, { duration: 10000 });
    } else if (isStorageFailure(e)) {
      toast("Couldn't save — Magpie's storage isn't responding", reload, { duration: 10000 });
    } else {
      toast(`Couldn't save: ${(e as Error | null)?.message ?? 'something went wrong'}`);
    }
  };

  /** An earlier attempt at this draft landed after all: what's in the library is left as it is. */
  const alreadySaved = (id: string, mine: number) => {
    confirmDraft(id);
    if (session.current === mine) onClose();
    toast('Already in your Magpie', { label: 'View', onClick: () => navigate(`/item/${id}`) });
  };

  const save = async () => {
    const mine = session.current;
    if (busy.current === mine) return;
    busy.current = mine;
    let item: Item;
    let kept: UnsavedDraft | undefined;
    try {
      // Right after a share or paste the analysis may not be warmed up yet: let the parts saving needs (type,
      // date) finish in short slices, with the spinner going, rather than running them cold in one long block.
      if (!isWarm('dates')) {
        setSaving(true);
        const release = hurryWarmup(textKind(raw));
        await whenWarm('dates');
        release();
        if (session.current !== mine) return;
      }
      // The analysis may be a step behind a quick tap: work it out now for exactly what's in the box.
      const payload = shareOf(raw);
      if (payload) return openShare(payload);
      if (!raw.trim()) return setSaving(false);
      // An earlier attempt that failed has turned up in the library since.
      if (draftId.current && isConfirmed(draftId.current)) return alreadySaved(draftId.current, mine);
      const g = guessOf(raw);
      const v = resolve(g, dateOf(raw));
      setSaving(true);
      search.current?.abort();
      kept = snapshot(enrichOptions());
      const built = buildItem({
        ...itemFieldsFrom(g),
        sharedText: handedText(raw, handed),
        type: v.type,
        title: v.title.trim() || 'Untitled',
        note: v.note.trim() || undefined,
        tags: v.tags,
        place: v.place,
        ...(v.when && { when: v.when }),
        ...userChoices(),
        collectionIds,
      });
      // Remembered until it's confirmed, in case the write is held up and lands later.
      rememberDraft(kept);
      markSaving(kept.id, true);
      // Times out instead of spinning forever when storage stops answering (reopening it and retrying once).
      item = await saveItem({ ...built, id: kept.id });
      confirmDraft(kept.id);
    } catch (e) {
      // The sheet stays open with the draft.
      if (session.current === mine) setSaving(false);
      // A later opening of the sheet saved this draft meanwhile: nothing to report.
      if (kept && session.current !== mine && isConfirmed(kept.id)) return;
      if (kept && isAlreadySaved(e)) return alreadySaved(kept.id, mine);
      saveFailed(e, kept ?? snapshot(enrichOptions()));
      return;
    } finally {
      if (busy.current === mine) busy.current = 0;
      if (kept) markSaving(kept.id, false);
    }
    if (session.current === mine) onClose();
    toast(`Saved ${TYPE_INFO[item.type].emoji} ${item.title.length > 32 ? `${item.title.slice(0, 30)}…` : item.title}`, {
      label: 'View',
      onClick: () => navigate(`/item/${item.id}`),
    });
    // Fetch the preview in the background; the save is already safe.
    void enrichItem(item.id, kept.enrich).catch(() => {});
  };

  return (
    <>
      <Sheet
        open={open}
        title="Save to Magpie"
        onClose={onClose}
        footer={
          <>
            <button className="btn outline" onClick={onClose}>
              Cancel
            </button>
            {share ? (
              // A friend's Magpie link is something to open, not a link to save.
              <button className="btn primary" onClick={() => openShare(share)}>
                Open share
              </button>
            ) : (
              <button className="btn primary" disabled={!hasContent || saving} aria-label={saving ? 'Saving…' : undefined} onClick={save}>
                {saving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
              </button>
            )}
          </>
        }
      >
        <DbStatus inSheet onReload={reloadNow} />
        {/* Read-only while saving: what's saved (or kept for a retry) is what's on screen. */}
        <fieldset className="save-form" disabled={saving}>
          <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
            <textarea
              className="textarea"
              autoFocus
              data-autofocus
              rows={3}
              value={raw}
              aria-label="Link or text to save"
              placeholder="Paste a link from TikTok, Instagram, YouTube, Google Maps, a recipe site… or just type an idea"
              onChange={(e) => {
                setText(e.target.value, !pasting.current);
                pasting.current = false;
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text) setHanded((h) => [...h, text]);
                pasting.current = true;
              }}
              onDrop={(e) => {
                const text = e.dataTransfer.getData('text');
                if (text) setHanded((h) => [...h, text]);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
              }}
            />
          </div>
          {'clipboard' in navigator && 'readText' in navigator.clipboard && (
            <button className="btn small outline" style={{ marginTop: 8 }} onClick={paste}>
              <ClipboardPaste size={16} /> Paste from clipboard
            </button>
          )}

          {share && (
            <div className="save-share" role="group" aria-label="Magpie share">
              <Gift size={22} aria-hidden="true" className="save-share-icon" />
              <div className="save-share-text">
                <strong>This is a Magpie share from a friend</strong>
                <span>Open it to see what's inside and add it to your Magpie.</span>
              </div>
              <button type="button" className="btn small primary" onClick={() => openShare(share)}>
                Open
              </button>
            </div>
          )}

          {hasContent && !share && (
            <>
              {live ? (
                <div className="save-analysis" aria-busy={detecting}>
                  <DetectedInfo guess={shownGuess} type={effType} onTypeChange={setType} />
                </div>
              ) : (
                <p className="detected save-detecting" role="status">
                  <span className="spinner" aria-hidden="true" /> Detecting…
                </p>
              )}

              <label className="label" htmlFor="save-title">
                Title
              </label>
              <input id="save-title" className="input" value={effTitle} onChange={(e) => setTitle(e.target.value)} />
              {guess.url && title === null && previews && <p className="hint">We'll grab the real title and image once it's saved.</p>}

              <div className="save-facts">
                <div className="save-fact" role="group" aria-label="When">
                  {effWhen ? (
                    <>
                      <WhenBadge when={effWhen} variant="inline" />
                      <button type="button" className="btn small outline" onClick={() => setEditingWhen(true)}>
                        Change
                      </button>
                      <button type="button" className="save-clear" aria-label="Remove the date" onClick={() => setWhen({ value: undefined })}>
                        <X size={16} aria-hidden="true" />
                      </button>
                    </>
                  ) : found ? (
                    <>
                      <button type="button" className="chip dashed save-chip" onClick={() => setWhen({ value: found.when })}>
                        <span className="save-chip-text">
                          <span aria-hidden="true">🗓 </span>Add date: {formatWhen(found.when)}?
                        </span>
                      </button>
                      <button type="button" className="save-more" onClick={() => setEditingWhen(true)}>
                        Other date
                      </button>
                    </>
                  ) : (
                    <button type="button" className="chip dashed save-chip" onClick={() => setEditingWhen(true)}>
                      <CalendarPlus size={16} aria-hidden="true" /> Add a date
                    </button>
                  )}
                </div>

                {effPlace ? (
                  <div className="save-fact" role="group" aria-label="Where">
                    <span className="save-place" title={placeText(effPlace)}>
                      <span aria-hidden="true">{flagEmoji(placeCountryCode(effPlace), '📍')}</span>
                      <span className="save-place-text">{placeText(effPlace)}</span>
                    </span>
                    <button type="button" className="save-clear" aria-label="Remove the location" onClick={() => setPlace({ value: undefined })}>
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  hints.length > 0 && (
                    <div className="save-fact wrap" role="group" aria-label="Add a location">
                      {hints.map((h) => (
                        <button
                          key={h}
                          type="button"
                          className="chip dashed save-chip"
                          disabled={locating !== null}
                          aria-busy={locating === h}
                          aria-label={`Find ${h} on the map`}
                          onClick={() => void locate(h)}
                        >
                          {locating === h ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">📍</span>}
                          <span className="save-chip-text">{h}</span>
                        </button>
                      ))}
                    </div>
                  )
                )}
              </div>

              <span className="label">Tags</span>
              <TagInput tags={effTags} onChange={setTags} suggestions={tagSuggestions} />

              {manual.length > 0 && (
                <>
                  <span className="label">Add to collection</span>
                  <div className="chips wrap">
                    {manual.map((c) => {
                      const on = collectionIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className="chip"
                          aria-pressed={on}
                          onClick={() => setCollectionIds(on ? collectionIds.filter((x) => x !== c.id) : [...collectionIds, c.id])}
                        >
                          {c.emoji} {c.name}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {smartHits.length > 0 && (
                <p className="hint">
                  <Zap size={12} /> Will also show up in {smartHits.map((c) => `${c.emoji} ${c.name}`).join(', ')}
                </p>
              )}

              <label className="label" htmlFor="save-note">
                Note
              </label>
              <textarea
                id="save-note"
                className="textarea"
                rows={2}
                value={effNote}
                placeholder="Why did you save this?"
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}
        </fieldset>
      </Sheet>
      <WhenEditor open={open && editingWhen} value={effWhen} suggestion={found?.when} onSave={saveWhen} onClose={closeWhen} />
    </>
  );
}
