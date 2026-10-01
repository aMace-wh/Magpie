import { ArrowLeft, CalendarPlus, ListPlus, Pencil, Plus, Share2, Trash2, Users, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CollectionEditor } from '../components/CollectionEditor';
import { CountryGroups } from '../components/CountryGroups';
import { DbStatus, Loading, useShowLoading } from '../components/DbStatus';
import { Filters } from '../components/Filters';
import { ItemGrid } from '../components/ItemCard';
import { ItemPicker } from '../components/ItemPicker';
import { ShareSheet } from '../components/ShareSheet';
import { SurpriseSheet } from '../components/SurpriseSheet';
import { useToast } from '../components/Toast';
import { calendarEventFromItem, downloadIcs, toIcs, type CalendarEvent } from '../lib/calendar';
import { db, deleteCollection } from '../lib/db';
import { filterItems, type ItemFilter } from '../lib/filter';
import { plural } from '../lib/format';
import { useLiveQuery } from '../lib/live';
import { goBack, navigate } from '../lib/router';
import { describeRules, itemsInCollection } from '../lib/smart';

type View = 'grid' | 'country';

// Remembered per collection for the session, so coming back from a save keeps the same view.
const views = new Map<string, View>();

export function CollectionScreen({ id, onAdd }: { id: string; onAdd: (collectionId?: string) => void }) {
  const toast = useToast();
  // null = not found, undefined = still loading.
  const collection = useLiveQuery(async () => (await db.collections.get(id)) ?? null, [id]);
  const all = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []);
  const [filter, setFilter] = useState<ItemFilter>({ query: '', type: 'all', status: 'any' });
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [surprise, setSurprise] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [view, setViewState] = useState<View>(() => views.get(id) ?? 'grid');
  const showLoading = useShowLoading();

  const items = useMemo(() => (collection && all ? itemsInCollection(all, collection) : []), [all, collection]);
  const shown = useMemo(() => filterItems(items, filter), [items, filter]);
  const events = useMemo(() => items.map(calendarEventFromItem).filter((e): e is CalendarEvent => !!e), [items]);
  const hasPlaces = items.some((i) => i.place);
  const byCountry = view === 'country' && hasPlaces;

  const setView = (v: View) => {
    views.set(id, v);
    setViewState(v);
  };

  if (collection === undefined || all === undefined) {
    // Usually a blink: nothing until it takes a moment, rather than a half header that jumps.
    if (!showLoading) return null;
    return (
      <>
        <header className="page-header">
          <button className="icon-btn" aria-label="Back" onClick={() => goBack('/collections')}>
            <ArrowLeft size={20} />
          </button>
        </header>
        <DbStatus />
        <Loading label="Loading this collection…" cards={2} />
      </>
    );
  }
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

  const share = () => {
    if (!items.length) return toast('Add some saves before sharing.');
    setSharing(true);
  };

  const addToCalendar = () => {
    const ok = downloadIcs(collection.name, toIcs(events, { name: `${collection.emoji} ${collection.name}` }));
    toast(ok ? `Calendar file saved — ${plural(events.length, 'event')}` : "Couldn't make the calendar file");
  };

  const remove = async () => {
    if (!confirm(`Delete "${collection.name}"? The saves inside it are kept.`)) return;
    await deleteCollection(collection.id);
    toast('Collection deleted');
    navigate('/collections', { replace: true });
  };

  const todo = items.filter((i) => i.status === 'todo').length;
  const sharedBy = collection.from ? collection.from.name?.trim() || 'a friend' : undefined;

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
      <DbStatus />
      <p className="subtitle">
        {sharedBy && (
          <>
            <Users size={12} aria-hidden /> Shared by {sharedBy} ·{' '}
          </>
        )}
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
          {(hasPlaces || events.length > 0) && (
            <div className="row col-view">
              {hasPlaces && (
                <div className="segmented" role="group" aria-label="View">
                  <button aria-pressed={!byCountry} onClick={() => setView('grid')}>
                    Grid
                  </button>
                  <button aria-pressed={byCountry} onClick={() => setView('country')}>
                    By country
                  </button>
                </div>
              )}
              <span className="spacer" />
              {events.length > 0 && (
                <button className="btn small outline" onClick={addToCalendar} title={`Download ${plural(events.length, 'dated save')} as an .ics file`}>
                  <CalendarPlus size={16} /> Add to calendar
                </button>
              )}
            </div>
          )}
          <Filters items={items} filter={filter} onChange={setFilter} onSurprise={() => setSurprise(true)} />
          {byCountry ? (
            <CountryGroups
              items={shown}
              emptyText={shown.length ? 'Nothing here has a location yet.' : 'Nothing matches these filters.'}
            />
          ) : (
            <ItemGrid items={shown} />
          )}
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
      <ShareSheet open={sharing} onClose={() => setSharing(false)} target={{ kind: 'collection', collection, items }} />
    </>
  );
}
