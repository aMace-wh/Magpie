/**
 * Magpie's service worker (built by vite-plugin-pwa's injectManifest):
 * offline app shell, cached map tiles and thumbnails, and the Web Share Target
 * that receives links, text and share files from other apps.
 *
 * Type-checked with the app (tsconfig.json, so `npm run typecheck` / `npm run build` cover it) and again
 * with WebWorker globals only (tsconfig.sw.json). It uses nothing from either lib that the other lacks,
 * and types the few service-worker-only bits of `self` itself — so no WebWorker types leak into the app.
 */
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { findSharePayload, INBOX_CACHE, INBOX_PATH, inboxKeyTime, newInboxKey } from './lib/receive';

/** The parts of ServiceWorkerGlobalScope used here. */
interface ServiceWorkerScope {
  readonly registration: { readonly scope: string };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  /** Replaced with the precache list at build time. */
  __WB_MANIFEST: (string | PrecacheEntry)[];
}

declare const self: ServiceWorkerScope;

// "Update" in the app (vite-plugin-pwa prompt flow) asks the waiting worker to take over.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ---------------------------------------------------------------------------
// Share target: other apps POST title / text / url / file to ./share-target

const INBOX_MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const scopeUrl = (path = './') => new URL(path, self.registration.scope).href;
const isShareTarget = (url: URL) => url.pathname.endsWith('/share-target');
const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** Drops files that were shared but never opened. */
async function purgeInbox(cache: Cache) {
  const now = Date.now();
  for (const req of await cache.keys()) {
    const key = new URL(req.url).pathname.split('/').pop() ?? '';
    const t = inboxKeyTime(key);
    if (!Number.isFinite(t) || now - t > INBOX_MAX_AGE) await cache.delete(req);
  }
}

async function receiveShare(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.redirect(scopeUrl(), 303);
  }

  const file = form.getAll('file').find((f): f is File => typeof f !== 'string' && f.size > 0);
  if (file && file.size <= MAX_FILE_BYTES) {
    try {
      const cache = await caches.open(INBOX_CACHE);
      await purgeInbox(cache);
      const key = newInboxKey();
      const headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name || 'shared.magpie.json') };
      await cache.put(new Request(scopeUrl(`./${INBOX_PATH}${key}`)), new Response(file, { headers }));
      return Response.redirect(scopeUrl(`./#/receive/${key}`), 303);
    } catch {
      // Storage full or unavailable: fall through to whatever text came with it.
    }
  }

  const title = field(form, 'title');
  const text = field(form, 'text');
  const url = field(form, 'url');
  // A Magpie link shared from a chat app goes straight to the import screen.
  const payload = findSharePayload(`${url}\n${text}\n${title}`);
  if (payload) return Response.redirect(scopeUrl(`./#/import/${payload}`), 303);

  // Anything else is handled by the app's normal ?title=&text=&url= share handling.
  const target = new URL(scopeUrl());
  if (title) target.searchParams.set('title', title);
  if (text) target.searchParams.set('text', text);
  if (url) target.searchParams.set('url', url);
  return Response.redirect(target.href, 303);
}

registerRoute(({ url, sameOrigin }) => sameOrigin && isShareTarget(url), ({ request }) => receiveShare(request), 'POST');

// A GET to ./share-target (older manifests / direct visits): back to the app, keeping the query.
registerRoute(
  ({ url, sameOrigin, request }) => sameOrigin && request.mode === 'navigate' && isShareTarget(url),
  async ({ url }) => Response.redirect(`${scopeUrl()}${url.search}`, 303),
);

// ---------------------------------------------------------------------------
// App shell and runtime caches

registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));

// Browsers count each opaque (no-CORS) response as several MB of storage, and these caches share the quota with
// your saves: keep them modest, and let them be emptied rather than a save failing when space runs out.

// Map tiles you've looked at stay available offline.
registerRoute(
  /^https:\/\/[a-z0-9.-]*tile\.openstreetmap\.org\//,
  new CacheFirst({
    cacheName: 'map-tiles',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true }),
    ],
  }),
);

// Thumbnails of saved links. The app keeps its own small copies (src/lib/thumbs.ts) where the image server allows it;
// where it doesn't, it loads the image once so it's cached here — the only copy left once a signed link (Instagram,
// Facebook…) expires, so kept for a year. thumbs.ts looks in this cache by name.
registerRoute(
  ({ request, sameOrigin }) => !sameOrigin && request.destination === 'image',
  new CacheFirst({
    cacheName: 'thumbnails',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365, purgeOnQuotaError: true }),
    ],
  }),
);
