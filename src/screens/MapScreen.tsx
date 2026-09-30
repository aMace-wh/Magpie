import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, Globe, LocateFixed, Map as MapIcon, Navigation } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CountryGroups } from '../components/CountryGroups';
import { ThumbSmall } from '../components/Thumb';
import { useToast } from '../components/Toast';
import { WhenBadge } from '../components/WhenBadge';
import { db } from '../lib/db';
import { currentPosition, directionsLink } from '../lib/geo';
import { addTiles, L, meIcon, pinIcon } from '../lib/leaflet';
import { flagEmoji, placeLabel } from '../lib/location';
import { takeMapFocus } from '../lib/mapFocus';
import { navigate } from '../lib/router';
import { itemsInCollection } from '../lib/smart';
import { TYPE_INFO, type Item, type StatusFilter } from '../lib/types';

type View = 'map' | 'countries';

// Remembered for the session, so coming back from a save opens the same view and filters.
const last: { view: View; status: StatusFilter; collectionId: string } = { view: 'map', status: 'any', collectionId: '' };

export function MapScreen() {
  const toast = useToast();
  const all = useLiveQuery(() => db.items.filter((i) => !!i.place).toArray(), []);
  const collections = useLiveQuery(() => db.collections.orderBy('name').toArray(), []) ?? [];
  // "On my map" from a save: open on the map with its pin selected.
  const [focusId] = useState(takeMapFocus);
  const [view, setView] = useState<View>(focusId ? 'map' : last.view);
  const [status, setStatus] = useState<StatusFilter>(last.status);
  const [collectionId, setCollectionId] = useState(last.collectionId);
  const [selectedId, setSelectedId] = useState<string | null>(focusId ?? null);
  const focus = useRef(focusId);

  useEffect(() => {
    Object.assign(last, { view, status, collectionId });
  }, [view, status, collectionId]);

  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const me = useRef<L.Marker | null>(null);
  const fittedFor = useRef<string | null>(null);

  const places = useMemo(() => {
    let list = all ?? [];
    const col = collections.find((c) => c.id === collectionId);
    if (col) list = itemsInCollection(list, col);
    return status === 'any' ? list : list.filter((i) => i.status === status);
  }, [all, collections, collectionId, status]);
  const selected = places.find((p) => p.id === selectedId);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, worldCopyJump: true }).setView([30, 0], 2);
    addTiles(m);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', () => setSelectedId(null));
    let zooming = false;
    m.on('zoomanim', () => (zooming = true)).on('zoomend', () => (zooming = false));
    map.current = m;
    return () => {
      map.current = null;
      // Leaflet ends a zoom animation from a 250 ms timer, which throws if the map is gone by then: let it finish.
      if (zooming) setTimeout(() => m.remove(), 300);
      else m.remove();
    };
  }, []);

  // The map is only hidden in the Countries view (not unmounted); it needs its size re-read when shown again.
  useEffect(() => {
    if (view === 'map') map.current?.invalidateSize();
  }, [view]);

  // Redraw pins whenever the visible set or selection changes (not while hidden: a hidden map can't be framed).
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g || !all || view !== 'map') return;
    const want = focus.current;
    const target = want ? all.find((i) => i.id === want) : undefined;
    if (target && !places.some((p) => p.id === want)) {
      // A filter hides the save you came to see: show everything.
      setStatus('any');
      setCollectionId('');
      return;
    }
    g.clearLayers();
    for (const item of places) {
      L.marker([item.place!.lat, item.place!.lng], {
        icon: pinIcon(item, item.id === selectedId),
        title: item.title,
        zIndexOffset: item.id === selectedId ? 1000 : 0,
      })
        .on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          setSelectedId(item.id);
        })
        .addTo(g);
    }
    // Re-frame only when the filter changes, not on every edit.
    const key = `${status}|${collectionId}|${all.length > 0}`;
    if (want) {
      focus.current = undefined;
      if (target?.place) {
        fittedFor.current = key;
        m.setView([target.place.lat, target.place.lng], Math.max(m.getZoom(), 15), { animate: false });
        return;
      }
    }
    if (fittedFor.current !== key && places.length) {
      // The first framing is instant; later ones (a filter changed) glide.
      const animate = fittedFor.current !== null;
      fittedFor.current = key;
      const bounds = L.latLngBounds(places.map((p) => [p.place!.lat, p.place!.lng] as [number, number]));
      m.fitBounds(bounds, { padding: [60, 60], maxZoom: 15, animate });
    }
  }, [places, selectedId, status, collectionId, all, view]);

  const locate = async () => {
    try {
      const pos = await currentPosition();
      const m = map.current;
      if (!m) return;
      if (me.current) me.current.setLatLng([pos.lat, pos.lng]);
      else me.current = L.marker([pos.lat, pos.lng], { icon: meIcon, interactive: false }).addTo(m);
      m.flyTo([pos.lat, pos.lng], 14);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const counts = { todo: (all ?? []).filter((i) => i.status === 'todo').length, done: (all ?? []).filter((i) => i.status === 'done').length };
  const onMap = view === 'map';

  return (
    <div className={onMap ? 'map-screen' : 'map-screen is-list'}>
      <div ref={el} hidden={!onMap} />
      <div className="map-top">
        <div className="map-row">
          <div className="segmented map-view" role="group" aria-label="View">
            <button aria-pressed={onMap} onClick={() => setView('map')}>
              <MapIcon size={15} aria-hidden /> Map
            </button>
            <button aria-pressed={!onMap} onClick={() => setView('countries')}>
              <Globe size={15} aria-hidden /> Countries
            </button>
          </div>
          <span className="spacer" />
          {onMap && (
            <button className="icon-btn" aria-label="Show my location" onClick={locate}>
              <LocateFixed size={19} />
            </button>
          )}
        </div>
        <div className="map-row">
          <div className="segmented" role="group" aria-label="Show">
            <button aria-pressed={status === 'any'} onClick={() => setStatus('any')}>
              All
            </button>
            <button aria-pressed={status === 'todo'} onClick={() => setStatus('todo')}>
              Want to go {counts.todo > 0 && <span style={{ opacity: 0.6 }}>{counts.todo}</span>}
            </button>
            <button aria-pressed={status === 'done'} onClick={() => setStatus('done')}>
              Visited {counts.done > 0 && <span style={{ opacity: 0.6 }}>{counts.done}</span>}
            </button>
          </div>
          {collections.length > 0 && (
            <select className="select" aria-label="Collection" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
              <option value="">All collections</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.emoji} {c.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {onMap && all && all.length === 0 && (
        <div className="map-empty">
          <div className="empty" style={{ padding: 24 }}>
            <div className="emoji">🗺️</div>
            <h2>Your map is empty</h2>
            <p>Save a Google Maps link, or open any save and add a location — it'll get a pin here.</p>
          </div>
        </div>
      )}

      {onMap && selected && <MapCard item={selected} />}

      {!onMap && all && (
        <div className="map-list">
          <div className="map-list-inner">
            <CountryGroups
              items={places}
              emptyText={
                all.length === 0
                  ? 'Nothing with a location yet. Add one to any save and it shows up here, sorted by country.'
                  : 'Nothing matches these filters.'
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Keeps Leaflet's zoom buttons and attribution above the card while it's open. */
function useCardSpace() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    const screen = card?.closest<HTMLElement>('.map-screen');
    if (!card || !screen) return;
    const update = () => screen.style.setProperty('--map-card-space', `${card.offsetHeight + 12}px`);
    update();
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    ro?.observe(card);
    return () => {
      ro?.disconnect();
      screen.style.removeProperty('--map-card-space');
    };
  }, []);
  return ref;
}

function MapCard({ item }: { item: Item }) {
  const info = TYPE_INFO[item.type];
  const where = item.place?.address || placeLabel(item.place);
  const ref = useCardSpace();
  return (
    <div className="map-card" ref={ref}>
      <ThumbSmall item={item} />
      <button className="grow" style={{ flex: 1, minWidth: 0, border: 0, background: 'none', textAlign: 'left', padding: 0 }} onClick={() => navigate(`/item/${item.id}`)}>
        <span className={`pill ${item.status === 'done' ? 'done' : ''}`}>{item.status === 'done' ? info.done : info.todo}</span>
        <div style={{ fontWeight: 750, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
        {where && (
          <div className="hint" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span aria-hidden>{flagEmoji(item.place?.countryCode, '')}</span> {where}
          </div>
        )}
        {item.when && <WhenBadge when={item.when} variant="inline" />}
      </button>
      <a className="icon-btn" href={directionsLink(item.place!)} target="_blank" rel="noreferrer" aria-label="Directions">
        <Navigation size={18} />
      </a>
      <button className="icon-btn" aria-label="Open" onClick={() => navigate(`/item/${item.id}`)}>
        <ChevronRight size={20} />
      </button>
    </div>
  );
}
