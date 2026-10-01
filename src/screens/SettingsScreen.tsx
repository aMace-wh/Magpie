import {
  ArrowLeft,
  CalendarPlus,
  ChevronRight,
  Copy,
  Download,
  FileInput,
  Link2,
  Monitor,
  Moon,
  Share2,
  Smartphone,
  Sparkles,
  Stethoscope,
  Sun,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { DbStatus, useDbHealth } from '../components/DbStatus';
import { ShareSheet } from '../components/ShareSheet';
import { useToast } from '../components/Toast';
import { calendarEventFromItem, downloadIcs, toIcs, type CalendarEvent } from '../lib/calendar';
import { clearAll, db } from '../lib/db';
import { formatDiagnostics, STATUS_LABEL, type DiagnosticsEnv } from '../lib/dbHealth';
import { clearDrafts } from '../lib/drafts';
import { plural } from '../lib/format';
import { isEmbeddedBrowser, isStandalone, promptInstall, useInstall } from '../lib/install';
import { useLiveQuery } from '../lib/live';
import { setPendingImport } from '../lib/pendingImport';
import { goBack, navigate } from '../lib/router';
import { addSampleData } from '../lib/samples';
import { setSettings, useSettings, type Settings } from '../lib/settings';
import { parseShareInput } from '../lib/share';
import { copyText } from '../lib/shareSheet';
import { exportBackup, importBackup } from '../lib/transfer';

export function SettingsScreen() {
  const toast = useToast();
  const settings = useSettings();
  const install = useInstall();
  const file = useRef<HTMLInputElement>(null);
  const shareFile = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const [sharing, setSharing] = useState(false);
  const nameId = useId();
  const linkId = useId();
  const items = useLiveQuery(() => db.items.orderBy('createdAt').reverse().toArray(), []);
  const collections = useLiveQuery(() => db.collections.toArray(), []);
  const events = useMemo(() => (items ?? []).map(calendarEventFromItem).filter((e): e is CalendarEvent => !!e), [items]);

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
    // Unsaved drafts too (text from failed saves, kept for a retry).
    clearDrafts();
    toast('Everything deleted');
  };

  const shareLibrary = () => {
    if (!items?.length) return toast('Save something first, then share it.');
    setSharing(true);
  };

  const openLink = (e: FormEvent) => {
    e.preventDefault();
    const payload = parseShareInput(link);
    if (!payload) return toast("That doesn't look like a Magpie link");
    setLink('');
    navigate(`/import/${payload}`);
  };

  const openShareFile = (f: File) => {
    setPendingImport(f);
    navigate('/import-file');
  };

  const exportCalendar = () => {
    if (!events.length) return toast('No saves with a date yet.');
    const ok = downloadIcs('magpie-events', toIcs(events, { name: 'Magpie' }));
    toast(ok ? `Calendar file saved — ${plural(events.length, 'event')}` : "Couldn't make the calendar file");
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

      <DbStatus />

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
        <div className="setting wraps">
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

      <h2 className="section-title">Share with friends</h2>
      <div className="settings-group">
        <div className="setting setting-field">
          <UserRound size={20} aria-hidden />
          <div className="grow">
            <label className="t" htmlFor={nameId}>
              Your name
            </label>
            <div className="s" id={`${nameId}-hint`}>
              Shown to friends when you share
            </div>
            <input
              id={nameId}
              className="input"
              type="text"
              autoComplete="given-name"
              maxLength={40}
              placeholder="e.g. Sam"
              aria-describedby={`${nameId}-hint`}
              value={settings.name}
              onChange={(e) => setSettings({ name: e.target.value })}
              onBlur={(e) => setSettings({ name: e.target.value.trim() })}
            />
          </div>
        </div>
        <button className="setting" onClick={shareLibrary}>
          <Share2 size={20} />
          <div className="grow">
            <div className="t">Share my library</div>
            <div className="s">
              {items?.length
                ? `Send all ${plural(items.length, 'save')} with a link or a file — WhatsApp, Telegram, email and more.`
                : 'Send your saves with a link or a file — WhatsApp, Telegram, email and more.'}
            </div>
          </div>
        </button>
      </div>

      <h2 className="section-title">Add a friend's share</h2>
      <div className="settings-group">
        <button className="setting" onClick={() => shareFile.current?.click()}>
          <FileInput size={20} />
          <div className="grow">
            <div className="t">Open a share file</div>
            <div className="s">A .magpie.json or .txt file a friend sent you. You'll see what's inside before adding anything.</div>
          </div>
        </button>
        <form className="setting setting-field" onSubmit={openLink}>
          <Link2 size={20} aria-hidden />
          <div className="grow">
            <label className="t" htmlFor={linkId}>
              Paste a share link
            </label>
            <div className="field-row">
              <input
                id={linkId}
                className="input"
                type="text"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="https://…#/import/…"
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
              <button className="btn primary" type="submit" disabled={!link.trim()}>
                Open
              </button>
            </div>
          </div>
        </form>
      </div>
      <input
        ref={shareFile}
        type="file"
        accept=".json,.magpie,.txt,application/json,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) openShareFile(f);
        }}
      />

      <h2 className="section-title">Smart features</h2>
      <div className="settings-group">
        <div className="setting">
          <div className="grow">
            <div className="t">Link previews and place details</div>
            <div className="s">
              Gets titles and images for links you save (only the link is sent to noembed.com / microlink.io) and shows the pictures in a
              friend's share before you add it. Fills in the city and country of saved places in the background (only the coordinates
              are sent to OpenStreetMap Nominatim). Sorting and tagging always happen on your device.
            </div>
          </div>
          <button
            className="switch"
            role="switch"
            aria-checked={settings.previews}
            aria-label="Link previews and place details"
            onClick={() => setSettings({ previews: !settings.previews })}
          />
        </div>
      </div>

      <h2 className="section-title">Your data</h2>
      <p className="hint" style={{ margin: '-4px 0 10px' }}>
        {items && collections
          ? `${plural(items.length, 'save')} and ${plural(collections.length, 'collection')}, stored only on this device.`
          : ' '}
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
        <button className="setting" onClick={exportCalendar}>
          <CalendarPlus size={20} />
          <div className="grow">
            <div className="t">Export dated saves to calendar (.ics)</div>
            <div className="s">
              {events.length
                ? `${plural(events.length, 'save')} with a date, for Google, Apple or Outlook Calendar.`
                : 'Saves with a date show up here, for Google, Apple or Outlook Calendar.'}
            </div>
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
      <Diagnostics />

      {items && items.length > 0 && (
        <ShareSheet open={sharing} onClose={() => setSharing(false)} target={{ kind: 'library', items, collections: collections ?? [] }} />
      )}
    </div>
  );
}

const size = (bytes: number) =>
  bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(1)} GB` : `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

/** What we need to look into a "Magpie is stuck" report: storage health, how Magpie is running, the browser. */
function Diagnostics() {
  const toast = useToast();
  const health = useDbHealth();
  const [storage, setStorage] = useState<Pick<DiagnosticsEnv, 'persisted' | 'usage'>>({});
  const [env] = useState(() => ({ standalone: isStandalone(), embedded: isEmbeddedBrowser(), userAgent: navigator.userAgent }));

  const loadStorage = async () => {
    try {
      const [persisted, estimate] = await Promise.all([navigator.storage?.persisted?.(), navigator.storage?.estimate?.()]);
      const usage = estimate?.usage === undefined ? undefined : `${size(estimate.usage)}${estimate.quota ? ` of ${size(estimate.quota)}` : ''}`;
      setStorage({ persisted, usage });
    } catch {
      // Not available here.
    }
  };

  const copy = async () => {
    const text = formatDiagnostics(health, { version: __APP_VERSION__, online: navigator.onLine, ...env, ...storage });
    toast((await copyText(text)) ? 'Diagnostics copied — paste them in your message to us' : "Couldn't copy — try again");
  };

  return (
    <details
      className="diagnostics"
      onToggle={(e) => {
        if (e.currentTarget.open) void loadStorage();
      }}
    >
      <summary>
        <Stethoscope size={20} aria-hidden />
        <div className="grow">
          <div>Diagnostics</div>
          <div className="s">Storage: {STATUS_LABEL[health.status].toLowerCase()}</div>
        </div>
        <ChevronRight size={18} aria-hidden className="diagnostics-chevron" />
      </summary>
      <div className="diagnostics-body">
        <dl className="diagnostics-list">
          <dt>Storage</dt>
          <dd>{STATUS_LABEL[health.status]}</dd>
          <dt>Last open</dt>
          <dd>{health.openMs === undefined ? '—' : `${health.openMs} ms${health.opens > 1 ? ` (opened ${health.opens} times)` : ''}`}</dd>
          {health.lastError && (
            <>
              <dt>Last error</dt>
              <dd>{health.lastError}</dd>
            </>
          )}
          <dt>Running as</dt>
          <dd>{env.standalone ? 'Installed app' : 'Browser tab'}</dd>
          <dt>Built-in browser</dt>
          <dd>{env.embedded ? "Yes — inside another app's browser" : 'No'}</dd>
          {storage.persisted !== undefined && (
            <>
              <dt>Kept safe</dt>
              <dd>{storage.persisted ? 'Yes — the browser won’t clear it to free space' : 'No — the browser may clear it when space runs low'}</dd>
            </>
          )}
          {storage.usage && (
            <>
              <dt>Space used</dt>
              <dd>{storage.usage}</dd>
            </>
          )}
          <dt>Browser</dt>
          <dd>{env.userAgent}</dd>
        </dl>
        <span className="label">Recent storage events</span>
        <pre className="diagnostics-events">
          {health.events.length
            ? health.events
                .slice(-8)
                .map((e) => `${new Date(e.at).toLocaleTimeString()} ${e.kind}${e.detail ? ` — ${e.detail}` : ''}`)
                .join('\n')
            : 'None yet'}
        </pre>
        <button type="button" className="btn small outline" onClick={copy}>
          <Copy size={14} aria-hidden /> Copy diagnostics
        </button>
      </div>
    </details>
  );
}
