import { FileInput, FolderPlus, Users, Zap } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { CollectionEditor } from '../components/CollectionEditor';
import { DbStatus, Loading } from '../components/DbStatus';
import { OpenShareFile } from '../components/OpenShareFile';
import { ThumbImage } from '../components/Thumb';
import { db } from '../lib/db';
import { plural } from '../lib/format';
import { useLiveQuery } from '../lib/live';
import { navigate } from '../lib/router';
import { itemsInCollection } from '../lib/smart';
import { useThumb } from '../lib/thumbs';
import { TYPE_INFO, type Collection, type Item } from '../lib/types';

export function CollectionsScreen() {
  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').reverse().toArray(), []);
  const allItems = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []);
  const items = allItems ?? [];
  const [editor, setEditor] = useState<{ smart: boolean } | null>(null);
  // Collections added from a friend's share get their own section.
  const [mine, friends] = useMemo(() => {
    const list = collections ?? [];
    return [list.filter((c) => !c.from), list.filter((c) => c.from)];
  }, [collections]);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Collections</h1>
        <OpenShareFile className="icon-btn" label="Open a share file from a friend">
          <FileInput size={19} aria-hidden />
        </OpenShareFile>
        <button className="btn small primary" onClick={() => setEditor({ smart: false })}>
          <FolderPlus size={16} /> New
        </button>
      </header>

      <DbStatus />
      {/* Wait for the saves too, so the tiles don't show "0 saves" first. */}
      {(collections === undefined || (collections.length > 0 && allItems === undefined)) && <Loading label="Loading your collections…" />}

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

      {mine.length > 0 && allItems && (
        <div className="col-grid">
          {mine.map((c) => (
            <CollectionTile key={c.id} collection={c} items={itemsInCollection(items, c)} />
          ))}
        </div>
      )}

      {friends.length > 0 && allItems && (
        <section aria-labelledby="from-friends">
          <h2 className="section-title" id="from-friends">
            From friends
          </h2>
          <div className="col-grid">
            {friends.map((c) => (
              <CollectionTile key={c.id} collection={c} items={itemsInCollection(items, c)} />
            ))}
          </div>
        </section>
      )}

      <CollectionEditor open={!!editor} startSmart={editor?.smart} onClose={() => setEditor(null)} />
    </>
  );
}

function CollectionTile({ collection, items }: { collection: Collection; items: Item[] }) {
  const covers = items.slice(0, 4);
  const todo = items.filter((i) => i.status === 'todo').length;
  const tint: CSSProperties = { ['--tint' as string]: collection.color };
  const friend = collection.from ? collection.from.name?.trim() || 'a friend' : undefined;
  return (
    <button className="col-tile" onClick={() => navigate(`/collections/${collection.id}`)}>
      {covers.length === 0 ? (
        <div className="mosaic empty" style={tint}>
          {collection.emoji}
          {collection.kind === 'smart' && <SmartBadge />}
        </div>
      ) : (
        <div className="mosaic" style={tint}>
          {[0, 1, 2, 3].map((n) => (
            <MosaicCell key={n} item={covers[n]} fallback={n === 0 ? collection.emoji : ''} tint={tint} />
          ))}
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
      {friend && (
        <div className="col-from">
          <Users size={12} aria-hidden />
          <span>from {friend}</span>
        </div>
      )}
    </button>
  );
}

/** A cover picture, or the save's emoji when it has none (or it doesn't load). */
function MosaicCell({ item, fallback, tint }: { item?: Item; fallback: string; tint: CSSProperties }) {
  if (item) return <MosaicCover item={item} tint={tint} />;
  return (
    <div className="cell" style={tint}>
      {fallback}
    </div>
  );
}

function MosaicCover({ item, tint }: { item: Item; tint: CSSProperties }) {
  const { src, waiting } = useThumb(item);
  if (src) return <ThumbImage id={item.id} src={src} />;
  // Keeps its place in the grid while the copy on this device is looked up.
  if (waiting) return <div />;
  return (
    <div className="cell" style={tint}>
      {TYPE_INFO[item.type].emoji}
    </div>
  );
}

function SmartBadge() {
  return (
    <span className="pill solid smart-badge">
      <Zap size={11} fill="currentColor" /> Smart
    </span>
  );
}
