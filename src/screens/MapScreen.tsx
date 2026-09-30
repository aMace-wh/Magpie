import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, LocateFixed, Navigation } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ThumbSmall } from '../components/Thumb';
import { useToast } from '../components/Toast';
import { db } from '../lib/db';
import { currentPosition, directionsLink } from '../lib/geo';
import { addTiles, L, meIcon, pinIcon } from '../lib/leaflet';
import { navigate } from '../lib/router';
import { itemsInCollection } from '../lib/smart';
import { TYPE_INFO, type Item, type StatusFilter } from '../lib/types';

export function MapScreen() {
  const toast = useToast();
  const all = useLiveQuery(() => db.items.filter((i) => !!i.place).toArray(), []);
  const collections = useLiveQuery(() => db.collections.orderBy('name').toArray(), []) ?? [];
  const [status, setStatus] = useState<StatusFilter>('any');
  const [collectionId, setCollectionId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // Redraw pins whenever the visible set or selection changes.
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g || !all) return;
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
    if (fittedFor.current !== key && places.length) {
      fittedFor.current = key;
      const bounds = L.latLngBounds(places.map((p) => [p.place!.lat, p.place!.lng] as [number, number]));
      m.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
    }
  }, [places, selectedId, status, collectionId, all]);

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

  return (
    <div className="map-screen">
      <div ref={el} />
      <div className="map-top">
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
        <button className="icon-btn" aria-label="Show my location" onClick={locate}>
          <LocateFixed size={19} />
        </button>
      </div>

      {all && all.length === 0 && (
        <div className="map-empty">
          <div className="empty" style={{ padding: 24 }}>
            <div className="emoji">🗺️</div>
            <h2>Your map is empty</h2>
            <p>Save a Google Maps link, or open any save and add a location — it'll get a pin here.</p>
          </div>
        </div>
      )}

      {selected && <MapCard item={selected} />}
    </div>
  );
}

function MapCard({ item }: { item: Item }) {
  const info = TYPE_INFO[item.type];
  return (
    <div className="map-card">
      <ThumbSmall item={item} />
      <button className="grow" style={{ flex: 1, minWidth: 0, border: 0, background: 'none', textAlign: 'left', padding: 0 }} onClick={() => navigate(`/item/${item.id}`)}>
        <span className={`pill ${item.status === 'done' ? 'done' : ''}`}>{item.status === 'done' ? info.done : info.todo}</span>
        <div style={{ fontWeight: 750, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
        {item.place?.address && (
          <div className="hint" style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.place.address}
          </div>
        )}
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
