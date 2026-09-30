import { LocateFixed, MapPin, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { parseLatLng, parsePlaceFromUrl } from '../lib/classify';
import { updateItem } from '../lib/db';
import { currentPosition, searchPlaces, type GeoResult } from '../lib/geo';
import type { Item, Place } from '../lib/types';
import { MiniMap } from './LazyMiniMap';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/** Set or change an item's location: search, current position, or paste coordinates / a maps link. */
export function PlacePicker({ item, open, onClose }: { item: Item; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Place | undefined>(item.place);

  useEffect(() => {
    if (!open) return;
    setPicked(item.place);
    setResults([]);
    setQuery(item.place ? '' : item.type === 'place' ? item.title : '');
  }, [open, item.place, item.title, item.type]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    // Pasted coordinates or a map link? No need to search.
    const direct = parseLatLng(q) ?? parsePlaceFromUrl(q).place;
    if (direct) {
      setPicked(direct);
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
      setPicked(await currentPosition());
      setResults([]);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    await updateItem(item.id, { place: picked });
    onClose();
    toast(picked ? 'Location saved — it’s on your map now' : 'Location removed');
  };

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
                setPicked(undefined);
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
          placeholder="Search a place, address, or paste coordinates"
          onChange={(e) => setQuery(e.target.value)}
        />
      </form>
      <div className="row">
        <button className="btn small outline" onClick={search} disabled={busy || !query.trim()}>
          {busy ? <span className="spinner" /> : <Search size={16} />} Search
        </button>
        <button className="btn small outline" onClick={locate} disabled={busy}>
          <LocateFixed size={16} /> I'm here now
        </button>
      </div>

      {results.length > 0 && (
        <ul className="list" style={{ marginTop: 8 }}>
          {results.map((r) => (
            <li key={`${r.lat},${r.lng}`}>
              <button
                className="list-row"
                onClick={() => {
                  setPicked({ lat: r.lat, lng: r.lng, address: r.address });
                  setResults([]);
                }}
              >
                <MapPin size={18} color="var(--accent)" />
                <div className="grow">
                  <div className="t">{r.name}</div>
                  <div className="s">{r.address}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {picked && (
        <div style={{ marginTop: 16 }}>
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
