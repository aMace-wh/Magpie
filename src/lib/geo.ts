import type { Place } from './types';

export interface GeoResult extends Place {
  name: string;
}

/**
 * Place search via OpenStreetMap Nominatim. Their usage policy allows light,
 * user-initiated searches (no autocomplete), so this only runs on submit.
 */
export async function searchPlaces(query: string, near?: Place): Promise<GeoResult[]> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6', addressdetails: '0' });
  if (near) {
    const d = 0.5;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { accept: 'application/json', 'accept-language': navigator.language || 'en' },
  });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const rows = (await res.json()) as { lat: string; lon: string; name?: string; display_name: string }[];
  return rows
    .map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lon),
      name: r.name || r.display_name.split(',')[0],
      address: r.display_name,
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

export function currentPosition(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Location is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? 'Location permission was denied.' : 'Could not get your location.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

/** Opens the coordinates in Google Maps (or the Maps app on phones). */
export function mapsLink(place: Place): string {
  return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
}

export function directionsLink(place: Place): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
}
