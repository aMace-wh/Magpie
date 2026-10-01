import { Smartphone, X } from 'lucide-react';
import { isEmbeddedBrowser, promptInstall, useInstall } from '../lib/install';
import { setSettings, useSettings } from '../lib/settings';

/**
 * Suggests installing Magpie: a one-tap Install where the browser offers it (Android, desktop Chrome/Edge),
 * or the Add to Home Screen steps on iPhone and iPad. Hidden once installed or closed.
 */
export function InstallBanner() {
  const install = useInstall();
  const { installDismissed } = useSettings();
  // In another app's built-in browser installing isn't possible; StorageWarning explains what to do instead.
  if (install.standalone || installDismissed || isEmbeddedBrowser() || (!install.canPrompt && !install.ios)) return null;

  return (
    <aside className="install-banner" aria-label="Install Magpie">
      <Smartphone size={22} aria-hidden className="install-banner-icon" />
      <div className="install-banner-text">
        <strong>Install Magpie</strong>
        <span>
          {install.canPrompt
            ? 'Then save straight from TikTok, Instagram, YouTube or Maps with their Share button.'
            : 'In Safari, tap Share, then “Add to Home Screen”, and save from there: the Home Screen app keeps its own saves, separate from Safari.'}
        </span>
      </div>
      {install.canPrompt && (
        <button className="btn small primary" onClick={() => void promptInstall()}>
          Install
        </button>
      )}
      <button className="icon-btn ghost" aria-label="Close" onClick={() => setSettings({ installDismissed: true })}>
        <X size={18} />
      </button>
    </aside>
  );
}
