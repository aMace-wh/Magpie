import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { useToast } from './Toast';

/**
 * Tells the user when the app is ready offline and when a new version has been downloaded.
 * Uses the shared toast stack so these notes never cover other messages (or hide behind a sheet).
 */
export function UpdatePrompt() {
  const toast = useToast();
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

  useEffect(() => {
    if (!offlineReady) return;
    toast('Magpie now works offline.');
    setOfflineReady(false);
  }, [offlineReady, setOfflineReady, toast]);

  useEffect(() => {
    if (!needRefresh) return;
    // If it's ignored, the new version still takes over the next time the app is opened.
    toast('A new version of Magpie is ready.', { label: 'Update', onClick: () => void updateServiceWorker(true) }, { duration: 15000 });
    setNeedRefresh(false);
  }, [needRefresh, setNeedRefresh, toast, updateServiceWorker]);

  return null;
}
