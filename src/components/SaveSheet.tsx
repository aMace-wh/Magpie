import { useLiveQuery } from 'dexie-react-hooks';
import { CalendarPlus, ClipboardPaste, Gift, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { classify, cleanTitle, handedText, itemFieldsFrom, parseShared, type Classification, type SharedInput } from '../lib/classify';
import { addItem, allTags, buildItem, db } from '../lib/db';
import { countryHint, enrichItem, locationHints, pickResult, placeFromResult } from '../lib/enrich';
import { searchPlaces } from '../lib/geo';
import { flagEmoji, placeCountryCode, placeLabel } from '../lib/location';
import { navigate } from '../lib/router';
import { useSettings } from '../lib/settings';
import { parseShareInput } from '../lib/share';
import { matchesRules } from '../lib/smart';
import { TYPE_INFO, type ItemType, type Place, type When } from '../lib/types';
import { findWhen, formatWhen } from '../lib/when';
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
  onClose: () => void;
}

/** Something the user chose (possibly "nothing"), as opposed to what Magpie guessed. `null` = untouched. */
type Choice<T> = { value: T | undefined } | null;

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

export function SaveSheet({ open, initial, collectionId, onClose }: Props) {
  const toast = useToast();
  const { previews } = useSettings();
  const [raw, setRaw] = useState('');
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

  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').toArray(), []) ?? [];
  const knownTags = useLiveQuery(() => (open ? allTags() : []), [open]) ?? [];

  useEffect(() => {
    if (!open) return;
    const text = initialText(initial);
    setRaw(text);
    setHanded(text ? [text] : []);
    setType(null);
    setTitle(null);
    setTags(null);
    setNote(null);
    setWhen(null);
    setPlace(null);
    setEditingWhen(false);
    setLocating(null);
    setCollectionIds(collectionId ? [collectionId] : []);
    setSaving(false);
    return () => {
      // Closing the sheet cancels a place search that's still queued.
      search.current?.abort();
      search.current = null;
    };
  }, [open, initial, collectionId]);

  const guess = useMemo(() => classify({ text: raw }), [raw]);
  const found = useMemo(() => findWhen(raw), [raw]);
  const hints = useMemo(() => locationHints(raw, 3), [raw]);
  const sharePayload = useMemo(() => parseShareInput(raw, { bare: false }), [raw]);

  const effType = type ?? guess.type;
  const effTitle = title ?? guess.title;
  const effTags = tags ?? guess.tags;
  const effNote = note ?? guess.note ?? '';
  // Clear dates are filled in straight away (so are loose ones, for events); others are offered.
  const autoWhen = found && (found.confidence === 'high' || effType === 'event') ? found.when : undefined;
  const effWhen = when ? when.value : autoWhen;
  const effPlace = place ? place.value : guess.place;
  const hasContent = raw.trim().length > 0;

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

  const draft = useMemo(
    () => buildItem({ type: effType, title: effTitle, tags: effTags, place: effPlace, when: effWhen }),
    [effType, effTitle, effTags, effPlace, effWhen],
  );
  const manual = collections.filter((c) => c.kind === 'manual');
  const smartHits = collections.filter((c) => c.kind === 'smart' && c.rules && matchesRules(draft, c.rules));

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setRaw(text);
        setHanded((h) => [...h, text]);
      }
    } catch {
      toast('Clipboard access was blocked — long-press the box and paste instead.');
    }
  };

  const openShare = () => {
    if (!sharePayload) return;
    onClose();
    navigate(`/import/${sharePayload}`);
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

  const save = async () => {
    if (sharePayload) return openShare();
    if (!hasContent || saving) return;
    setSaving(true);
    search.current?.abort();
    try {
      const parsedTitle = parseShared({ text: raw }).title;
      const item = await addItem({
        ...itemFieldsFrom(guess),
        sharedText: handedText(raw, handed),
        type: effType,
        title: effTitle.trim() || 'Untitled',
        note: effNote.trim() || undefined,
        tags: effTags,
        place: effPlace,
        ...(effWhen && { when: effWhen }),
        collectionIds,
      });
      onClose();
      toast(`Saved ${TYPE_INFO[item.type].emoji} ${item.title.length > 32 ? `${item.title.slice(0, 30)}…` : item.title}`, {
        label: 'View',
        onClick: () => navigate(`/item/${item.id}`),
      });
      // Fetch the preview in the background; the save is already safe.
      void enrichItem(item.id, {
        // Boilerplate like "Check out @chef's video!" isn't worth keeping over the page's real title.
        replaceTitle: title === null && !cleanTitle(parsedTitle),
        reclassify: type === null,
        dates: when === null,
        locate: place === null,
      }).catch(() => {});
    } catch (e) {
      setSaving(false);
      toast(`Couldn't save: ${(e as Error).message}`);
    }
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
            {sharePayload ? (
              // A friend's Magpie link is something to open, not a link to save.
              <button className="btn primary" onClick={openShare}>
                Open share
              </button>
            ) : (
              <button className="btn primary" disabled={!hasContent || saving} onClick={save}>
                {saving ? <span className="spinner" /> : 'Save'}
              </button>
            )}
          </>
        }
      >
        <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
          <textarea
            className="textarea"
            autoFocus
            data-autofocus
            rows={3}
            value={raw}
            aria-label="Link or text to save"
            placeholder="Paste a link from TikTok, Instagram, YouTube, Google Maps, a recipe site… or just type an idea"
            onChange={(e) => setRaw(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (text) setHanded((h) => [...h, text]);
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

        {sharePayload && (
          <div className="save-share" role="group" aria-label="Magpie share">
            <Gift size={22} aria-hidden="true" className="save-share-icon" />
            <div className="save-share-text">
              <strong>This is a Magpie share from a friend</strong>
              <span>Open it to see what's inside and add it to your Magpie.</span>
            </div>
            <button type="button" className="btn small primary" onClick={openShare}>
              Open
            </button>
          </div>
        )}

        {hasContent && !sharePayload && (
          <>
            <DetectedInfo guess={shownGuess} type={effType} onTypeChange={setType} />

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
            <TagInput tags={effTags} onChange={setTags} suggestions={knownTags.map((t) => t.tag)} />

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
      </Sheet>
      <WhenEditor
        open={open && editingWhen}
        value={effWhen}
        suggestion={found?.when}
        onSave={(w) => setWhen({ value: w })}
        onClose={() => setEditingWhen(false)}
      />
    </>
  );
}
