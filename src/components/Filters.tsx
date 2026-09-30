import { Dices } from 'lucide-react';
import { typeCounts, type ItemFilter } from '../lib/filter';
import { TYPE_INFO, type Item, type StatusFilter } from '../lib/types';

interface Props {
  items: Item[];
  filter: ItemFilter;
  onChange: (f: ItemFilter) => void;
  onSurprise?: () => void;
}

/** Type chips + to do / done toggle, shared by the library and collection pages. */
export function Filters({ items, filter, onChange, onSurprise }: Props) {
  const counts = typeCounts(items);
  return (
    <>
      {counts.length > 1 && (
        <div className="chips" role="toolbar" aria-label="Filter by kind">
          <button className="chip" aria-pressed={filter.type === 'all'} onClick={() => onChange({ ...filter, type: 'all' })}>
            All <span className="count">{items.length}</span>
          </button>
          {counts.map(([t, n]) => (
            <button key={t} className="chip" aria-pressed={filter.type === t} onClick={() => onChange({ ...filter, type: filter.type === t ? 'all' : t })}>
              {TYPE_INFO[t].emoji} {TYPE_INFO[t].plural} <span className="count">{n}</span>
            </button>
          ))}
        </div>
      )}
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Filter by status">
          {(['todo', 'done', 'any'] as StatusFilter[]).map((s) => (
            <button key={s} aria-pressed={filter.status === s} onClick={() => onChange({ ...filter, status: s })}>
              {s === 'todo' ? 'To do' : s === 'done' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {onSurprise && (
          <button className="btn small outline" onClick={onSurprise} title="Pick something for me">
            <Dices size={16} /> Pick for me
          </button>
        )}
      </div>
    </>
  );
}
