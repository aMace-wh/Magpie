import { Copy, FileDown, Mail, MessageCircle, MessageSquareText, Send, Share2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { plural } from '../lib/format';
import { getSettings, setSettings } from '../lib/settings';
import { payloadEmoji, payloadTitle, planShare, shareCollection, shareItem, shareLibrary, toShareFile, type SharePlan, type SharedPayloadV2 } from '../lib/share';
import { canShareFiles, copyText, downloadFile, isMobileDevice, shareFiles } from '../lib/shareSheet';
import { acceptsText, buildShareUrl, fileMessage, shareMessage, SOCIAL_TARGETS, targetShareUrl, type SocialTarget, type SocialTargetId } from '../lib/social';
import { TYPE_INFO, type Collection, type Item } from '../lib/types';
import { Sheet } from './Sheet';
import { useToast } from './Toast';
import './ShareSheet.css';

export type ShareSheetTarget =
  | { kind: 'item'; item: Item }
  | { kind: 'collection'; collection: Collection; items: Item[] }
  | { kind: 'library'; items: Item[]; collections: Collection[] };

interface Props {
  open: boolean;
  onClose: () => void;
  target: ShareSheetTarget;
}

interface Prepared {
  payload: SharedPayloadV2;
  plan: SharePlan;
}

const GLYPHS: Record<SocialTargetId, ReactNode> = {
  whatsapp: <MessageCircle size={23} strokeWidth={2.2} />,
  telegram: <Send size={20} strokeWidth={2.2} style={{ marginLeft: -2 }} />,
  messenger: <MessageCircle size={23} strokeWidth={2.2} fill="currentColor" fillOpacity={0.25} />,
  facebook: <b className="ss-letter big">f</b>,
  x: <b className="ss-letter">𝕏</b>,
  email: <Mail size={21} strokeWidth={2.2} />,
  sms: <MessageSquareText size={21} strokeWidth={2.2} />,
  line: <b className="ss-letter tiny">LINE</b>,
  reddit: <b className="ss-letter">r/</b>,
  linkedin: <b className="ss-letter">in</b>,
};

const hasPersonal = (i: Item) => (!!i.note && i.type !== 'note') || !!i.rating || !!i.review || i.status === 'done';

function openExternal(url: string) {
  if (/^https:/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  else window.location.href = url;
}

/** Share a save, a collection or your whole library with friends: chat apps, copy link, or a file when it's too big for a link. */
export function ShareSheet({ open, onClose, target }: Props) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [askName, setAskName] = useState(false);
  const [personal, setPersonal] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [failed, setFailed] = useState(false);
  const mobile = useMemo(isMobileDevice, []);

  // Pull the parts out so an inline `target={{ … }}` object doesn't redo the work on every render.
  const item = target.kind === 'item' ? target.item : undefined;
  const collection = target.kind === 'collection' ? target.collection : undefined;
  const items = target.kind === 'item' ? undefined : target.items;
  const collections = target.kind === 'library' ? target.collections : undefined;

  useEffect(() => {
    if (!open) return;
    const saved = getSettings().name.trim();
    setName(saved);
    setAskName(!saved);
    setPersonal(false);
    setFailed(false);
  }, [open]);

  const from = name.trim() || undefined;
  const payload = useMemo(() => {
    if (!open) return null;
    const opts = { from, includePersonal: personal };
    if (item) return shareItem(item, opts);
    if (collection && items) return shareCollection(collection, items, opts);
    if (items && collections) return shareLibrary(items, collections, opts);
    return null;
  }, [open, item, collection, items, collections, from, personal]);

  // Encode off the render path (and not on every keystroke of the name).
  useEffect(() => {
    if (!payload) return;
    let alive = true;
    const t = setTimeout(() => {
      planShare(payload).then(
        (plan) => {
          if (!alive) return;
          setPrepared({ payload, plan });
          setFailed(false);
        },
        () => {
          // No CompressionStream etc. — a file still works.
          if (!alive) return;
          setPrepared({ payload, plan: { slim: true, tooLong: true, length: 0, data: payload } });
          setFailed(true);
        },
      );
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [payload]);

  const ready = !!prepared && prepared.payload === payload;
  const plan = ready ? prepared.plan : undefined;
  const count = item ? 1 : (items?.length ?? 0);
  const personalAvailable = useMemo(() => (item ? hasPersonal(item) : (items ?? []).some(hasPersonal)), [item, items]);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const title = payload ? `${payloadEmoji(payload)} ${payloadTitle(payload)}` : '';

  const saveName = () => {
    const n = name.trim();
    if (askName && n && n !== getSettings().name) setSettings({ name: n });
  };

  /** Full-fidelity file: native share sheet if it takes files, else a download (then opens the chat app, if one was picked). */
  const sendFile = async (via?: SocialTarget) => {
    if (!ready) return;
    saveName();
    const full = prepared.payload;
    const text = fileMessage(full);
    const json = toShareFile(full);
    // Chrome on Android won't share .json files, but takes the same content as text.
    const shareable = [json, toShareFile(full, 'text')].find((f) => canShareFiles([f]));
    if (shareable) {
      const res = await shareFiles({ files: [shareable], title, text });
      if (res === 'shared' || res === 'cancelled') return;
    }
    downloadFile(json);
    if (via && acceptsText(via)) openExternal(buildShareUrl(via, { text, title }));
    toast(via ? `File saved — attach it in ${via.label}` : 'File saved — send it to your friend');
  };

  const copy = async () => {
    if (!plan?.url) return;
    saveName();
    toast((await copyText(plan.url)) ? 'Link copied' : "Couldn't copy — try Send as file");
  };

  const more = async () => {
    if (!ready || !payload) return;
    if (!plan?.url) return void sendFile();
    saveName();
    try {
      await navigator.share({ title, text: shareMessage(plan.data), url: plan.url });
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') toast("Couldn't open the share menu");
    }
  };

  const targets = SOCIAL_TARGETS.filter((t) => !t.mobileOnly || mobile);
  const sheetTitle = target.kind === 'item' ? 'Share this save' : target.kind === 'collection' ? 'Share collection' : 'Share your library';

  const summary = (() => {
    if (item) {
      return (
        <>
          <SummaryThumb image={item.image} emoji={TYPE_INFO[item.type].emoji} />
          <div className="grow">
            <div className="t">{item.title}</div>
            <div className="s">Your friend can add it to their Magpie in one tap</div>
          </div>
        </>
      );
    }
    if (collection) {
      return (
        <>
          <SummaryThumb emoji={collection.emoji} tint={collection.color} />
          <div className="grow">
            <div className="t">{collection.name}</div>
            <div className="s">Share {plural(count, 'save')}</div>
          </div>
        </>
      );
    }
    const cols = payload?.collections?.length ?? 0;
    return (
      <>
        <SummaryThumb emoji="📚" />
        <div className="grow">
          <div className="t">Your library</div>
          <div className="s">
            Share {plural(count, 'save')}
            {cols > 0 && ` in ${plural(cols, 'collection')}`}
          </div>
        </div>
      </>
    );
  })();

  return (
    <Sheet open={open} title={sheetTitle} onClose={onClose}>
      <div className="ss-summary">{summary}</div>

      {count === 0 ? (
        <p className="hint" style={{ marginTop: 14 }}>
          Nothing to share yet — add some saves first.
        </p>
      ) : (
        <>
          {askName && (
            <>
              <label className="label" htmlFor="ss-name">
                Your name
              </label>
              <input
                id="ss-name"
                className="input"
                value={name}
                maxLength={60}
                autoComplete="nickname"
                placeholder="So your friend knows it's from you"
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
              />
            </>
          )}

          {personalAvailable && (
            <div className="ss-toggle">
              <div className="grow">
                <div className="t" id="ss-personal">
                  Include my notes & ratings
                </div>
                <div className="s">{personal ? 'Friends see your notes, stars and reviews.' : 'Friends just get the saves.'}</div>
              </div>
              <button className="switch" role="switch" aria-checked={personal} aria-labelledby="ss-personal" onClick={() => setPersonal((v) => !v)} />
            </div>
          )}

          <div className="ss-status" aria-live="polite">
            {!ready ? (
              <span className="ss-making">
                <span className="spinner" aria-hidden /> Making your link…
              </span>
            ) : plan?.tooLong ? (
              <div className="ss-note">
                <FileDown size={18} aria-hidden />
                <span>
                  {failed
                    ? "This browser can't make Magpie links — send it as a file; your friend opens it with Magpie."
                    : 'This is too big for a link — send it as a file; your friend opens it with Magpie.'}
                </span>
              </div>
            ) : plan?.slim ? (
              <p className="hint">Photos and long descriptions are left out to keep the link short.</p>
            ) : null}
          </div>

          <div className="ss-grid">
            {targets.map((t) => {
              const style = { ['--glyph' as string]: t.color };
              const glyph = (
                <span className={`ss-glyph ss-${t.id}`} style={style} aria-hidden>
                  {GLYPHS[t.id]}
                </span>
              );
              const label = <span className="ss-label">{t.label}</span>;
              if (plan?.url) {
                const href = targetShareUrl(t, plan.data, plan.url);
                const web = /^https:/i.test(href);
                return (
                  <a
                    key={t.id}
                    className="ss-target"
                    href={href}
                    target={web ? '_blank' : undefined}
                    rel="noopener noreferrer"
                    onClick={saveName}
                  >
                    {glyph}
                    {label}
                  </a>
                );
              }
              // No link: chat apps get the file instead; public feeds can't take one.
              const usable = ready && t.direct;
              return (
                <button
                  key={t.id}
                  className="ss-target"
                  disabled={!usable}
                  title={ready && !t.direct ? 'Too big for a link' : undefined}
                  onClick={() => void sendFile(t)}
                >
                  {glyph}
                  {label}
                </button>
              );
            })}
          </div>

          <div className="ss-actions">
            <button className="btn small outline" disabled={!plan?.url} onClick={copy}>
              <Copy size={16} /> Copy link
            </button>
            <button className="btn small outline" disabled={!ready} onClick={() => void sendFile()}>
              <FileDown size={16} /> Send as file
            </button>
            {canNativeShare && (
              <button className="btn small outline" disabled={!ready} onClick={more}>
                <Share2 size={16} /> More…
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

function SummaryThumb({ image, emoji, tint }: { image?: string; emoji: string; tint?: string }) {
  const [broken, setBroken] = useState(false);
  const safe = image && /^https?:\/\//i.test(image) && !broken ? image : undefined;
  const color = tint && /^#[0-9a-f]{3,8}$/i.test(tint) ? tint : undefined;
  return (
    <div className="ss-thumb" style={color ? { background: `color-mix(in srgb, ${color} 22%, var(--surface))` } : undefined}>
      {safe ? <img src={safe} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : <span aria-hidden>{emoji}</span>}
    </div>
  );
}
