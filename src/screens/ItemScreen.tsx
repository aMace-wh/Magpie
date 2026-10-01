import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  CalendarDays,
  CalendarPlus,
  Check,
  Download,
  ExternalLink,
  MapPin,
  Navigation,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
  Undo2,
  Users,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { EditableText } from '../components/EditableText';
import { MiniMap } from '../components/LazyMiniMap';
import { OriginalPreview } from '../components/OriginalPreview';
import { PlacePicker } from '../components/PlacePicker';
import { ReviewSheet } from '../components/ReviewSheet';
import { ShareSheet } from '../components/ShareSheet';
import { SourceIcon } from '../components/SourceIcon';
import { Stars } from '../components/Stars';
import { TagInput } from '../components/TagInput';
import { Thumb } from '../components/Thumb';
import { useToast } from '../components/Toast';
import { WhenBadge } from '../components/WhenBadge';
import { WhenEditor } from '../components/WhenEditor';
import { calendarEventFromItem, downloadIcs, googleCalendarUrl, icsFileName, toIcs } from '../lib/calendar';
import { hostOf, normalizeUrl, sourceLabel } from '../lib/classify';
import { allTags, db, deleteItem, markTodo, toggleItemInCollection, updateItem } from '../lib/db';
import { authorOf, embedFor, originalTextOf } from '../lib/embed';
import { enrichItem, REFRESH_OPTIONS } from '../lib/enrich';
import { dayLabel, timeAgo } from '../lib/format';
import { directionsLink } from '../lib/geo';
import { flagEmoji, placeCountryCode, placeLabel } from '../lib/location';
import { showOnMap } from '../lib/mapFocus';
import { goBack, navigate } from '../lib/router';
import { useSettings } from '../lib/settings';
import { matchesRules } from '../lib/smart';
import { ITEM_TYPES, TYPE_INFO, type Item, type ItemType } from '../lib/types';
import { findWhen, formatWhen, relativeWhen } from '../lib/when';

export function ItemScreen({ id }: { id: string }) {
  const toast = useToast();
  const settings = useSettings();
  // null = not found, undefined = still loading.
  const item = useLiveQuery(async () => (await db.items.get(id)) ?? null, [id]);
  const collections = useLiveQuery(() => db.collections.orderBy('createdAt').toArray(), []) ?? [];
  const tags = useLiveQuery(() => allTags(), []) ?? [];
  const [reviewing, setReviewing] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [dating, setDating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // A date mentioned in the post, offered in the date editor.
  const suggestion = useMemo(() => {
    const text = [item?.title, item?.note, item?.sharedText, item?.description].filter(Boolean).join('\n');
    return text ? findWhen(text)?.when : undefined;
  }, [item?.title, item?.note, item?.sharedText, item?.description]);

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
  // Only web and map links are ever opened.
  const href = normalizeUrl(item.url);
  const openLabel = from ? `in ${from}` : href?.startsWith('geo:') ? 'in Maps' : 'link';
  const manual = collections.filter((c) => c.kind === 'manual');
  const smart = collections.filter((c) => c.kind === 'smart' && c.rules && matchesRules(item, c.rules));
  const calEvent = calendarEventFromItem(item);
  const relative = calEvent ? relativeWhen(calEvent.when) : '';
  const friend = item.from ? item.from.name?.trim() || 'a friend' : undefined;
  const place = item.place;
  const placeText = place ? placeLabel(place) : '';
  const placeName = place?.name?.trim() || placeText || 'Pinned spot';
  const description = item.description?.trim();
  // OriginalPreview already shows the description when there's no shared text.
  const showDescription = !!description && !authorOf(item) && originalTextOf(item) !== description;

  const remove = async () => {
    const copy = { ...item };
    await deleteItem(item.id);
    goBack('/');
    toast('Deleted', { label: 'Undo', onClick: () => void db.items.put(copy) });
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const fetched = await enrichItem(item.id, REFRESH_OPTIONS);
      if (fetched) toast('Preview updated');
      else toast(navigator.onLine === false ? "You're offline — try again when you're back online." : "Couldn't fetch a preview right now.");
    } catch {
      toast("Couldn't fetch a preview");
    } finally {
      setRefreshing(false);
    }
  };

  const addToCalendar = () => {
    if (calEvent && !downloadIcs(icsFileName(item.title), toIcs([calEvent]))) toast("Couldn't create the calendar file");
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
          <button className="icon-btn on-image" aria-label="Share" onClick={() => setSharing(true)}>
            <Share2 size={18} />
          </button>
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
        {/* Dots separate these; one that would start a wrapped line is clipped (see .dots). */}
        <span className="item-meta-facts dots">
          {from && (
            <span className="item-meta-source dot">
              <SourceIcon source={item.source} size={18} />
              <span>{from}</span>
            </span>
          )}
          <span className="dot">saved {timeAgo(item.createdAt)}</span>
          {relative && (
            <span className="item-meta-when dot">
              <CalendarDays size={14} aria-hidden /> {relative}
            </span>
          )}
        </span>
        {friend && (
          <span className="pill item-from" title={item.from && Number.isFinite(item.from.at) ? `Added ${dayLabel(item.from.at)}` : undefined}>
            <Users size={13} aria-hidden />
            <span>Shared by {friend}</span>
          </span>
        )}
      </div>

      {href && (
        <a className="btn block primary" href={href} target="_blank" rel="noreferrer" style={{ marginBottom: 12 }}>
          <ExternalLink size={18} /> Open {openLabel}
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

      <OriginalPreview item={item} />
      <WalledNote item={item} />

      <h2 className="section-title">When</h2>
      {calEvent ? (
        <>
          <WhenBadge when={calEvent.when} variant="inline" />
          {calEvent.when.source && <p className="hint when-source">From “{calEvent.when.source}”</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small outline" onClick={() => setDating(true)}>
              <Pencil size={16} /> Change
            </button>
            <a className="btn small outline" href={googleCalendarUrl(calEvent)} target="_blank" rel="noreferrer">
              <CalendarPlus size={16} /> Google Calendar
            </a>
            <button className="btn small outline" onClick={addToCalendar}>
              <Download size={16} /> Add to calendar (.ics)
            </button>
          </div>
        </>
      ) : (
        <>
          <button className="btn outline small" onClick={() => setDating(true)}>
            <CalendarDays size={16} /> Add a date
          </button>
          {suggestion && <p className="hint">Spotted in the post: {formatWhen(suggestion)}</p>}
        </>
      )}

      <h2 className="section-title">Location</h2>
      {place ? (
        <>
          <div className="place-head">
            <span className="place-flag" aria-hidden>
              {flagEmoji(placeCountryCode(place), '📍')}
            </span>
            <strong>{placeName}</strong>
            {placeText && placeText !== placeName && <span className="place-sub">{placeText}</span>}
          </div>
          <MiniMap place={place} item={item} onClick={() => setPlacing(true)} />
          {place.address && place.address !== placeName && <p className="hint">{place.address}</p>}
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn small outline" href={directionsLink(place)} target="_blank" rel="noreferrer">
              <Navigation size={16} /> Directions
            </a>
            <button className="btn small outline" onClick={() => showOnMap(item.id)}>
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

      <h2 className="section-title">Notes</h2>
      <EditableText
        className="textarea note-area"
        label="Notes"
        multiline
        value={item.note ?? ''}
        placeholder="Ingredients to buy, who recommended it, when it's open…"
        onSave={(note) => updateItem(item.id, { note: note.trim() || undefined })}
      />

      {showDescription && (
        <>
          <h2 className="section-title">From the page</h2>
          <p className="description">{description}</p>
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
      <WhenEditor
        open={dating}
        value={item.when}
        suggestion={suggestion}
        onSave={(when) => void updateItem(item.id, { when })}
        onClose={() => setDating(false)}
      />
      <ShareSheet open={sharing} onClose={() => setSharing(false)} target={{ kind: 'item', item }} />
    </div>
  );
}

// Platforms that show preview services a login page instead of the post.
const WALLED: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', threads: 'Threads' };

/** Says why a save from Instagram & co. came in bare, and what to do about it. */
function WalledNote({ item }: { item: Item }) {
  const platform = item.source ? WALLED[item.source] : undefined;
  if (!platform) return null;
  // Anything beyond the link itself: a caption, a picture or a description from the page.
  const caption = (item.sharedText ?? '').replace(/https?:\/\/\S+/g, '').trim();
  if (item.image || item.description || caption || item.note) return null;
  const canEmbed = !!embedFor(item.url);
  return (
    <p className="hint walled-note">
      {platform} doesn't let other apps read its posts, so Magpie couldn't get the picture, caption or location.{' '}
      {canEmbed ? 'Tap “Load original post” above to see it.' : `Open it in ${platform} to see it.`} To have Magpie pick up the date and
      place, copy the caption in {platform} and paste it into Notes below. You can also add them yourself.
    </p>
  );
}
