import { Check, MapPin } from 'lucide-react';
import { hostOf, sourceLabel } from '../lib/classify';
import { timeAgo } from '../lib/format';
import { navigate } from '../lib/router';
import { TYPE_INFO, type Item } from '../lib/types';
import { Stars } from './Stars';
import { Thumb } from './Thumb';

export function ItemCard({ item }: { item: Item }) {
  const info = TYPE_INFO[item.type];
  const from = sourceLabel(item.source) ?? item.siteName ?? hostOf(item.url);
  return (
    <button className="card" onClick={() => navigate(`/item/${item.id}`)}>
      <div className="thumb">
        <Thumb item={item} />
        {item.status === 'done' && (
          <span className="card-badge done">
            <Check size={12} strokeWidth={3} /> {info.done}
          </span>
        )}
      </div>
      <div className="card-body">
        <h3 className="card-title">{item.title}</h3>
        <div className="card-meta">
          <span aria-hidden>{info.emoji}</span>
          {item.place && item.type !== 'place' && <MapPin size={12} />}
          <span>{from || info.label}</span>
          <span aria-hidden>·</span>
          <span style={{ flexShrink: 0 }}>{timeAgo(item.createdAt)}</span>
        </div>
        {item.status === 'done' && item.rating ? <Stars value={item.rating} size={12} /> : null}
      </div>
    </button>
  );
}

export function ItemGrid({ items }: { items: Item[] }) {
  return (
    <div className="grid">
      {items.map((item) => (
        <ItemCard key={item.id} item={item} />
      ))}
    </div>
  );
}
