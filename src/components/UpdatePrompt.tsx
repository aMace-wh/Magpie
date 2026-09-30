import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/** Shows a banner when a new version has been downloaded, and when the app is ready offline. */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      // Check for updates hourly while the app stays open.
      if (reg) setInterval(() => void reg.update(), 60 * 60 * 1000);
    },
  });

  // The "ready offline" note is informational — let it fade on its own.
  useEffect(() => {
    if (!offlineReady) return;
    const t = setTimeout(() => setOfflineReady(false), 4000);
    return () => clearTimeout(t);
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh && !offlineReady) return null;
  return (
    <div className="toasts" style={{ zIndex: 1001 }}>
      <div className="toast">
        <span>{needRefresh ? 'A new version of Magpie is ready.' : 'Magpie now works offline.'}</span>
        {needRefresh && <button onClick={() => updateServiceWorker(true)}>Update</button>}
        <button
          onClick={() => {
            setNeedRefresh(false);
            setOfflineReady(false);
          }}
        >
          {needRefresh ? 'Later' : 'OK'}
        </button>
      </div>
    </div>
  );
}
