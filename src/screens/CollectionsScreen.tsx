import { useLiveQuery } from 'dexie-react-hooks';
import { FolderPlus, Zap } from 'lucide-react';
import { useState } from 'react';
import { CollectionEditor } from '../components/CollectionEditor';
import { db } from '../lib/db';
import { plural } from '../lib/format';
import { navigate } from '../lib/router';
import { itemsInCollection } from '../lib/smart';
import { TYPE_INFO, type Collection, type Item } from '../lib/types';

export function CollectionsScreen() {
  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').reverse().toArray(), []);
  const items = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []) ?? [];
  const [editor, setEditor] = useState<{ smart: boolean } | null>(null);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Collections</h1>
        <button className="btn small primary" onClick={() => setEditor({ smart: false })}>
          <FolderPlus size={16} /> New
        </button>
      </header>

      {collections?.length === 0 && (
        <div className="empty">
          <div className="emoji">🗂️</div>
          <h2>Group your saves</h2>
          <p>Make a collection for a trip, a dinner party or a hobby. Smart collections fill themselves based on tags.</p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button className="btn primary" onClick={() => setEditor({ smart: false })}>
              📌 Hand-picked collection
            </button>
            <button className="btn outline" onClick={() => setEditor({ smart: true })}>
              ⚡ Smart collection
            </button>
          </div>
        </div>
      )}

      <div className="col-grid">
        {collections?.map((c) => (
          <CollectionTile key={c.id} collection={c} items={itemsInCollection(items, c)} />
        ))}
      </div>

      <CollectionEditor open={!!editor} startSmart={editor?.smart} onClose={() => setEditor(null)} />
    </>
  );
}

function CollectionTile({ collection, items }: { collection: Collection; items: Item[] }) {
  const covers = items.slice(0, 4);
  const todo = items.filter((i) => i.status === 'todo').length;
  const tint = { ['--tint' as string]: collection.color };
  return (
    <button className="col-tile" onClick={() => navigate(`/collections/${collection.id}`)}>
      {covers.length === 0 ? (
        <div className="mosaic empty" style={tint}>
          {collection.emoji}
          {collection.kind === 'smart' && <SmartBadge />}
        </div>
      ) : (
        <div className="mosaic" style={tint}>
          {[0, 1, 2, 3].map((n) => {
            const item = covers[n];
            if (item?.image) return <img key={n} src={item.image} alt="" loading="lazy" referrerPolicy="no-referrer" />;
            return (
              <div key={n} className="cell" style={tint}>
                {item ? TYPE_INFO[item.type].emoji : n === 0 ? collection.emoji : ''}
              </div>
            );
          })}
          {collection.kind === 'smart' && <SmartBadge />}
        </div>
      )}
      <div className="col-name">
        <span aria-hidden>{collection.emoji}</span> {collection.name}
      </div>
      <div className="col-count">
        {plural(items.length, 'save')}
        {todo > 0 && todo !== items.length ? ` · ${todo} to do` : ''}
      </div>
    </button>
  );
}

function SmartBadge() {
  return (
    <span className="pill solid smart-badge">
      <Zap size={11} fill="currentColor" /> Smart
    </span>
  );
}
