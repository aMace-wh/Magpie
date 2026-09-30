import { BookOpen, House, LayoutGrid, Map as MapIcon, Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SaveSheet } from './components/SaveSheet';
import { ToastProvider } from './components/Toast';
import { UpdatePrompt } from './components/UpdatePrompt';
import type { SharedInput } from './lib/classify';
import { setPendingImport, usePendingImport } from './lib/pendingImport';
import { onLaunchFiles } from './lib/receive';
import { navigate, parseRoute, usePath, type Route } from './lib/router';
import { useSettings } from './lib/settings';
import { parseShareInput } from './lib/share';
import { CollectionScreen } from './screens/CollectionScreen';
import { CollectionsScreen } from './screens/CollectionsScreen';
import { HomeScreen } from './screens/HomeScreen';
import { ImportFileView, ImportScreen, ReceiveView } from './screens/ImportScreen';
import { ItemScreen } from './screens/ItemScreen';
import { JournalScreen } from './screens/JournalScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import './screens/screens.css';

// The map pulls in Leaflet, so it's loaded on first visit.
const MapScreen = lazy(() => import('./screens/MapScreen').then((m) => ({ default: m.MapScreen })));

interface SaveRequest {
  initial?: SharedInput;
  collectionId?: string;
}

/**
 * Content handed over by the OS share sheet (Web Share Target) arrives as query params.
 * A friend's Magpie link opens the import screen instead of the save sheet.
 */
function takeSharedInput(): SharedInput | undefined {
  const params = new URLSearchParams(window.location.search);
  const input = { title: params.get('title'), text: params.get('text'), url: params.get('url') };
  if (!input.title && !input.text && !input.url) return undefined;
  // Not `bare`: a single word shared from another app is something to save, not a share.
  const payload = parseShareInput([input.url, input.text, input.title].filter(Boolean).join('\n'), { bare: false });
  history.replaceState(null, '', `${window.location.pathname}${window.location.hash || '#/'}`);
  if (payload) {
    navigate(`/import/${payload}`, { replace: true });
    return undefined;
  }
  return input;
}

// Read once at startup (not inside a component, which may render twice).
const sharedAtLaunch = takeSharedInput();

function useTheme() {
  const { theme } = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      if (theme === 'system') delete root.dataset.theme;
      else root.dataset.theme = theme;
      root.dataset.resolvedTheme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f0e15' : '#f6f4ef');
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

const TABS = [
  { path: '/', label: 'Library', icon: House, match: (r: Route) => r.name === 'home' || r.name === 'item' },
  { path: '/collections', label: 'Collections', icon: LayoutGrid, match: (r: Route) => r.name === 'collections' || r.name === 'collection' },
  { path: '/map', label: 'Map', icon: MapIcon, match: (r: Route) => r.name === 'map' },
  { path: '/journal', label: 'Journal', icon: BookOpen, match: (r: Route) => r.name === 'journal' },
];

export function App() {
  useTheme();
  const path = usePath();
  const route = parseRoute(path);
  const [save, setSave] = useState<SaveRequest | null>(sharedAtLaunch ? { initial: sharedAtLaunch } : null);

  // "#/new" (home-screen shortcut) opens the save sheet.
  useEffect(() => {
    if (route.name === 'new') {
      navigate('/', { replace: true });
      setSave({});
    }
  }, [route.name]);

  // Share files the installed app was opened with (File Handling API).
  useEffect(() => {
    onLaunchFiles((files) => {
      setPendingImport(files[0]);
      navigate('/import-file');
    });
  }, []);

  const openSave = (collectionId?: string) => setSave({ collectionId });

  let screen;
  switch (route.name) {
    case 'collections':
      screen = <CollectionsScreen />;
      break;
    case 'collection':
      screen = <CollectionScreen key={route.id} id={route.id} onAdd={openSave} />;
      break;
    case 'map':
      screen = <MapScreen />;
      break;
    case 'journal':
      screen = <JournalScreen />;
      break;
    case 'item':
      screen = <ItemScreen key={route.id} id={route.id} />;
      break;
    case 'settings':
      screen = <SettingsScreen />;
      break;
    case 'import':
      screen = <ImportScreen payload={route.payload} />;
      break;
    case 'receive':
      screen = <ReceiveView key={route.key} inboxKey={route.key} />;
      break;
    case 'import-file':
      screen = <PendingImport />;
      break;
    default:
      screen = <HomeScreen onAdd={() => openSave()} />;
  }

  const [left, right] = [TABS.slice(0, 2), TABS.slice(2)];
  const tab = (t: (typeof TABS)[number]) => (
    <button key={t.path} className="nav-item" aria-current={t.match(route) ? 'page' : undefined} onClick={() => navigate(t.path)}>
      <t.icon size={22} strokeWidth={t.match(route) ? 2.4 : 2} />
      <span>{t.label}</span>
    </button>
  );

  return (
    <ToastProvider>
      <div className="app">
        <nav className="nav" aria-label="Main">
          <div className="nav-brand">
            <img src="pwa-192.png" alt="" /> Magpie
          </div>
          {left.map(tab)}
          <button className="nav-add" aria-label="Save something" onClick={() => openSave()}>
            <Plus size={26} strokeWidth={2.6} />
            <span className="nav-add-label">Save</span>
          </button>
          {right.map(tab)}
        </nav>
        <main className={route.name === 'map' ? 'main full' : 'main'}>
          <ErrorBoundary resetKey={path}>
            <Suspense fallback={null}>{screen}</Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <SaveSheet open={!!save} initial={save?.initial} collectionId={save?.collectionId} onClose={() => setSave(null)} />
      <UpdatePrompt />
    </ToastProvider>
  );
}

/** "#/import-file": previews the share file picked in Settings or opened with the app. */
function PendingImport() {
  const file = usePendingImport();
  if (file) return <ImportFileView file={file} />;
  // e.g. the page was reloaded: the file only lived in memory.
  return (
    <div className="empty">
      <div className="emoji">📂</div>
      <h2>Nothing to import</h2>
      <p>Open the share file again from Settings → Add a friend's share.</p>
      <button className="btn primary" onClick={() => navigate('/settings', { replace: true })}>
        Go to Settings
      </button>
    </div>
  );
}
