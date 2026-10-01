import { Check, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { db, toggleItemInCollection } from '../lib/db';
import { filterItems } from '../lib/filter';
import { useLiveQuery } from '../lib/live';
import { TYPE_INFO, type Collection } from '../lib/types';
import { Sheet } from './Sheet';
import { SourceIcon } from './SourceIcon';
import { ThumbSmall } from './Thumb';
import { WhenBadge } from './WhenBadge';

/** Tick saves in or out of a hand-picked collection. */
export function ItemPicker({ collection, open, onClose }: { collection: Collection; open: boolean; onClose: () => void }) {
  const items = useLiveQuery(() => (open ? db.items.orderBy('createdAt').reverse().toArray() : []), [open]) ?? [];
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterItems(items, { query, type: 'all', status: 'any' }), [items, query]);

  return (
    <Sheet
      open={open}
      title={`Add to ${collection.name}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="search">
        <Search size={18} />
        <input className="input" type="search" placeholder="Search saves" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {shown.length === 0 && <p className="hint">No saves found.</p>}
      <ul className="list">
        {shown.map((item) => {
          const on = item.collectionIds.includes(collection.id);
          return (
            <li key={item.id}>
              <button className="list-row" aria-pressed={on} onClick={() => toggleItemInCollection(item.id, collection.id)}>
                <ThumbSmall item={item} />
                <div className="grow">
                  <div className="t">{item.title}</div>
                  <div className="s">
                    {item.source && <SourceIcon source={item.source} size={14} />}
                    {TYPE_INFO[item.type].emoji} {TYPE_INFO[item.type].label}
                    {item.tags.length > 0 && ` · ${item.tags.map((t) => `#${t}`).join(' ')}`}
                  </div>
                  {item.when && <WhenBadge when={item.when} variant="inline" />}
                </div>
                <span className={`check ${on ? 'on' : ''}`}>
                  <Check size={16} strokeWidth={3} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
