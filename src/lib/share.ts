import type { Collection, Item, ItemType, Place } from './types';

/**
 * Collections are shared without a server: the collection and its saves are
 * compressed into the URL fragment, so the data never leaves the two devices
 * (fragments aren't sent to the web server).
 */

export interface SharedItem {
  t: ItemType;
  n: string; // title
  u?: string; // url
  d?: string; // note
  i?: string; // image
  g?: string[]; // tags
  p?: Place;
  s?: string; // source
}

export interface SharedCollection {
  v: 1;
  name: string;
  emoji: string;
  color: string;
  items: SharedItem[];
}

export function toShared(collection: Collection, items: Item[]): SharedCollection {
  return {
    v: 1,
    name: collection.name,
    emoji: collection.emoji,
    color: collection.color,
    items: items.map((i) => {
      const s: SharedItem = { t: i.type, n: i.title };
      if (i.url) s.u = i.url;
      if (i.note) s.d = i.note;
      if (i.image) s.i = i.image;
      if (i.tags.length) s.g = i.tags;
      if (i.place) s.p = i.place;
      if (i.source) s.s = i.source;
      return s;
    }),
  };
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const buf = await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buf);
}

const canCompress = () => typeof CompressionStream !== 'undefined';

/** "z" prefix = deflate-compressed, "j" = plain JSON (fallback for old browsers). */
export async function encodeShare(data: SharedCollection): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (canCompress()) return `z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  return `j${toBase64Url(json)}`;
}

export async function decodeShare(payload: string): Promise<SharedCollection> {
  const kind = payload[0];
  let bytes = fromBase64Url(payload.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (kind !== 'j') throw new Error('Unknown share format');
  const data = JSON.parse(new TextDecoder().decode(bytes)) as SharedCollection;
  if (data?.v !== 1 || typeof data.name !== 'string' || !Array.isArray(data.items)) throw new Error('Not a Magpie collection');
  return data;
}

export function shareUrl(payload: string, base = location.href): string {
  const u = new URL(base);
  u.search = '';
  u.hash = `/import/${payload}`;
  return u.toString();
}
