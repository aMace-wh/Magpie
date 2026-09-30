import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { db } from './lib/db';
import './styles.css';

// Ask the browser not to evict the library when storage runs low.
if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});

db.open().catch((e) => {
  document.body.textContent = `Magpie couldn't open its database: ${(e as Error).message}`;
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
