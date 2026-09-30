import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Check, ExternalLink, MapPin, Navigation, Pencil, RefreshCw, Share2, Trash2, Undo2, Zap } from 'lucide-react';
import { useState } from 'react';
import { EditableText } from '../components/EditableText';
import { MiniMap } from '../components/LazyMiniMap';
import { PlacePicker } from '../components/PlacePicker';
import { ReviewSheet } from '../components/ReviewSheet';
import { Stars } from '../components/Stars';
import { TagInput } from '../components/TagInput';
import { Thumb } from '../components/Thumb';
import { useToast } from '../components/Toast';
import { hostOf, sourceLabel } from '../lib/classify';
import { allTags, db, deleteItem, markTodo, toggleItemInCollection, updateItem } from '../lib/db';
import { enrichItem } from '../lib/enrich';
import { dayLabel, timeAgo } from '../lib/format';
import { directionsLink } from '../lib/geo';
import { goBack, navigate } from '../lib/router';
import { useSettings } from '../lib/settings';
import { shareLink } from '../lib/shareSheet';
import { matchesRules } from '../lib/smart';
import { ITEM_TYPES, TYPE_INFO, type ItemType } from '../lib/types';

export function ItemScreen({ id }: { id: string }) {
  const toast = useToast();
  const settings = useSettings();
  // null = not found, undefined = still loading.
  const item = useLiveQuery(async () => (await db.items.get(id)) ?? null, [id]);
  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').toArray(), []) ?? [];
  const tags = useLiveQuery(() => allTags(), []) ?? [];
  const [reviewing, setReviewing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  if (item === undefined) return null;
  if (item === null) {
    return (
      <div className="empty">
        <div className="emoji">🪶</div>
        <h2>This save is gone</h2>
        <p>It may have been deleted.</p>
        <button className="btn primary" onClick={() => navigate('/', { replace: true })}>
          Back to library
        </button>
      </div>
    );
  }

  const info = TYPE_INFO[item.type];
  const from = sourceLabel(item.source) ?? item.siteName ?? hostOf(item.url);
  const manual = collections.filter((c) => c.kind === 'manual');
  const smart = collections.filter((c) => c.kind === 'smart' && c.rules && matchesRules(item, c.rules));

  const remove = async () => {
    const copy = { ...item };
    await deleteItem(item.id);
    goBack('/');
    toast('Deleted', { label: 'Undo', onClick: () => void db.items.put(copy) });
  };

  const share = async () => {
    const res = await shareLink({ title: item.title, text: item.note, url: item.url ?? '' });
    if (res === 'copied') toast('Link copied');
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await enrichItem(item.id, { replaceTitle: false, reclassify: false, overwrite: true });
      toast('Preview updated');
    } catch {
      toast("Couldn't fetch a preview");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="item-wrap">
      <div className="item-hero">
        <Thumb item={item} label={false} />
        <div className="item-hero-bar">
          <button className="icon-btn on-image" aria-label="Back" onClick={() => goBack('/')}>
            <ArrowLeft size={20} />
          </button>
          <span className="spacer" />
          {item.url?.startsWith('http') && (
            <button className="icon-btn on-image" aria-label="Share" onClick={share}>
              <Share2 size={18} />
            </button>
          )}
          <button className="icon-btn on-image" aria-label="Delete" onClick={remove}>
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <EditableText className="item-title" label="Title" value={item.title} onSave={(title) => updateItem(item.id, { title: title.trim() || 'Untitled' })} />

      <div className="item-meta">
        <select className="select" aria-label="Kind" value={item.type} onChange={(e) => updateItem(item.id, { type: e.target.value as ItemType })}>
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_INFO[t].emoji} {TYPE_INFO[t].label}
            </option>
          ))}
        </select>
        {from && <span>{from}</span>}
        <span>· saved {timeAgo(item.createdAt)}</span>
      </div>

      {item.url && (
        <a className="btn block primary" href={item.url} target="_blank" rel="noreferrer" style={{ marginBottom: 12 }}>
          <ExternalLink size={18} /> Open {from ? `in ${from}` : 'link'}
        </a>
      )}

      {item.status === 'todo' ? (
        <button className="btn block done" onClick={() => setReviewing(true)}>
          <Check size={18} strokeWidth={3} /> {info.doneAction}
        </button>
      ) : (
        <div className="panel done-panel">
          <div className="head">
            <Check size={18} strokeWidth={3} /> {info.done} · {dayLabel(item.doneAt ?? item.updatedAt)}
            <span className="spacer" />
            <button className="btn small outline" onClick={() => setReviewing(true)}>
              <Pencil size={14} /> Edit
            </button>
            <button className="icon-btn ghost" aria-label="Mark as not done" title="Mark as not done" onClick={() => markTodo(item.id)}>
              <Undo2 size={18} />
            </button>
          </div>
          {item.rating ? (
            <div style={{ marginTop: 8 }}>
              <Stars value={item.rating} size={18} />
            </div>
          ) : null}
          {item.review && <blockquote>{item.review}</blockquote>}
        </div>
      )}

      <h2 className="section-title">Tags</h2>
      <TagInput tags={item.tags} onChange={(t) => updateItem(item.id, { tags: t })} suggestions={tags.map((t) => t.tag)} />

      <h2 className="section-title">Collections</h2>
      <div className="chips wrap">
        {manual.map((c) => {
          const on = item.collectionIds.includes(c.id);
          return (
            <button key={c.id} className="chip" aria-pressed={on} onClick={() => toggleItemInCollection(item.id, c.id)}>
              {c.emoji} {c.name}
            </button>
          );
        })}
        {smart.map((c) => (
          <button key={c.id} className="chip" onClick={() => navigate(`/collections/${c.id}`)} title="Added automatically by a smart collection">
            <Zap size={13} /> {c.emoji} {c.name}
          </button>
        ))}
        {manual.length === 0 && smart.length === 0 && (
          <button className="chip dashed" onClick={() => navigate('/collections')}>
            Create a collection
          </button>
        )}
      </div>

      <h2 className="section-title">Location</h2>
      {item.place ? (
        <>
          <MiniMap place={item.place} item={item} onClick={() => setPlacing(true)} />
          {item.place.address && <p className="hint">{item.place.address}</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn small outline" href={directionsLink(item.place)} target="_blank" rel="noreferrer">
              <Navigation size={16} /> Directions
            </a>
            <button className="btn small outline" onClick={() => navigate('/map')}>
              <MapPin size={16} /> On my map
            </button>
            <button className="btn small outline" onClick={() => setPlacing(true)}>
              <Pencil size={16} /> Change
            </button>
          </div>
        </>
      ) : (
        <button className="btn outline small" onClick={() => setPlacing(true)}>
          <MapPin size={16} /> Add a location
        </button>
      )}

      <h2 className="section-title">Notes</h2>
      <EditableText
        className="textarea note-area"
        label="Notes"
        multiline
        value={item.note ?? ''}
        placeholder="Ingredients to buy, who recommended it, when it's open…"
        onSave={(note) => updateItem(item.id, { note: note.trim() || undefined })}
      />

      {item.description && (
        <>
          <h2 className="section-title">From the page</h2>
          <p className="description">{item.description}</p>
        </>
      )}

      <div className="danger-zone">
        {item.url?.startsWith('http') && settings.previews && (
          <button className="btn small outline" onClick={refresh} disabled={refreshing}>
            {refreshing ? <span className="spinner" /> : <RefreshCw size={16} />} Refresh preview
          </button>
        )}
        <button className="btn small danger" onClick={remove}>
          <Trash2 size={16} /> Delete
        </button>
      </div>

      <ReviewSheet item={item} open={reviewing} onClose={() => setReviewing(false)} />
      <PlacePicker item={item} open={placing} onClose={() => setPlacing(false)} />
    </div>
  );
}
