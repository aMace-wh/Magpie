import { useEffect, useRef } from 'react';
import { addTiles, L, pinIcon } from '../lib/leaflet';
import type { Item, Place } from '../lib/types';

/** A small, lightly interactive map showing one pin. */
export function MiniMap({ place, item, onClick }: { place: Place; item: Pick<Item, 'type' | 'status'>; onClick?: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, dragging: !L.Browser.mobile });
    addTiles(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.setView([place.lat, place.lng], 15);
    if (marker.current) marker.current.setLatLng([place.lat, place.lng]).setIcon(pinIcon(item));
    else marker.current = L.marker([place.lat, place.lng], { icon: pinIcon(item), keyboard: false }).addTo(m);
  }, [place.lat, place.lng, item.type, item.status]);

  useEffect(() => {
    const m = map.current;
    if (!m || !onClick) return;
    m.on('click', onClick);
    return () => {
      m.off('click', onClick);
    };
  }, [onClick]);

  return <div ref={el} className="mini-map" />;
}
