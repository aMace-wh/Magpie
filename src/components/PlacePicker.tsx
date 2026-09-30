import { LocateFixed, MapPin, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseLatLng, parsePlaceFromUrl } from '../lib/classify';
import { db, updateItem } from '../lib/db';
import { currentPosition, searchPlaces, type GeoResult } from '../lib/geo';
import { extractLocationHints, flagEmoji, mergePlaceDetails, needsDetails, placeLabel, resolvePlaceDetails } from '../lib/location';
import type { Item, Place } from '../lib/types';
import { MiniMap } from './LazyMiniMap';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/** Just the Place fields of a search result. */
function toPlace(r: GeoResult): Place {
  const place: Place = { lat: r.lat, lng: r.lng };
  if (r.name) place.name = r.name;
  if (r.address) place.address = r.address;
  if (r.city) place.city = r.city;
  if (r.country) place.country = r.country;
  if (r.countryCode) place.countryCode = r.countryCode;
  return place;
}

const coordsText = (p: Place) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

/** Fills in city / country after saving, if the lookup didn't finish before the sheet closed. */
async function backfillDetails(id: string, place: Place): Promise<void> {
  const full = await resolvePlaceDetails(place);
  if (full === place) return;
  const current = (await db.items.get(id))?.place;
  // Only if the location hasn't been changed again in the meantime.
  if (current && current.lat === place.lat && current.lng === place.lng) await updateItem(id, { place: full });
}

/** Set or change an item's location: search, current position, or paste coordinates / a maps link. */
export function PlacePicker({ item, open, onClose }: { item: Item; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Place | undefined>(item.place);
  const [resolving, setResolving] = useState(false);
  // Bumped on every new pick, so a slow lookup never overwrites a newer choice.
  const pickSeq = useRef(0);
  const wasOpen = useRef(false);

  const hints = useMemo(
    () => extractLocationHints([item.title, item.note, item.sharedText].filter(Boolean).join('\n')),
    [item.title, item.note, item.sharedText],
  );

  const fillDetails = async (place: Place, seq: number) => {
    if (!needsDetails(place)) return;
    setResolving(true);
    try {
      const full = await resolvePlaceDetails(place);
      if (seq === pickSeq.current && full !== place) setPicked((p) => (p ? mergePlaceDetails(full, p) : full));
    } finally {
      if (seq === pickSeq.current) setResolving(false);
    }
  };

  /** Picks a place and, when it's missing its city or country, looks them up. */
  const choose = (place: Place | undefined) => {
    const seq = ++pickSeq.current;
    setPicked(place);
    setResolving(false);
    if (place) void fillDetails(place, seq);
  };

  // Start fresh each time the sheet opens — not when the item changes underneath an open sheet.
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    choose(item.place);
    setResults([]);
    setQuery(item.place ? '' : item.type === 'place' ? item.title : '');
  }, [open]);

  // A background lookup (or enrichment) filled in the saved place while the sheet is open:
  // take its details if it's still the spot being shown, and leave the search alone.
  useEffect(() => {
    const saved = item.place;
    if (!open || !saved) return;
    setPicked((p) => (p ? mergePlaceDetails(p, saved) : p));
  }, [item.place]);

  const search = async (text = query) => {
    const q = text.trim();
    if (!q) return;
    // Pasted coordinates or a map link? No need to search.
    const direct = parseLatLng(q) ?? parsePlaceFromUrl(q).place;
    if (direct) {
      const name = parseLatLng(q) ? undefined : parsePlaceFromUrl(q).name;
      choose(name ? { ...direct, name } : direct);
      setResults([]);
      return;
    }
    setBusy(true);
    try {
      const found = await searchPlaces(q, item.place);
      setResults(found);
      if (!found.length) toast('No places found — try adding the city.');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const locate = async () => {
    setBusy(true);
    try {
      // "I'm here now": the coordinates first, then what's here (venue, city, country).
      choose(await currentPosition());
      setResults([]);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await updateItem(item.id, { place: picked });
    if (picked && needsDetails(picked)) void backfillDetails(item.id, picked).catch(() => undefined);
    onClose();
    toast(picked ? 'Location saved — it’s on your map now' : 'Location removed');
  };

  const q = query.trim().toLowerCase();
  const suggestions = results.length ? [] : hints.filter((h) => h.toLowerCase() !== q);
  const label = picked ? placeLabel(picked) : '';
  const heading = picked?.name || label || 'Pinned location';
  // "Japan" needs no "Japan" under it.
  const subline = picked?.name && label.toLowerCase() !== picked.name.toLowerCase() ? label : '';

  return (
    <Sheet
      open={open}
      title="Location"
      onClose={onClose}
      footer={
        <>
          {item.place && (
            <button
              className="btn danger"
              onClick={() => {
                choose(undefined);
                void updateItem(item.id, { place: undefined }).then(onClose);
              }}
            >
              Remove
            </button>
          )}
          <button className="btn primary" disabled={!picked} onClick={save}>
            Save location
          </button>
        </>
      }
    >
      <form
        className="search"
        style={{ marginBottom: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <Search size={18} />
        <input
          className="input"
          type="search"
          enterKeyHint="search"
          value={query}
          autoFocus
          aria-label="Search places"
          placeholder="Search a place, address, or paste coordinates"
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      <div className="row">
        <button className="btn small outline" onClick={() => void search()} disabled={busy || !query.trim()}>
          {busy ? <span className="spinner" /> : <Search size={16} />} Search
        </button>
        <button className="btn small outline" onClick={locate} disabled={busy}>
          <LocateFixed size={16} /> I'm here now
        </button>
      </div>

      {suggestions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p className="hint" style={{ margin: '0 0 6px' }}>
            Mentioned in this save
          </p>
          <div className="chips wrap" role="group" aria-label="Places mentioned in this save">
            {suggestions.map((h) => (
              <button
                key={h}
                type="button"
                className="chip tag"
                style={{ maxWidth: '100%' }}
                disabled={busy}
                aria-label={`Search for ${h}`}
                onClick={() => {
                  setQuery(h);
                  void search(h);
                }}
              >
                <span aria-hidden="true">🔎</span>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{h}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {results.length > 0 && (
        <ul className="list" style={{ marginTop: 8 }}>
          {results.map((r, i) => (
            <li key={`${i}:${r.lat},${r.lng}`}>
              <button
                className="list-row"
                onClick={() => {
                  choose(toPlace(r));
                  setResults([]);
                }}
              >
                {r.countryCode ? (
                  <span aria-hidden="true" style={{ fontSize: 20, width: 20, textAlign: 'center', flex: '0 0 auto' }}>
                    {flagEmoji(r.countryCode)}
                  </span>
                ) : (
                  <MapPin size={20} color="var(--accent)" style={{ flex: '0 0 auto' }} />
                )}
                <div className="grow">
                  <div className="t">{r.name}</div>
                  <div className="s">{r.address ?? placeLabel(r)}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {picked && (
        <div style={{ marginTop: 16 }}>
          <div className="row nowrap" style={{ gap: 12, marginBottom: 10, alignItems: 'center' }} aria-live="polite">
            <span aria-hidden="true" style={{ fontSize: 30, lineHeight: 1, flex: '0 0 auto' }}>
              {flagEmoji(picked.countryCode, '📍')}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{heading}</div>
              <div className="hint" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                {resolving ? 'Looking up the address…' : subline || (label ? '' : coordsText(picked))}
              </div>
            </div>
            {resolving && <span className="spinner" style={{ flex: '0 0 auto', color: 'var(--muted)' }} aria-hidden="true" />}
          </div>
          <MiniMap place={picked} item={item} />
          {picked.address && <p className="hint">{picked.address}</p>}
        </div>
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        Search by <a href="https://nominatim.openstreetmap.org/" target="_blank" rel="noreferrer">OpenStreetMap Nominatim</a>.
      </p>
    </Sheet>
  );
}
