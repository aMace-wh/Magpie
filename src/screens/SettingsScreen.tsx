import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Download, Monitor, Moon, Smartphone, Sparkles, Sun, Trash2, Upload } from 'lucide-react';
import { useRef } from 'react';
import { useToast } from '../components/Toast';
import { clearAll, db } from '../lib/db';
import { plural } from '../lib/format';
import { promptInstall, useInstall } from '../lib/install';
import { goBack } from '../lib/router';
import { addSampleData } from '../lib/samples';
import { setSettings, useSettings, type Settings } from '../lib/settings';
import { exportBackup, importBackup } from '../lib/transfer';

export function SettingsScreen() {
  const toast = useToast();
  const settings = useSettings();
  const install = useInstall();
  const file = useRef<HTMLInputElement>(null);
  const counts = useLiveQuery(async () => ({ items: await db.items.count(), collections: await db.collections.count() }), []);

  const download = async () => {
    const backup = await exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `magpie-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const restore = async (f: File) => {
    try {
      const res = await importBackup(JSON.parse(await f.text()));
      toast(`Restored ${plural(res.items, 'save')} and ${plural(res.collections, 'collection')}`);
    } catch (e) {
      toast(e instanceof SyntaxError ? "That file isn't valid JSON." : (e as Error).message);
    }
  };

  const wipe = async () => {
    if (!confirm('Delete every save and collection on this device? This cannot be undone. Consider downloading a backup first.')) return;
    await clearAll();
    toast('Everything deleted');
  };

  const themes: { id: Settings['theme']; label: string; icon: typeof Sun }[] = [
    { id: 'system', label: 'Auto', icon: Monitor },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
  ];

  return (
    <div className="item-wrap">
      <header className="page-header">
        <button className="icon-btn" aria-label="Back" onClick={() => goBack('/')}>
          <ArrowLeft size={20} />
        </button>
        <h1 className="page-title small">Settings</h1>
      </header>

      {!install.standalone && (
        <>
          <h2 className="section-title">Install</h2>
          <div className="settings-group">
            <div className="setting">
              <Smartphone size={22} />
              <div className="grow">
                <div className="t">Install Magpie</div>
                <div className="s">
                  {install.canPrompt
                    ? 'Adds Magpie to your home screen and to the Share menu of other apps.'
                    : install.ios
                      ? 'In Safari, tap Share → "Add to Home Screen".'
                      : 'Use your browser menu → "Install app" or "Add to Home screen".'}
                </div>
              </div>
              {install.canPrompt && (
                <button className="btn small primary" onClick={() => promptInstall()}>
                  Install
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <h2 className="section-title">Appearance</h2>
      <div className="settings-group">
        <div className="setting">
          <div className="grow">
            <div className="t">Theme</div>
          </div>
          <div className="segmented">
            {themes.map((t) => (
              <button key={t.id} aria-pressed={settings.theme === t.id} onClick={() => setSettings({ theme: t.id })}>
                <t.icon size={14} /> {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <h2 className="section-title">Smart features</h2>
      <div className="settings-group">
        <div className="setting">
          <div className="grow">
            <div className="t">Fetch link previews</div>
            <div className="s">
              Gets titles and images for links you save. The link (only) is sent to noembed.com / microlink.io. Sorting and tagging always
              happen on your device.
            </div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={settings.previews}
            aria-label="Fetch link previews"
            onClick={() => setSettings({ previews: !settings.previews })}
          />
        </div>
      </div>

      <h2 className="section-title">Your data</h2>
      <p className="hint" style={{ margin: '-4px 0 10px' }}>
        {counts ? `${plural(counts.items, 'save')} and ${plural(counts.collections, 'collection')}, stored only on this device.` : ' '}
      </p>
      <div className="settings-group">
        <button className="setting" onClick={download}>
          <Download size={20} />
          <div className="grow">
            <div className="t">Download backup</div>
            <div className="s">A JSON file with everything. Use it to move to another device.</div>
          </div>
        </button>
        <button className="setting" onClick={() => file.current?.click()}>
          <Upload size={20} />
          <div className="grow">
            <div className="t">Restore from backup</div>
            <div className="s">Merges a backup file into this library.</div>
          </div>
        </button>
        <button
          className="setting"
          onClick={async () => {
            await addSampleData();
            toast('Examples added');
          }}
        >
          <Sparkles size={20} />
          <div className="grow">
            <div className="t">Add example saves</div>
          </div>
        </button>
        <button className="setting danger" onClick={wipe}>
          <Trash2 size={20} color="var(--danger)" />
          <div className="grow">
            <div className="t">Delete everything</div>
          </div>
        </button>
      </div>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void restore(f);
          e.target.value = '';
        }}
      />

      <h2 className="section-title">About</h2>
      <p className="hint">
        Magpie v{__APP_VERSION__} — works offline, no account needed. Map data © OpenStreetMap contributors.
      </p>
    </div>
  );
}
