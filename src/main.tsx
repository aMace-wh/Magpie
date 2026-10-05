import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { db, dbHealth } from './lib/db';
import './styles.css';

// Open the database straight away. The app renders either way: dbHealth tracks how the open goes (slow,
// blocked, failed, lost later on) and the screens show that, with a way to retry.
db.open().catch(() => {});

// Leave a trail for remote debugging (e.g. Safari's Web Inspector) when storage misbehaves.
let lastStatus = dbHealth.getSnapshot().status;
dbHealth.subscribe(() => {
  const h = dbHealth.getSnapshot();
  if (h.status === lastStatus) return;
  lastStatus = h.status;
  const log = h.status === 'ready' || h.status === 'opening' ? console.info : console.warn;
  log(`[Magpie] storage: ${h.status}`, h.status === 'ready' ? `${h.openMs} ms` : h.status === 'error' || h.status === 'stuck' ? h.lastError ?? '' : '');
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

/** Runs `task` once the app has settled: a few seconds after start, when the browser is idle. */
function whenIdle(task: () => void, delay = 4000): void {
  setTimeout(() => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(task, { timeout: 10000 });
    else setTimeout(task, 0);
  }, delay);
}

// Background catch-up, a little per session and never blocking startup: older saves looked at again (titles from
// captions, kinds, dates, places), city / country for saves that only have coordinates, and previews or pictures
// that didn't come.
const backfill = () =>
  void import('./lib/backfill')
    .then((m) => m.backgroundWork())
    .catch(() => {});
whenIdle(backfill);
window.addEventListener('online', () => whenIdle(backfill, 2000));

// Ask the browser not to evict the library when storage runs low. Not while this file is still running: Chrome
// looks up where a call like this came from, and for top-level code that means parsing the whole bundle again
// (a fifth of a second on a slow phone, before anything is drawn).
whenIdle(() => void navigator.storage?.persist?.().catch(() => {}), 0);
