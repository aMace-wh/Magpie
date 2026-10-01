import { useLiveQuery } from 'dexie-react-hooks';
import { Check, Copy, ExternalLink, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../components/Toast';
import { hostOf, safeUrl } from '../lib/classify';
import { plural } from '../lib/format';
import { isEmbeddedBrowser, isIos, isStandalone } from '../lib/install';
import { takeInboxFile } from '../lib/receive';
import { navigate } from '../lib/router';
import { useSettings } from '../lib/settings';
import { copyText } from '../lib/shareSheet';
import { decodeShare, payloadEmoji, payloadTitle, readShareFile, type SharedItemV2, type SharedPayloadV2 } from '../lib/share';
import { flag, placeLabel, whenLabel } from '../lib/social';
import { countSelection, importShare, planImport, type ImportPreview, type ImportResult, type ImportRowStatus } from '../lib/transfer';
import { TYPE_INFO } from '../lib/types';
import '../components/ShareSheet.css';

function ShareError({ title = "That link didn't work", text = 'It may have been cut off when it was sent. Ask for it again.' }: { title?: string; text?: string }) {
  return (
    <div className="empty">
      <div className="emoji">🔗</div>
      <h2>{title}</h2>
      <p>{text}</p>
      <button className="btn primary" onClick={() => navigate('/', { replace: true })}>
        Go to my library
      </button>
    </div>
  );
}

function Loading() {
  return (
    <div className="empty" aria-busy="true">
      <span className="spinner" aria-hidden />
      <p>Opening the share…</p>
    </div>
  );
}

/** Landing page for a share link someone sent you ("#/import/<payload>"). */
export function ImportScreen({ payload }: { payload: string }) {
  const [state, setState] = useState<{ data?: SharedPayloadV2; error?: boolean }>({});

  useEffect(() => {
    let alive = true;
    setState({});
    decodeShare(payload).then(
      (data) => alive && setState({ data }),
      () => alive && setState({ error: true }),
    );
    return () => {
      alive = false;
    };
  }, [payload]);

  if (state.error) return <ShareError />;
  if (!state.data) return <Loading />;
  return <ImportView data={state.data} link={window.location.href} />;
}

/** Import preview for a shared file (opened with the app, picked in Settings, or received from the share sheet). */
export function ImportFileView({ file }: { file: File | Blob }) {
  const [state, setState] = useState<{ data?: SharedPayloadV2; error?: string }>({});

  useEffect(() => {
    let alive = true;
    setState({});
    readShareFile(file).then(
      (data) => alive && setState({ data }),
      (e: unknown) => alive && setState({ error: e instanceof Error ? e.message : "That file isn't a Magpie share." }),
    );
    return () => {
      alive = false;
    };
  }, [file]);

  if (state.error) return <ShareError title="That file didn't open" text={state.error} />;
  if (!state.data) return <Loading />;
  return <ImportView data={state.data} />;
}

// takeInboxFile removes the file, so take it once per key (effects can run twice in development).
const inbox = new Map<string, Promise<File | undefined>>();

/** Landing page for a file shared to Magpie from another app ("#/receive/<key>", set up by the service worker). */
export function ReceiveView({ inboxKey }: { inboxKey: string }) {
  const [state, setState] = useState<{ file?: File; missing?: boolean }>({});

  useEffect(() => {
    let alive = true;
    let p = inbox.get(inboxKey);
    if (!p) inbox.set(inboxKey, (p = takeInboxFile(inboxKey)));
    p.then(
      (file) => alive && setState(file ? { file } : { missing: true }),
      () => alive && setState({ missing: true }),
    );
    return () => {
      alive = false;
    };
  }, [inboxKey]);

  if (state.missing) return <ShareError title="Nothing to import" text="That share was already opened or has expired. Try sharing it to Magpie again." />;
  if (!state.file) return <Loading />;
  return <ImportFileView file={state.file} />;
}

function rowMeta(s: SharedItemV2): string {
  const parts: string[] = [];
  const place = placeLabel(s.p);
  if (place) parts.push(`${flag(s.p?.countryCode) || '📍'} ${place}`);
  const when = whenLabel(s.w);
  if (when) parts.push(`📅 ${when}`);
  if (!parts.length) {
    const host = hostOf(safeUrl(s.u));
    parts.push(host ? `${TYPE_INFO[s.t].label} · ${host}` : TYPE_INFO[s.t].label);
  }
  if (typeof s.r === 'number' && s.r >= 1) parts.push(`★ ${Math.min(5, Math.round(s.r))}`);
  return parts.join(' · ');
}

// Pictures in a share come from addresses the sender chose, so they only load with link previews on.
function RowThumb({ s, images }: { s: SharedItemV2; images: boolean }) {
  const [broken, setBroken] = useState(false);
  const src = broken || !images ? undefined : safeUrl(s.i);
  const emoji = TYPE_INFO[s.t].emoji;
  return (
    <span className="thumb-sm imp-thumb">
      {src ? (
        <>
          <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
          <span className="imp-badge" aria-hidden>
            {emoji}
          </span>
        </>
      ) : (
        <span aria-hidden>{emoji}</span>
      )}
    </span>
  );
}

/**
 * The import button's text: "Add 3 to my Magpie", "Add 2 new · update 1", "Update my collection"…
 * Counts only the selected saves that will actually be added or updated, not ones you already have.
 * `selected` holds row keys (item indexes as strings, as ImportOptions.itemIds).
 */
export function importButtonLabel(data: SharedPayloadV2, preview: ImportPreview | undefined, selected: ReadonlySet<string>): string {
  const rows = preview?.rows ?? [];
  if (data.kind === 'item') {
    if (rows[0] === 'have' && preview?.existingItem) return 'Open my save';
    return rows[0] === 'update' ? 'Update my save' : 'Add to my Magpie';
  }
  const { new: added, update: updated, have } = countSelection(preview, data.items.length, selected);
  if (!added && !updated && !have) return 'Add to my Magpie';
  if (added && updated) return `Add ${added.toLocaleString()} new · update ${updated.toLocaleString()}`;
  if (added) return `Add ${added.toLocaleString()} to my Magpie`;
  const many = data.kind === 'library';
  const existing = !!preview?.existing || Object.keys(preview?.existingByKey ?? {}).length > 0;
  if (updated) return existing ? (many ? 'Update my collections' : 'Update my collection') : `Update ${plural(updated, 'save')}`;
  // Everything picked is already saved.
  if (existing) return many ? 'Open my collections' : 'Open my collection';
  return many ? 'Add the collections' : 'Add the collection';
}

function resultMessage(res: ImportResult, data: SharedPayloadV2): string {
  if (data.kind === 'item') {
    if (res.added) return 'Saved to your Magpie ✨';
    if (res.updated) return 'Updated with the latest version';
    return 'Already in your Magpie';
  }
  const parts: string[] = [];
  if (res.added) parts.push(`Added ${plural(res.added, 'save')}`);
  if (res.updated) parts.push(`updated ${res.updated}`);
  if (res.skipped) parts.push(`${res.skipped} already saved`);
  if (!parts.length) return 'Nothing new to add';
  const text = parts.join(' · ');
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * On an iPhone the Home Screen app keeps its saves apart from Safari, and chat apps' built-in browsers keep their
 * own: a share opened there wouldn't reach your Magpie. Offers the way across (copy the link, paste it with +).
 */
function ElsewhereNote({ link }: { link: string }) {
  const toast = useToast();
  const [where] = useState(() => (isEmbeddedBrowser() ? 'app' : isIos() && !isStandalone() ? 'safari' : undefined));
  if (!where) return null;
  const copy = async () => toast((await copyText(link)) ? 'Link copied — paste it into Magpie with the + button' : "Couldn't copy the link");
  return (
    <div className="imp-elsewhere" role="note">
      <Smartphone size={18} aria-hidden />
      <div className="grow">
        <strong>{where === 'app' ? 'Opened inside another app?' : 'Using Magpie from your Home Screen?'}</strong>
        <span>
          {where === 'app'
            ? 'Saves added here stay in this app’s browser. Open the link in Safari or Chrome — or copy it and paste it into Magpie with the + button.'
            : 'It keeps its own saves, apart from Safari. Copy this link, then open Magpie and paste it with the + button.'}
        </span>
      </div>
      <button type="button" className="btn small outline" onClick={copy}>
        <Copy size={14} aria-hidden /> Copy link
      </button>
    </div>
  );
}

/** Preview of a decoded share with checkboxes, and "Add N to my Magpie". `link`: the share link it was opened from. */
export function ImportView({ data, link }: { data: SharedPayloadV2; link?: string }) {
  const toast = useToast();
  const { previews } = useSettings();
  const preview = useLiveQuery(() => planImport(data), [data]);
  const keys = useMemo(() => data.items.map((_, i) => String(i)), [data]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(keys));
  const [busy, setBusy] = useState(false);

  useEffect(() => setSelected(new Set(keys)), [keys]);

  const single = data.kind === 'item';
  const n = data.items.length;
  const sender = data.from;
  const who = sender ?? 'Someone';
  const title = payloadTitle(data);
  const emoji = payloadEmoji(data);
  const statusOf = (i: number): ImportRowStatus => preview?.rows[i] ?? 'new';
  const newCount = countSelection(preview, n, selected).new;
  const existingCols = preview ? Object.values(preview.existingByKey) : [];

  let lead = single ? `${who} shared a save with you` : `${who} shared ${plural(n, 'save')} with you`;
  if (data.kind === 'library' && data.collections?.length) lead += ` in ${plural(data.collections.length, 'collection')}`;

  let update: string | undefined;
  if (preview?.existing) update = `Update “${preview.existing.name}” from ${sender ?? 'your friend'} — ${newCount} new`;
  else if (existingCols.length) update = `Updates ${plural(existingCols.length, 'collection')} you added before — ${newCount} new`;
  else if (single && preview?.rows[0] === 'update') update = 'You added this before — it will be updated';
  else if (single && preview?.rows[0] === 'have') update = 'Already in your Magpie';

  const alreadyHave = single && preview?.rows[0] === 'have' && preview.existingItem;
  const count = single ? 1 : selected.size;
  const label = importButtonLabel(data, preview, selected);

  const toggle = (k: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const accept = async () => {
    if (alreadyHave) return navigate(`/item/${encodeURIComponent(preview!.existingItem!.id)}`, { replace: true });
    setBusy(true);
    try {
      const res = await importShare(data, single ? {} : { itemIds: keys.filter((k) => selected.has(k)) });
      toast(resultMessage(res, data));
      if (single && res.itemId) navigate(`/item/${encodeURIComponent(res.itemId)}`, { replace: true });
      else if (res.collectionId) navigate(`/collections/${encodeURIComponent(res.collectionId)}`, { replace: true });
      else navigate('/collections', { replace: true });
    } catch (e) {
      setBusy(false);
      console.error('Import failed', e);
      toast("Couldn't add it — please try again.");
    }
  };

  const first = data.items[0];
  const cols = data.collections ?? [];

  return (
    <div className="item-wrap">
      <section className="hero imp-hero">
        <div className="imp-emoji" aria-hidden>
          {emoji}
        </div>
        <p className="imp-from">{lead}</p>
        <h2>{title}</h2>
        {preview?.own && <p className="imp-own">This came from your own Magpie.</p>}
        {update && <div className="imp-update">{update}</div>}
        {data.kind === 'library' && cols.length > 0 && (
          <div className="chips wrap imp-cols">
            {cols.slice(0, 8).map((c) => (
              <span key={c.key} className="chip tag">
                {c.emoji} {c.name}
              </span>
            ))}
            {cols.length > 8 && <span className="chip tag">+{cols.length - 8} more</span>}
          </div>
        )}
        {!single && n === 0 && <p className="imp-sub">This share is empty.</p>}
        {data.total !== undefined && (
          <p className="imp-sub">
            It had {data.total.toLocaleString()} saves — these are the first {n.toLocaleString()}. Ask {sender ?? 'your friend'} to send the rest in another
            share.
          </p>
        )}
        {link && <ElsewhereNote link={link} />}
        <div className="row imp-actions">
          <button className="btn fancy" onClick={accept} disabled={busy || !preview || count === 0}>
            {busy && <span className="spinner" aria-hidden />}
            {label}
          </button>
          <button className="btn outline" onClick={() => navigate('/', { replace: true })}>
            No thanks
          </button>
        </div>
      </section>

      {single && first && <ItemDetail s={first} sender={sender} images={previews} />}

      {!single && n > 0 && (
        <>
          <div className="imp-toolbar">
            <span>
              {selected.size} of {n} selected
            </span>
            <span className="spacer" />
            <button className="btn small outline" onClick={() => setSelected(new Set(keys))} disabled={selected.size === n}>
              All
            </button>
            <button className="btn small outline" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              None
            </button>
          </div>
          <div className="list">
            {data.items.map((s, i) => {
              const k = keys[i];
              const on = selected.has(k);
              const status = statusOf(i);
              return (
                <button key={k} className="list-row imp-row" role="checkbox" aria-checked={on} onClick={() => toggle(k)}>
                  <span className={on ? 'check on' : 'check'} aria-hidden>
                    <Check size={15} strokeWidth={3} />
                  </span>
                  <RowThumb s={s} images={previews} />
                  <span className="grow">
                    <span className="t">{s.n}</span>
                    <span className="s">{rowMeta(s)}</span>
                  </span>
                  {status !== 'new' && <span className={status === 'have' ? 'pill done imp-state' : 'pill imp-state'}>{status === 'have' ? 'Saved' : 'Update'}</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** Enough of a single shared save to recognise it: the original link, place, date and post text. */
function ItemDetail({ s, sender, images }: { s: SharedItemV2; sender?: string; images: boolean }) {
  const url = safeUrl(s.u);
  const place = placeLabel(s.p);
  const when = whenLabel(s.w);
  const [broken, setBroken] = useState(false);
  const image = broken || !images ? undefined : safeUrl(s.i);
  // For a note the note is the content; for anything else it's the sender's own comment.
  const text = s.x ?? s.ds ?? (s.t === 'note' ? s.d : undefined);
  const clipped = text && text.length > 600 ? `${text.slice(0, 600).trimEnd()}…` : text;
  const rating = typeof s.r === 'number' && s.r >= 1 ? Math.min(5, Math.round(s.r)) : 0;
  const comment = [s.t === 'note' ? undefined : s.d, s.rv].filter(Boolean).join(' — ');
  const verdict = [s.st === 'done' ? TYPE_INFO[s.t].done : '', rating ? '★'.repeat(rating) : ''].filter(Boolean).join(' · ');
  return (
    <div className="imp-detail">
      {image && <img className="imp-image" src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
      <div className="imp-line">
        <span aria-hidden>{TYPE_INFO[s.t].emoji}</span>
        <span>
          {TYPE_INFO[s.t].label}
          {url && (
            <>
              {' · '}
              <a href={url} target="_blank" rel="noopener noreferrer">
                {hostOf(url) || 'Open link'} <ExternalLink size={12} aria-hidden />
              </a>
            </>
          )}
        </span>
      </div>
      {place && (
        <div className="imp-line">
          <span aria-hidden>{flag(s.p?.countryCode) || '📍'}</span>
          <span>{place}</span>
        </div>
      )}
      {when && (
        <div className="imp-line">
          <span aria-hidden>📅</span>
          <span>{when}</span>
        </div>
      )}
      {(verdict || comment) && (
        <div className="imp-line">
          <span aria-hidden>💬</span>
          <span>
            {sender ?? 'Your friend'}
            {verdict && ` · ${verdict}`}
            {comment && `: ${comment}`}
          </span>
        </div>
      )}
      {clipped && <blockquote>{clipped}</blockquote>}
    </div>
  );
}
