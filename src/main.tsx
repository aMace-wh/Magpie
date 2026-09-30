import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { db } from './lib/db';
import './styles.css';

// Ask the browser not to evict the library when storage runs low.
if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});

db.open().catch((e) => {
  document.body.textContent = `Magpie couldn't open its database: ${(e as Error).message}`;
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

// Fill in city / country for older saves that only have coordinates (a few per session, never blocking startup).
const backfill = () =>
  void import('./lib/backfill')
    .then((m) => m.backfillPlaceDetails())
    .catch(() => {});
whenIdle(backfill);
window.addEventListener('online', () => whenIdle(backfill, 2000));
