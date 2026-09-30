import { useLiveQuery } from 'dexie-react-hooks';
import { ClipboardPaste, MapPin, Sparkles, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { classify, parseShared, sourceLabel, type SharedInput } from '../lib/classify';
import { addItem, allTags, buildItem, db } from '../lib/db';
import { enrichItem } from '../lib/enrich';
import { navigate } from '../lib/router';
import { matchesRules } from '../lib/smart';
import { ITEM_TYPES, TYPE_INFO, type ItemType } from '../lib/types';
import { Sheet } from './Sheet';
import { TagInput } from './TagInput';
import { useToast } from './Toast';

interface Props {
  open: boolean;
  initial?: SharedInput;
  /** Pre-select a collection (when saving from inside one). */
  collectionId?: string;
  onClose: () => void;
}

/** Joins the pieces a share sheet hands us into one editable blob. */
function initialText(input?: SharedInput): string {
  if (!input) return '';
  const parts = [input.title, input.text].map((s) => s?.trim()).filter(Boolean) as string[];
  const url = input.url?.trim();
  if (url && !parts.some((p) => p.includes(url))) parts.push(url);
  return [...new Set(parts)].join('\n');
}

export function SaveSheet({ open, initial, collectionId, onClose }: Props) {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const [type, setType] = useState<ItemType | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [tags, setTags] = useState<string[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').toArray(), []) ?? [];
  const knownTags = useLiveQuery(() => (open ? allTags() : []), [open]) ?? [];

  useEffect(() => {
    if (!open) return;
    setRaw(initialText(initial));
    setType(null);
    setTitle(null);
    setTags(null);
    setNote(null);
    setCollectionIds(collectionId ? [collectionId] : []);
    setSaving(false);
  }, [open, initial, collectionId]);

  const guess = useMemo(() => classify({ text: raw }), [raw]);
  const effType = type ?? guess.type;
  const effTitle = title ?? guess.title;
  const effTags = tags ?? guess.tags;
  const effNote = note ?? guess.note ?? '';
  const hasContent = raw.trim().length > 0;

  const draft = useMemo(
    () => buildItem({ type: effType, title: effTitle, tags: effTags, place: guess.place }),
    [effType, effTitle, effTags, guess.place],
  );
  const manual = collections.filter((c) => c.kind === 'manual');
  const smartHits = collections.filter((c) => c.kind === 'smart' && c.rules && matchesRules(draft, c.rules));

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setRaw(text);
    } catch {
      toast('Clipboard access was blocked — long-press the box and paste instead.');
    }
  };

  const save = async () => {
    if (!hasContent || saving) return;
    setSaving(true);
    try {
      const parsedTitle = parseShared({ text: raw }).title;
      const item = await addItem({
        type: effType,
        title: effTitle.trim() || 'Untitled',
        url: guess.url,
        source: guess.source,
        note: effNote.trim() || undefined,
        tags: effTags,
        place: guess.place,
        collectionIds,
      });
      onClose();
      toast(`Saved ${TYPE_INFO[item.type].emoji} ${item.title.length > 32 ? `${item.title.slice(0, 30)}…` : item.title}`, {
        label: 'View',
        onClick: () => navigate(`/item/${item.id}`),
      });
      // Fetch the preview in the background; the save is already safe.
      void enrichItem(item.id, {
        replaceTitle: title === null && (!parsedTitle || /^(check out|watch|look at)\b/i.test(parsedTitle)),
        reclassify: type === null,
      }).catch(() => {});
    } catch (e) {
      setSaving(false);
      toast(`Couldn't save: ${(e as Error).message}`);
    }
  };

  return (
    <Sheet
      open={open}
      title="Save to Magpie"
      onClose={onClose}
      footer={
        <>
          <button className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!hasContent || saving} onClick={save}>
            {saving ? <span className="spinner" /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
        <textarea
          className="textarea"
          autoFocus
          rows={3}
          value={raw}
          placeholder="Paste a link from TikTok, Instagram, YouTube, Google Maps, a recipe site… or just type an idea"
          onChange={(e) => setRaw(e.target.value)}
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

      {hasContent && (
        <>
          <div className="detected">
            <Sparkles size={18} color="var(--accent)" />
            <span>Looks like a</span>
            <select
              className="select"
              aria-label="Type"
              value={effType}
              onChange={(e) => setType(e.target.value as ItemType)}
            >
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_INFO[t].emoji} {TYPE_INFO[t].label}
                </option>
              ))}
            </select>
            {guess.source && <span style={{ color: 'var(--muted)' }}>from {sourceLabel(guess.source)}</span>}
            {guess.place && (
              <span className="pill" title="Location found in the link">
                <MapPin size={12} /> located
              </span>
            )}
          </div>

          <label className="label" htmlFor="save-title">
            Title
          </label>
          <input id="save-title" className="input" value={effTitle} onChange={(e) => setTitle(e.target.value)} />
          {guess.url && title === null && <p className="hint">We'll grab the real title and image once it's saved.</p>}

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
  );
}
