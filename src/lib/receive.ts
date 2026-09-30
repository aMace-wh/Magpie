/**
 * Receiving shares from other apps: files handed over by the OS share sheet
 * (the service worker parks them in a cache and redirects to #/receive/<key>)
 * and files opened with the installed app (File Handling API).
 *
 * Kept free of DOM-only globals and imports so the service worker can use it too.
 */

/** Cache the service worker parks shared files in until the app picks them up. */
export const INBOX_CACHE = 'magpie-inbox';

/** Inbox entries are stored under "<scope>__inbox/<key>". */
export const INBOX_PATH = '__inbox/';

const KEY_RE = /^[a-z0-9-]{1,64}$/i;

// The "#/import/<payload>" part of a share link. Payloads are base64url with a z/j format prefix.
const LINK_RE = /(?:#|%23)\/?import\/([zj][A-Za-z0-9_-]{4,})/;
// A payload pasted on its own. Real ones are never this short; shorter tokens are just words.
const BARE_RE = /^\s*([zj][A-Za-z0-9_-]{40,})\s*$/;

/**
 * Finds a Magpie share payload in a link or a whole message (also when the link was URL-encoded, e.g. by a link shim).
 * `allowBare` also accepts a payload pasted on its own — only for places where the user is explicitly importing
 * (a lone word shared from another app must still open the Save sheet).
 */
export function findSharePayload(text: string | null | undefined, allowBare = false): string | undefined {
  if (!text) return undefined;
  const direct = LINK_RE.exec(text);
  if (direct) return direct[1];
  if (/%2f|%23/i.test(text)) {
    try {
      const m = LINK_RE.exec(decodeURIComponent(text));
      if (m) return m[1];
    } catch {
      /* malformed escape sequence */
    }
  }
  return allowBare ? BARE_RE.exec(text)?.[1] : undefined;
}

/** A short random, URL-safe key for an inbox entry; starts with the time so stale ones can be purged. */
export function newInboxKey(now = Date.now()): string {
  const rand = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(rand);
  else for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 256);
  return `${now.toString(36)}-${Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** When an inbox key was made (ms), or NaN. */
export function inboxKeyTime(key: string): number {
  return parseInt(key.split('-')[0], 36);
}

export function isInboxKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** Reads a file the service worker received from the share sheet, and removes it from the inbox. */
export async function takeInboxFile(key: string): Promise<File | undefined> {
  if (!isInboxKey(key) || typeof caches === 'undefined') return undefined;
  try {
    const cache = await caches.open(INBOX_CACHE);
    const requests = await cache.keys();
    const request = requests.find((r) => new URL(r.url).pathname.endsWith(`/${INBOX_PATH}${key}`));
    if (!request) return undefined;
    const res = await cache.match(request);
    await cache.delete(request);
    if (!res) return undefined;
    const blob = await res.blob();
    let name = 'shared.magpie.json';
    try {
      name = decodeURIComponent(res.headers.get('X-File-Name') ?? '') || name;
    } catch {
      /* keep the default name */
    }
    return new File([blob], name, { type: blob.type || res.headers.get('Content-Type') || 'application/json' });
  } catch {
    return undefined;
  }
}

// File Handling API (installed app opened with a .magpie / .json file). Not in the TS DOM lib yet.
interface LaunchFileHandle {
  kind?: string;
  getFile(): Promise<File>;
}

interface LaunchParamsLike {
  files?: readonly LaunchFileHandle[];
}

interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void): void;
}

/** Calls `cb` with the files the installed app was opened with (if the browser supports file handling). */
export function onLaunchFiles(cb: (files: File[]) => void): void {
  const queue = (globalThis as { launchQueue?: LaunchQueueLike }).launchQueue;
  if (!queue || typeof queue.setConsumer !== 'function') return;
  queue.setConsumer(async (params) => {
    const handles = (params?.files ?? []).filter((h) => h && h.kind !== 'directory' && typeof h.getFile === 'function');
    if (!handles.length) return;
    const files: File[] = [];
    for (const h of handles) {
      try {
        files.push(await h.getFile());
      } catch {
        /* permission revoked or file gone */
      }
    }
    if (files.length) cb(files);
  });
}
