import { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';
import { plural } from '../lib/format';
import { navigate } from '../lib/router';
import { decodeShare, type SharedCollection } from '../lib/share';
import { importSharedCollection } from '../lib/transfer';
import { ITEM_TYPES, TYPE_INFO } from '../lib/types';

/** Landing page for a collection someone shared with you. */
export function ImportScreen({ payload }: { payload: string }) {
  const toast = useToast();
  const [data, setData] = useState<SharedCollection | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    decodeShare(payload)
      .then(setData)
      .catch(() => setError(true));
  }, [payload]);

  if (error) {
    return (
      <div className="empty">
        <div className="emoji">🔗</div>
        <h2>That link didn't work</h2>
        <p>It may have been cut off when it was sent. Ask for it again.</p>
        <button className="btn primary" onClick={() => navigate('/', { replace: true })}>
          Go to my library
        </button>
      </div>
    );
  }
  if (!data) return null;

  const accept = async () => {
    setBusy(true);
    try {
      const col = await importSharedCollection(data);
      toast(`Added ${col.emoji} ${col.name}`);
      navigate(`/collections/${col.id}`, { replace: true });
    } catch (e) {
      setBusy(false);
      toast(`Couldn't import: ${(e as Error).message}`);
    }
  };

  return (
    <div className="item-wrap">
      <section className="hero" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, position: 'relative' }}>{String(data.emoji ?? '📌')}</div>
        <h2>{data.name}</h2>
        <p style={{ margin: '0 auto 18px' }}>Someone shared {plural(data.items.length, 'save')} with you.</p>
        <div className="row" style={{ justifyContent: 'center', position: 'relative' }}>
          <button className="btn outline" onClick={() => navigate('/', { replace: true })}>
            No thanks
          </button>
          <button className="btn fancy" onClick={accept} disabled={busy}>
            Add to my Magpie
          </button>
        </div>
      </section>
      <ul className="list">
        {data.items.slice(0, 50).map((s, i) => {
          const t = ITEM_TYPES.includes(s.t) ? s.t : 'link';
          const tags = Array.isArray(s.g) ? s.g.filter((g) => typeof g === 'string') : [];
          return (
            <li key={i} className="list-row" style={{ cursor: 'default' }}>
              <div className="thumb-sm">{TYPE_INFO[t].emoji}</div>
              <div className="grow">
                <div className="t">{String(s.n ?? 'Untitled')}</div>
                <div className="s">
                  {TYPE_INFO[t].label}
                  {tags.length ? ` · ${tags.map((g) => `#${g}`).join(' ')}` : ''}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
