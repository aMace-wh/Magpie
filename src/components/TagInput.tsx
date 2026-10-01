import { Plus, X } from 'lucide-react';
import { memo, useState } from 'react';
import { normalizeTag } from '../lib/classify';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Existing tags offered as one-tap suggestions. */
  suggestions?: string[];
}

export const TagInput = memo(function TagInput({ tags, onChange, suggestions = [] }: Props) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);

  const add = (raw: string) => {
    const parts = raw.split(/[,\n]/).map(normalizeTag).filter(Boolean);
    const next = [...tags];
    for (const t of parts) if (!next.includes(t)) next.push(t);
    onChange(next);
    setDraft('');
  };

  const q = normalizeTag(draft);
  const offered = suggestions.filter((s) => !tags.includes(s) && (!q || s.includes(q))).slice(0, 8);

  return (
    <div>
      <div className="chips wrap">
        {tags.map((t) => (
          <button key={t} type="button" className="chip tag" aria-pressed="true" onClick={() => onChange(tags.filter((x) => x !== t))}>
            #{t} <X size={13} aria-label={`Remove ${t}`} />
          </button>
        ))}
        {!adding && (
          <button type="button" className="chip tag dashed" onClick={() => setAdding(true)}>
            <Plus size={13} /> Tag
          </button>
        )}
      </div>
      {adding && (
        <div style={{ marginTop: 10 }}>
          <input
            className="input"
            autoFocus
            value={draft}
            placeholder="Add a tag and press Enter"
            enterKeyHint="done"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                if (draft.trim()) add(draft);
                else setAdding(false);
              } else if (e.key === 'Escape') {
                setAdding(false);
              }
            }}
            onBlur={() => {
              if (draft.trim()) add(draft);
              setAdding(false);
            }}
          />
        </div>
      )}
      {offered.length > 0 && (adding || tags.length === 0) && (
        <div className="chips wrap" style={{ marginTop: 10 }}>
          {offered.map((s) => (
            <button
              key={s}
              type="button"
              className="chip tag"
              // Keep the input from blurring before the tap registers.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(s)}
            >
              #{s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
