import { Dices } from 'lucide-react';
import { useEffect, useState } from 'react';
import { hostOf, sourceLabel } from '../lib/classify';
import { navigate } from '../lib/router';
import { TYPE_INFO, type Item } from '../lib/types';
import { Sheet } from './Sheet';
import { Thumb } from './Thumb';

function pick(items: Item[], not?: string): Item | undefined {
  const pool = items.length > 1 ? items.filter((i) => i.id !== not) : items;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Can't decide? Picks something you saved but haven't done yet. */
export function SurpriseSheet({ items, open, onClose }: { items: Item[]; open: boolean; onClose: () => void }) {
  const todo = items.filter((i) => i.status === 'todo');
  const [current, setCurrent] = useState<Item | undefined>();

  // Pick once per opening, not every time the library changes.
  useEffect(() => {
    if (open) setCurrent(pick(todo));
  }, [open]);

  const info = current && TYPE_INFO[current.type];

  return (
    <Sheet
      open={open}
      title="How about this?"
      onClose={onClose}
      footer={
        current && (
          <>
            <button className="btn outline" onClick={() => setCurrent(pick(todo, current.id))} disabled={todo.length < 2}>
              <Dices size={18} /> Another
            </button>
            <button
              className="btn primary"
              onClick={() => {
                onClose();
                navigate(`/item/${current.id}`);
              }}
            >
              Let's do it
            </button>
          </>
        )
      }
    >
      {!current || !info ? (
        <div className="empty">
          <div className="emoji">🎉</div>
          <h2>Nothing left to do here</h2>
          <p>Everything in this view is done. Save something new!</p>
        </div>
      ) : (
        <div className="card" style={{ boxShadow: 'none', cursor: 'default', transform: 'none' }}>
          <div className="thumb" style={{ aspectRatio: '16 / 9' }}>
            <Thumb item={current} />
          </div>
          <div className="card-body">
            <span className="pill">
              {info.emoji} {info.todo}
            </span>
            <h3 className="card-title" style={{ fontSize: 19 }}>
              {current.title}
            </h3>
            <div className="card-meta">
              <span>{sourceLabel(current.source) ?? current.siteName ?? (hostOf(current.url) || info.label)}</span>
            </div>
            {current.note && <p className="description" style={{ margin: 0 }}>{current.note}</p>}
          </div>
        </div>
      )}
    </Sheet>
  );
}
