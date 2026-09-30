import { hostOf, safeUrl, youtubeId } from './classify';

/**
 * Link previews (title, image, description). Browsers can't read other sites'
 * HTML directly (CORS), so this asks public CORS-friendly preview services.
 * It can be switched off in Settings; saving works without it.
 */

export interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  /** Where the link ended up after redirects — short map links resolve to ones with coordinates. */
  finalUrl?: string;
}

const TIMEOUT_MS = 8000;

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function clean(s: unknown, max = 300): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** oEmbed via noembed.com — covers YouTube, Vimeo, TikTok, Flickr, SoundCloud and more. */
async function fromNoembed(url: string, signal?: AbortSignal): Promise<LinkPreview | undefined> {
  const data = (await getJson(`https://noembed.com/embed?url=${encodeURIComponent(url)}`, signal)) as Record<string, unknown>;
  if (!data || data.error) return undefined;
  return {
    title: clean(data.title),
    image: safeUrl(data.thumbnail_url),
    siteName: clean(data.provider_name, 60),
    description: clean(data.author_name) ? `by ${clean(data.author_name)}` : undefined,
  };
}

/** Open Graph / meta tags via microlink.io's free tier. */
async function fromMicrolink(url: string, signal?: AbortSignal): Promise<LinkPreview | undefined> {
  const res = (await getJson(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, signal)) as {
    status?: string;
    data?: Record<string, unknown>;
  };
  if (res?.status !== 'success' || !res.data) return undefined;
  const d = res.data;
  const image = (d.image as { url?: string } | null)?.url ?? (d.logo as { url?: string } | null)?.url;
  return {
    title: clean(d.title),
    description: clean(d.description, 500),
    image: safeUrl(image),
    siteName: clean(d.publisher, 60),
    finalUrl: safeUrl(d.url),
  };
}

const OEMBED_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'soundcloud.com', 'flickr.com', 'dailymotion.com'];

export async function fetchPreview(url: string, signal?: AbortSignal): Promise<LinkPreview> {
  const host = hostOf(url);
  const preview: LinkPreview = {};
  const yt = youtubeId(url);
  if (yt) preview.image = `https://i.ytimg.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg`;

  const merge = (p: LinkPreview | undefined) => {
    if (!p) return;
    for (const k of Object.keys(p) as (keyof LinkPreview)[]) if (!preview[k] && p[k]) preview[k] = p[k];
  };

  const attempts = OEMBED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? [fromNoembed, fromMicrolink] : [fromMicrolink];
  for (const attempt of attempts) {
    if (preview.title && preview.image) break;
    try {
      merge(await attempt(url, signal));
    } catch {
      /* try the next source */
    }
  }
  return preview;
}
