import { ArrowUpRight, ChevronDown, EyeOff, Play, WifiOff } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type Ref,
} from 'react';
import { hostOf, safeUrl, sourceLabel } from '../lib/classify';
import {
  EMBED_SANDBOX,
  authorOf,
  embedFor,
  embedHeightFromMessage,
  originalTextOf,
  resolvedTheme,
  snippetText,
  subscribeResolvedTheme,
  textParts,
  withAutoplay,
  type Embed,
} from '../lib/embed';
import { useSettings } from '../lib/settings';
import type { Item } from '../lib/types';
import { SourceIcon, sourceTint } from './SourceIcon';
import './OriginalPreview.css';

/** Tallest a portrait player gets before it's narrowed instead. */
const MAX_TALL = 560;

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}

function currentHost(): string | undefined {
  return typeof location !== 'undefined' ? location.hostname || undefined : undefined;
}

// The app is client-rendered only, so the "server" snapshot can read the live value too.
function useResolvedTheme(): 'light' | 'dark' | undefined {
  return useSyncExternalStore(subscribeResolvedTheme, resolvedTheme, resolvedTheme);
}

function frameStyle(embed: Embed, measured?: number): CSSProperties {
  const height = measured ?? embed.height;
  if (height) return { height, maxWidth: embed.maxWidth };
  const aspect = embed.aspect && embed.aspect > 0 ? embed.aspect : 16 / 9;
  if (embed.vertical) return { aspectRatio: `${aspect}`, width: `min(100%, ${Math.round(MAX_TALL * aspect)}px)` };
  return { aspectRatio: `${aspect}` };
}

interface FrameProps {
  embed: Embed;
  title: string;
  focusOnMount: boolean;
}

function EmbedFrame({ embed, title, focusOnMount }: FrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [measured, setMeasured] = useState<number>();
  // A new src (e.g. the theme changed) reloads the frame in place: start over on its size too.
  const [src, setSrc] = useState(embed.src);
  if (src !== embed.src) {
    setSrc(embed.src);
    setLoaded(false);
    setMeasured(undefined);
  }

  // Posts (Instagram, X, Reddit) tell their parent how tall they are; only trust the frame itself.
  useEffect(() => {
    let origin: string;
    try {
      origin = new URL(embed.src).origin;
    } catch {
      return;
    }
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || !ref.current || e.source !== ref.current.contentWindow) return;
      const h = embedHeightFromMessage(embed.provider, e.data);
      if (h) setMeasured(h);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embed.provider, embed.src]);

  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);

  return (
    <div className={`orig-frame${loaded ? ' is-loaded' : ''}`} style={frameStyle(embed, measured)}>
      {!loaded && (
        <span className="orig-frame-loading" aria-hidden="true">
          <span className="spinner" />
        </span>
      )}
      <iframe
        ref={ref}
        title={title}
        src={embed.src}
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow={embed.allow}
        allowFullScreen
        sandbox={EMBED_SANDBOX}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}

interface FacadeProps {
  embed: Embed;
  item: Item;
  waiting: boolean;
  onLoad: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}

/**
 * What's shown until the user asks for the player, so the player itself loads nothing before
 * then. The platform's own thumbnail (embed.poster) is only fetched when link previews are on.
 */
function Facade({ embed, item, waiting, onLoad, buttonRef }: FacadeProps) {
  const { previews } = useSettings();
  const [failed, setFailed] = useState<string[]>([]);
  const candidates = [safeUrl(item.image), previews ? embed.poster : undefined].filter(
    (u): u is string => !!u && !failed.includes(u),
  );
  const poster = candidates[0];
  const action = embed.kind === 'post' ? 'Load original post' : embed.kind === 'audio' ? 'Load player' : 'Load video';
  const cta = waiting ? 'Waiting for connection…' : action;
  const label = `${action} from ${embed.label}${waiting ? ' (waiting for connection)' : ''}`;
  const tint = { ['--tint' as string]: sourceTint(embed.provider) } as CSSProperties;
  const img = poster && (
    <img
      key={poster}
      className="orig-facade-img"
      src={poster}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed((f) => [...f, poster])}
    />
  );

  if (embed.kind === 'audio') {
    return (
      <div className="orig-audio">
        <div className="orig-audio-art" style={tint}>
          {img || <SourceIcon source={embed.provider} size={30} />}
        </div>
        <div className="orig-audio-info">
          <div className="orig-audio-k">{embed.label}</div>
          <div className="orig-audio-t">{item.title}</div>
        </div>
        <button ref={buttonRef} type="button" className="btn small primary" onClick={onLoad} aria-label={label}>
          <Play size={14} fill="currentColor" aria-hidden="true" /> {waiting ? 'Waiting…' : 'Load player'}
        </button>
      </div>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`orig-facade${poster ? '' : ' is-bare'}${embed.vertical ? ' is-vertical' : ''}`}
      style={tint}
      onClick={onLoad}
      aria-label={label}
    >
      {poster && embed.vertical && (
        <img className="orig-facade-blur" src={poster} alt="" loading="lazy" referrerPolicy="no-referrer" aria-hidden="true" />
      )}
      {img}
      <span className="orig-facade-badge">
        <SourceIcon source={embed.provider} size={18} />
        {embed.label}
      </span>
      {!poster && <SourceIcon source={embed.provider} size={44} />}
      <span className="orig-facade-cta">
        <Play size={16} fill="currentColor" aria-hidden="true" />
        <span>{cta}</span>
      </span>
    </button>
  );
}

function OriginalMedia({ embed, item, defaultOpen }: { embed: Embed; item: Item; defaultOpen: boolean }) {
  const online = useOnline();
  const [open, setOpen] = useState(defaultOpen);
  // Set when the user tapped play: autoplay, and move focus into the player.
  const [tapped, setTapped] = useState(false);
  // Once the player is up it stays up if the connection drops, so buffered video keeps playing.
  const [shown, setShown] = useState(false);
  if (open && online && !shown) setShown(true);
  if (!open && shown) setShown(false);
  const facadeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const showFrame = open && (online || shown);

  useEffect(() => {
    if (!showFrame && returnFocus.current) {
      returnFocus.current = false;
      facadeRef.current?.focus();
    }
  }, [showFrame]);

  const frameEmbed = useMemo(() => (tapped ? withAutoplay(embed) : embed), [embed, tapped]);
  const what = embed.kind === 'post' ? 'post' : embed.kind === 'audio' ? 'player' : 'video';

  return (
    <div className={`orig-media is-${embed.kind}`}>
      {showFrame ? (
        <>
          <EmbedFrame embed={frameEmbed} title={`${embed.label} ${what}: ${item.title}`} focusOnMount={tapped} />
          <div className="orig-media-bar">
            <span className="orig-media-from">Loaded from {embed.label}</span>
            <button
              type="button"
              className="btn small outline"
              onClick={() => {
                returnFocus.current = true;
                setOpen(false);
                setTapped(false);
              }}
            >
              <EyeOff size={14} aria-hidden="true" /> Hide
            </button>
          </div>
        </>
      ) : (
        <Facade
          embed={embed}
          item={item}
          waiting={open && !online}
          buttonRef={facadeRef}
          onLoad={() => {
            setOpen(true);
            setTapped(true);
          }}
        />
      )}
      {!online && !showFrame && (
        <p className="orig-offline" role="status">
          <WifiOff size={14} aria-hidden="true" />
          <span>You're offline — the original will load when you're back online.</span>
        </p>
      )}
    </div>
  );
}

function OriginalText({ text }: { text: string }) {
  const parts = useMemo(() => textParts(text), [text]);
  const ref = useRef<HTMLQuoteElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Only offer "Show more" when the clamp actually hides something at this width.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const check = () => setOverflows(el.scrollHeight - el.clientHeight > 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [parts, expanded]);

  return (
    <div className="orig-text">
      <blockquote id={id} ref={ref} dir="auto" className={`orig-quote${expanded ? ' is-open' : ''}`}>
        {parts.map((p, i) => {
          if (p.kind === 'url') {
            return (
              <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" title={p.href}>
                {p.display}
              </a>
            );
          }
          if (p.kind === 'tag') return <span key={i} className="orig-tag">{p.text}</span>;
          if (p.kind === 'mention') return <span key={i} className="orig-mention">{p.text}</span>;
          return p.text;
        })}
      </blockquote>
      {(overflows || expanded) && (
        <button type="button" className="orig-more" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
          <ChevronDown size={15} aria-hidden="true" className={expanded ? 'is-flipped' : undefined} />
        </button>
      )}
    </div>
  );
}

interface Props {
  item: Item;
  /** Load the embedded post / player straight away instead of the tap-to-load preview. */
  defaultOpen?: boolean;
  /** Show the "Original" section heading (default true). */
  heading?: boolean;
}

/**
 * The save as it originally appeared — the embedded post or player (after a tap, for
 * privacy), the text it was shared with, and where it came from — so it's easy to recognise.
 */
export function OriginalPreview({ item, defaultOpen = false, heading = true }: Props) {
  const headingId = useId();
  const theme = useResolvedTheme();
  const embed = useMemo(() => embedFor(item.url, { parentHost: currentHost(), theme }), [item.url, theme]);
  const text = originalTextOf(item);
  const href = safeUrl(item.url);

  if (!embed && !text && !href) return null;
  // A plain note already shows this text as the note itself.
  if (!embed && !href && text === item.note?.trim()) return null;

  const author = authorOf(item);
  // sourceLabel echoes keys it doesn't know ("soundcloud"); a real name from elsewhere reads better.
  const known = sourceLabel(item.source);
  const named = known && known !== item.source ? known : undefined;
  const platform = named ?? item.siteName ?? embed?.label ?? known ?? (href ? hostOf(href) : undefined);
  const showSource = !!(platform || author || href);

  return (
    <section className="orig" aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : 'Original'}>
      {heading && (
        <h2 className="section-title" id={headingId}>
          Original
        </h2>
      )}
      <div className="orig-card">
        {/* Keyed on the link, not embed.src, so a theme change restyles an open player instead of closing it. */}
        {embed && <OriginalMedia key={item.url} embed={embed} item={item} defaultOpen={defaultOpen} />}
        {text && <OriginalText key={text} text={text} />}
        {showSource && (
          <div className="orig-source">
            <SourceIcon source={item.source ?? embed?.provider} size={22} />
            <span className="orig-source-text">
              {platform && <span className="orig-source-name">{platform}</span>}
              {author && (
                <span className="orig-source-author">
                  {platform ? ' · ' : ''}
                  {author}
                </span>
              )}
            </span>
            {href && (
              <a className="orig-open" href={href} target="_blank" rel="noreferrer noopener">
                Open original <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface SnippetProps {
  item: Item;
  /** Lines to show before clamping (default 2). */
  lines?: number;
  className?: string;
}

/** A line or two of the original shared text for cards, or nothing when it would only repeat the title. */
export function OriginalSnippet({ item, lines = 2, className }: SnippetProps) {
  const text = useMemo(() => snippetText(originalTextOf(item), item.title), [item]);
  if (!text) return null;
  return (
    <span className={`orig-snippet${className ? ` ${className}` : ''}`} dir="auto" style={{ WebkitLineClamp: Math.max(1, lines) }}>
      {text}
    </span>
  );
}
