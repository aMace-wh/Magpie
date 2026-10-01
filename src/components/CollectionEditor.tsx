import { useEffect, useMemo, useState } from 'react';
import { addCollection, allTags, db, updateCollection } from '../lib/db';
import { plural } from '../lib/format';
import { useLiveQuery } from '../lib/live';
import { navigate } from '../lib/router';
import { EMPTY_RULES, hasRules, matchesRules } from '../lib/smart';
import { COLLECTION_COLORS, ITEM_TYPES, TYPE_INFO, type Collection, type SmartRules, type StatusFilter } from '../lib/types';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

const EMOJIS = ['📌', '✈️', '🍝', '☕️', '🍸', '🏃', '🧘', '🎬', '📚', '🛍️', '🎁', '🏡', '🌿', '🎨', '🎧', '💡', '🗺️', '🍰'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Edit this collection; omit to create a new one. */
  collection?: Collection;
  startSmart?: boolean;
}

export function CollectionEditor({ open, onClose, collection, startSmart }: Props) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [color, setColor] = useState(COLLECTION_COLORS[0]);
  const [kind, setKind] = useState<Collection['kind']>('manual');
  const [rules, setRules] = useState<SmartRules>(EMPTY_RULES);

  const items = useLiveQuery(() => (open ? db.items.toArray() : []), [open]) ?? [];
  const tags = useLiveQuery(() => (open ? allTags() : []), [open]) ?? [];

  useEffect(() => {
    if (!open) return;
    setName(collection?.name ?? '');
    setEmoji(collection?.emoji ?? EMOJIS[Math.floor(Math.random() * EMOJIS.length)]);
    setColor(collection?.color ?? COLLECTION_COLORS[Math.floor(Math.random() * COLLECTION_COLORS.length)]);
    setKind(collection?.kind ?? (startSmart ? 'smart' : 'manual'));
    setRules(collection?.rules ?? EMPTY_RULES);
  }, [open, collection, startSmart]);

  const matches = useMemo(() => (kind === 'smart' ? items.filter((i) => matchesRules(i, rules)) : []), [items, rules, kind]);
  const canSave = name.trim().length > 0 && (kind === 'manual' || hasRules(rules));

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = async () => {
    if (!canSave) return;
    const data = { name: name.trim(), emoji, color, kind, rules: kind === 'smart' ? rules : undefined };
    if (collection) {
      await updateCollection(collection.id, data);
      onClose();
    } else {
      const created = await addCollection(data);
      onClose();
      toast(`Created ${emoji} ${created.name}`);
      navigate(`/collections/${created.id}`);
    }
  };

  return (
    <Sheet
      open={open}
      title={collection ? 'Edit collection' : 'New collection'}
      onClose={onClose}
      footer={
        <>
          <button className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canSave} onClick={save}>
            {collection ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <label className="label" htmlFor="col-name" style={{ marginTop: 0 }}>
        Name
      </label>
      <input
        id="col-name"
        className="input"
        value={name}
        autoFocus={!collection}
        data-autofocus={!collection || undefined}
        placeholder="e.g. Tokyo trip, Date night, Sunday baking"
        onChange={(e) => setName(e.target.value)}
      />

      <span className="label">Icon</span>
      <div className="emoji-picks">
        {EMOJIS.map((e) => (
          <button key={e} type="button" aria-pressed={emoji === e} onClick={() => setEmoji(e)}>
            {e}
          </button>
        ))}
        <input
          className="input"
          style={{ width: 64, textAlign: 'center', fontSize: 20, padding: 6 }}
          aria-label="Custom emoji"
          value={EMOJIS.includes(emoji) ? '' : emoji}
          placeholder="✏️"
          onChange={(e) => e.target.value.trim() && setEmoji([...e.target.value.trim()].slice(0, 2).join(''))}
        />
      </div>

      <span className="label">Colour</span>
      <div className="swatches">
        {COLLECTION_COLORS.map((c) => (
          <button key={c} type="button" className="swatch" aria-label={c} aria-pressed={color === c} style={{ background: c }} onClick={() => setColor(c)} />
        ))}
      </div>

      <span className="label">Type</span>
      <div className="segmented">
        <button type="button" aria-pressed={kind === 'manual'} onClick={() => setKind('manual')}>
          📌 Hand-picked
        </button>
        <button type="button" aria-pressed={kind === 'smart'} onClick={() => setKind('smart')}>
          ⚡ Smart
        </button>
      </div>
      <p className="hint">
        {kind === 'manual'
          ? 'You choose what goes in.'
          : 'Fills itself: pick the tags and kinds of saves it should watch, and matching saves are filed automatically — now and in future.'}
      </p>

      {kind === 'smart' && (
        <>
          <span className="label">Kinds of saves</span>
          <div className="chips wrap">
            {ITEM_TYPES.map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={rules.types.includes(t)} onClick={() => setRules({ ...rules, types: toggle(rules.types, t) })}>
                {TYPE_INFO[t].emoji} {TYPE_INFO[t].plural}
              </button>
            ))}
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <span className="label" style={{ margin: 0 }}>
              Tags
            </span>
            <span className="spacer" />
            {rules.tags.length > 1 && (
              <div className="segmented">
                <button type="button" aria-pressed={rules.match === 'any'} onClick={() => setRules({ ...rules, match: 'any' })}>
                  Any
                </button>
                <button type="button" aria-pressed={rules.match === 'all'} onClick={() => setRules({ ...rules, match: 'all' })}>
                  All
                </button>
              </div>
            )}
          </div>
          <div className="chips wrap" style={{ marginTop: 8 }}>
            {tags.length === 0 && <p className="hint">No tags yet — tags you add to saves show up here.</p>}
            {tags.slice(0, 40).map(({ tag, count }) => (
              <button key={tag} type="button" className="chip tag" aria-pressed={rules.tags.includes(tag)} onClick={() => setRules({ ...rules, tags: toggle(rules.tags, tag) })}>
                #{tag} <span className="count">{count}</span>
              </button>
            ))}
          </div>

          <span className="label">Status</span>
          <div className="segmented">
            {(['any', 'todo', 'done'] as StatusFilter[]).map((s) => (
              <button key={s} type="button" aria-pressed={rules.status === s} onClick={() => setRules({ ...rules, status: s })}>
                {s === 'any' ? 'Everything' : s === 'todo' ? 'Not done yet' : 'Done'}
              </button>
            ))}
          </div>

          <div className="preview-box">
            <strong>{hasRules(rules) ? `Matches ${plural(matches.length, 'save')}` : 'Pick at least one rule'}</strong>
            {matches.slice(0, 5).map((m) => (
              <div key={m.id} className="hint" style={{ margin: '2px 0' }}>
                {TYPE_INFO[m.type].emoji} {m.title}
              </div>
            ))}
            {matches.length > 5 && <div className="hint">…and {matches.length - 5} more</div>}
          </div>
        </>
      )}
    </Sheet>
  );
}
