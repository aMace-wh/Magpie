import { Copy, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';
import { isEmbeddedBrowser } from '../lib/install';
import { copyText } from '../lib/shareSheet';
import { useToast } from './Toast';

/**
 * Magpie keeps saves in the browser it runs in. Inside another app's built-in browser that storage belongs to
 * the app and can vanish, so say so before anything is saved there.
 */
export function StorageWarning() {
  const toast = useToast();
  const [embedded] = useState(() => isEmbeddedBrowser());
  const [hidden, setHidden] = useState(false);
  if (!embedded || hidden) return null;

  const copy = async () => {
    const link = `${location.origin}${location.pathname}`;
    toast((await copyText(link)) ? 'Link copied — open it in Chrome or Safari' : "Couldn't copy the link");
  };

  return (
    <aside className="storage-warning" role="alert">
      <TriangleAlert size={20} aria-hidden className="storage-warning-icon" />
      <div className="install-banner-text">
        <strong>Saves made here may not be kept</strong>
        <span>You're in another app's built-in browser. Open Magpie in Chrome or Safari (or install it) so your saves stay put.</span>
        <button type="button" className="btn small outline" onClick={copy}>
          <Copy size={14} aria-hidden /> Copy Magpie's link
        </button>
      </div>
      <button className="icon-btn ghost" aria-label="Close" onClick={() => setHidden(true)}>
        <X size={18} />
      </button>
    </aside>
  );
}
