import { useSyncExternalStore } from 'react';

/** Tiny hash router: works offline and from any hosting sub-path. */

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
  };
}

function getPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  return h.startsWith('/') ? h : `/${h}`;
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, getPath, () => '/');
}

// Each in-app history entry records how deep it is, so "back" never leaves the app.
const depth = (): number => (history.state as { depth?: number } | null)?.depth ?? 0;

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState({ depth: depth() }, '', `#${path}`);
  else history.pushState({ depth: depth() + 1 }, '', `#${path}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function goBack(fallback = '/'): void {
  if (depth() > 0) history.back();
  else navigate(fallback, { replace: true });
}

export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'collections' }
  | { name: 'collection'; id: string }
  | { name: 'map' }
  | { name: 'journal' }
  | { name: 'item'; id: string }
  | { name: 'settings' }
  | { name: 'import'; payload: string };

export function parseRoute(path: string): Route {
  const [, a, ...rest] = path.split('/');
  const b = rest.join('/');
  switch (a) {
    case '':
    case undefined:
      return { name: 'home' };
    case 'new':
      return { name: 'new' };
    case 'collections':
      return b ? { name: 'collection', id: decodeURIComponent(b) } : { name: 'collections' };
    case 'map':
      return { name: 'map' };
    case 'journal':
      return { name: 'journal' };
    case 'item':
      return { name: 'item', id: decodeURIComponent(b) };
    case 'settings':
      return { name: 'settings' };
    case 'import':
      return { name: 'import', payload: b };
    default:
      return { name: 'home' };
  }
}
