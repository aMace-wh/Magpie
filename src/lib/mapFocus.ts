import { navigate } from './router';

/**
 * "On my map" from a save: the Map screen opens on the map (not the Countries list), with that save's pin
 * selected. Kept here rather than in MapScreen so asking doesn't load Leaflet.
 */

let pending: string | undefined;

export function showOnMap(itemId: string): void {
  pending = itemId;
  navigate('/map');
}

/** The save to focus, once: the next Map screen takes it. */
export function takeMapFocus(): string | undefined {
  const id = pending;
  pending = undefined;
  return id;
}
