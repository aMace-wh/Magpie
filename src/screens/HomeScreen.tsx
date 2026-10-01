import { useLiveQuery } from 'dexie-react-hooks';
import { Gift, Plus, Search, Settings, Share2, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Filters } from '../components/Filters';
import { InstallBanner } from '../components/InstallBanner';
import { StorageWarning } from '../components/StorageWarning';
import { ItemGrid } from '../components/ItemCard';
import { OpenShareFile } from '../components/OpenShareFile';
import { ShareSheet } from '../components/ShareSheet';
import { SurpriseSheet } from '../components/SurpriseSheet';
import { ThumbSmall } from '../components/Thumb';
import { useToast } from '../components/Toast';
import { WhenBadge } from '../components/WhenBadge';
import { db } from '../lib/db';
import { filterItems, isFiltering, type ItemFilter } from '../lib/filter';
import { useInstall } from '../lib/install';
import { navigate } from '../lib/router';
import { addSampleData } from '../lib/samples';
import type { Item } from '../lib/types';
import { compareWhen, whenStatus } from '../lib/when';

const COMING_UP_MAX = 10;

/** Saves still to do whose date is today or later (or on right now), soonest first. */
function comingUp(items: Item[], now = new Date()): Item[] {
  return items
    .filter((i) => i.status === 'todo' && i.when && whenStatus(i.when, now) !== 'past')
    .sort((a, b) => compareWhen(a.when, b.when))
    .slice(0, COMING_UP_MAX);
}

export function HomeScreen({ onAdd }: { onAdd: () => void }) {
  const items = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []);
  const collections = useLiveQuery(() => db.collections.toArray(), []);
  const [filter, setFilter] = useState<ItemFilter>({ query: '', type: 'all', status: 'todo' });
  const [surprise, setSurprise] = useState(false);
  const [sharing, setSharing] = useState(false);
  const shown = useMemo(() => filterItems(items ?? [], filter), [items, filter]);
  const scoped = useMemo(() => filterItems(items ?? [], { ...filter, type: 'all', status: 'any' }), [items, filter]);
  const upcoming = useMemo(() => comingUp(items ?? []), [items]);
  const showUpcoming = upcoming.length > 0 && !isFiltering(filter) && filter.status !== 'done';
  const hasItems = !!items?.length;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title wordmark">
          <img src="pwa-192.png" alt="" />
          Magpie
        </h1>
        {hasItems && (
          <button className="icon-btn" aria-label="Share my library" title="Share my library" onClick={() => setSharing(true)}>
            <Share2 size={19} />
          </button>
        )}
        <button className="icon-btn" aria-label="Settings" onClick={() => navigate('/settings')}>
          <Settings size={20} />
        </button>
      </header>

      <StorageWarning />
      <InstallBanner />

      {items === undefined ? null : items.length === 0 ? (
        <Welcome onAdd={onAdd} />
      ) : (
        <>
          <div className="search">
            <Search size={18} />
            <input
              className="input"
              type="search"
              aria-label="Search your saves"
              placeholder="Search saves, places, notes and #tags"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            />
          </div>
          <Filters items={scoped} filter={filter} onChange={setFilter} onSurprise={() => setSurprise(true)} />
          {showUpcoming && <ComingUp items={upcoming} />}
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
          <ShareSheet open={sharing} onClose={() => setSharing(false)} target={{ kind: 'library', items, collections: collections ?? [] }} />
        </>
      )}
    </>
  );
}

/** Horizontal strip of dated saves that are on now or coming up. */
function ComingUp({ items }: { items: Item[] }) {
  return (
    <section className="upcoming" aria-labelledby="upcoming-title">
      <h2 className="section-title" id="upcoming-title">
        Coming up
      </h2>
      <ul className="upcoming-strip">
        {items.map((item) => (
          <li key={item.id}>
            <button type="button" className="upcoming-tile" onClick={() => navigate(`/item/${encodeURIComponent(item.id)}`)}>
              <ThumbSmall item={item} />
              <span className="upcoming-body">
                <span className="upcoming-name">{item.title || 'Untitled'}</span>
                <WhenBadge when={item.when!} variant="inline" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
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
          {/* iPhone and iPad can't share to a web app, installed or not: links come in with + and paste. */}
          <span>
            {install.ios
              ? install.standalone
                ? 'Copy a link in any app, then tap + and paste it.'
                : 'Add Magpie to your Home Screen, then paste links in with the + button.'
              : install.standalone
                ? 'Tap Share in any app and pick Magpie.'
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
      <p className="hero-friend">
        Got a Magpie link from a friend? Paste it with +. A file?{' '}
        <OpenShareFile className="link-btn">
          <Gift size={14} aria-hidden /> Open it
        </OpenShareFile>
      </p>
    </section>
  );
}
