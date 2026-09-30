import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Search, Settings, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Filters } from '../components/Filters';
import { ItemGrid } from '../components/ItemCard';
import { SurpriseSheet } from '../components/SurpriseSheet';
import { useToast } from '../components/Toast';
import { db } from '../lib/db';
import { filterItems, type ItemFilter } from '../lib/filter';
import { useInstall } from '../lib/install';
import { navigate } from '../lib/router';
import { addSampleData } from '../lib/samples';

export function HomeScreen({ onAdd }: { onAdd: () => void }) {
  const items = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []);
  const [filter, setFilter] = useState<ItemFilter>({ query: '', type: 'all', status: 'todo' });
  const [surprise, setSurprise] = useState(false);
  const shown = useMemo(() => filterItems(items ?? [], filter), [items, filter]);
  const scoped = useMemo(() => filterItems(items ?? [], { ...filter, type: 'all', status: 'any' }), [items, filter]);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title wordmark">
          <img src="pwa-192.png" alt="" />
          Magpie
        </h1>
        <button className="icon-btn" aria-label="Settings" onClick={() => navigate('/settings')}>
          <Settings size={20} />
        </button>
      </header>

      {items === undefined ? null : items.length === 0 ? (
        <Welcome onAdd={onAdd} />
      ) : (
        <>
          <div className="search">
            <Search size={18} />
            <input
              className="input"
              type="search"
              placeholder="Search your saves, notes and #tags"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            />
          </div>
          <Filters items={scoped} filter={filter} onChange={setFilter} onSurprise={() => setSurprise(true)} />
          {shown.length ? (
            <ItemGrid items={shown} />
          ) : (
            <div className="empty">
              <div className="emoji">{filter.query ? '🔍' : filter.status === 'todo' ? '🎉' : '🪺'}</div>
              <h2>{filter.query ? 'Nothing matches' : filter.status === 'todo' ? 'All done here' : 'Nothing here yet'}</h2>
              <p>{filter.query ? 'Try a different word or tag.' : 'Switch the filter above to see everything else.'}</p>
            </div>
          )}
          <SurpriseSheet items={shown} open={surprise} onClose={() => setSurprise(false)} />
        </>
      )}
    </>
  );
}

function Welcome({ onAdd }: { onAdd: () => void }) {
  const toast = useToast();
  const install = useInstall();
  return (
    <section className="hero">
      <h2>
        Save it. Sort it.
        <br />
        Actually do it.
      </h2>
      <p>
        Magpie is one home for the recipes, places, videos and ideas you find everywhere — TikTok, Instagram, YouTube, Google Maps, the web.
      </p>
      <ol className="steps">
        <li>
          <span className="n">1</span>
          <span>
            {install.standalone
              ? 'Tap Share in any app and pick Magpie.'
              : install.ios
                ? 'Add Magpie to your Home Screen, then paste links in with the + button.'
                : 'Install Magpie, then tap Share in any app and pick Magpie.'}
          </span>
        </li>
        <li>
          <span className="n">2</span>
          <span>It works out what you saved — recipe, place, workout… — and tags it for you.</span>
        </li>
        <li>
          <span className="n">3</span>
          <span>Plan with collections and the map, then mark things done to build your journal.</span>
        </li>
      </ol>
      <div className="row" style={{ position: 'relative' }}>
        <button className="btn fancy" onClick={onAdd}>
          <Plus size={18} /> Save your first thing
        </button>
        <button
          className="btn outline"
          onClick={async () => {
            await addSampleData();
            toast('Added some examples to play with');
          }}
        >
          <Sparkles size={18} /> Load examples
        </button>
      </div>
    </section>
  );
}
