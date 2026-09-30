import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, ListPlus, Pencil, Plus, Share2, Trash2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CollectionEditor } from '../components/CollectionEditor';
import { Filters } from '../components/Filters';
import { ItemGrid } from '../components/ItemCard';
import { ItemPicker } from '../components/ItemPicker';
import { SurpriseSheet } from '../components/SurpriseSheet';
import { useToast } from '../components/Toast';
import { db, deleteCollection } from '../lib/db';
import { filterItems, type ItemFilter } from '../lib/filter';
import { plural } from '../lib/format';
import { goBack, navigate } from '../lib/router';
import { encodeShare, shareUrl, toShared } from '../lib/share';
import { shareLink } from '../lib/shareSheet';
import { describeRules, itemsInCollection } from '../lib/smart';

export function CollectionScreen({ id, onAdd }: { id: string; onAdd: (collectionId?: string) => void }) {
  const toast = useToast();
  // null = not found, undefined = still loading.
  const collection = useLiveQuery(async () => (await db.collections.get(id)) ?? null, [id]);
  const all = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []);
  const [filter, setFilter] = useState<ItemFilter>({ query: '', type: 'all', status: 'any' });
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [surprise, setSurprise] = useState(false);

  const items = useMemo(() => (collection && all ? itemsInCollection(all, collection) : []), [all, collection]);
  const shown = useMemo(() => filterItems(items, filter), [items, filter]);

  if (collection === undefined || all === undefined) return null;
  if (collection === null) {
    return (
      <div className="empty">
        <div className="emoji">🤷</div>
        <h2>Collection not found</h2>
        <button className="btn primary" onClick={() => navigate('/collections', { replace: true })}>
          All collections
        </button>
      </div>
    );
  }

  const share = async () => {
    if (!items.length) return toast('Add some saves before sharing.');
    const url = shareUrl(await encodeShare(toShared(collection, items)));
    const res = await shareLink({ title: `${collection.emoji} ${collection.name}`, text: `My "${collection.name}" list on Magpie`, url });
    if (res === 'copied') toast('Share link copied');
    if (res === 'failed') toast("Couldn't share this collection");
  };

  const remove = async () => {
    if (!confirm(`Delete "${collection.name}"? The saves inside it are kept.`)) return;
    await deleteCollection(collection.id);
    toast('Collection deleted');
    navigate('/collections', { replace: true });
  };

  const todo = items.filter((i) => i.status === 'todo').length;

  return (
    <>
      <header className="page-header">
        <button className="icon-btn" aria-label="Back" onClick={() => goBack('/collections')}>
          <ArrowLeft size={20} />
        </button>
        <h1 className="page-title small">
          {collection.emoji} {collection.name}
        </h1>
        <button className="icon-btn" aria-label="Share collection" onClick={share}>
          <Share2 size={19} />
        </button>
        <button className="icon-btn" aria-label="Edit collection" onClick={() => setEditing(true)}>
          <Pencil size={18} />
        </button>
      </header>
      <p className="subtitle">
        {collection.kind === 'smart' && (
          <>
            <Zap size={12} fill="currentColor" /> {describeRules(collection.rules!)} ·{' '}
          </>
        )}
        {plural(items.length, 'save')}
        {items.length > 0 && ` · ${todo} to do`}
      </p>

      {collection.kind === 'manual' && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="btn small primary" onClick={() => onAdd(collection.id)}>
            <Plus size={16} /> Save new
          </button>
          <button className="btn small outline" onClick={() => setPicking(true)}>
            <ListPlus size={16} /> Add existing
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty">
          <div className="emoji">{collection.emoji}</div>
          <h2>Empty for now</h2>
          <p>
            {collection.kind === 'smart'
              ? 'Saves that match the rules above will appear here automatically.'
              : 'Add saves you already have, or save something new straight into it.'}
          </p>
        </div>
      ) : (
        <>
          <Filters items={items} filter={filter} onChange={setFilter} onSurprise={() => setSurprise(true)} />
          <ItemGrid items={shown} />
        </>
      )}

      <div className="danger-zone">
        <button className="btn danger small" onClick={remove}>
          <Trash2 size={16} /> Delete collection
        </button>
      </div>

      <CollectionEditor open={editing} collection={collection} onClose={() => setEditing(false)} />
      <ItemPicker open={picking} collection={collection} onClose={() => setPicking(false)} />
      <SurpriseSheet items={shown} open={surprise} onClose={() => setSurprise(false)} />
    </>
  );
}
