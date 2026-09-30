import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { TYPE_INFO, type Item } from './types';

export { L };

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function addTiles(map: L.Map): L.TileLayer {
  return L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
}

/** Emoji map pin. Only static emoji go into the HTML — never user text. */
export function pinIcon(item: Pick<Item, 'type' | 'status'>, selected = false): L.DivIcon {
  const cls = ['pin', item.status === 'done' ? 'done' : '', selected ? 'selected' : ''].join(' ');
  return L.divIcon({
    className: '',
    html: `<div class="${cls}"><span>${TYPE_INFO[item.type].emoji}</span></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 43],
  });
}

export const meIcon = L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
