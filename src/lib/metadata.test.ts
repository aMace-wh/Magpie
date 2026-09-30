import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPreview } from './metadata';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const isNoembed = (url: string) => url.startsWith('https://noembed.com/');
const isMicrolink = (url: string) => url.startsWith('https://api.microlink.io/');

/** Replaces fetch so no test ever touches the network. */
function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A fetch that only settles when its request is aborted. */
const hang: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('fetchPreview', () => {
  it('asks noembed first for oEmbed providers and stops once it has a title and image', async () => {
    const fetch = mockFetch((url) => {
      if (isNoembed(url)) {
        return json({
          title: 'Never Gonna Give You Up - YouTube',
          author_name: 'Rick Astley',
          provider_name: 'YouTube',
          thumbnail_url: 'https://i.ytimg.com/vi/other/hqdefault.jpg',
          type: 'video',
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const p = await fetchPreview('https://youtu.be/dQw4w9WgXcQ');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('https://noembed.com/embed?url=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ');
    expect(p).toEqual({
      title: 'Never Gonna Give You Up',
      rawTitle: 'Never Gonna Give You Up - YouTube',
      image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      siteName: 'YouTube',
      description: 'by Rick Astley',
      author: 'Rick Astley',
      type: 'video',
    });
  });

  it('cleans social captions but keeps the raw title for tagging', async () => {
    mockFetch((url) =>
      isNoembed(url)
        ? json({ title: 'Creamy pasta 🍝 #pasta #dinnerideas #fyp', author_name: 'chef', thumbnail_url: 'https://p16.tiktokcdn.com/a.jpg' })
        : json({ status: 'fail' }),
    );
    const p = await fetchPreview('https://www.tiktok.com/@chef/video/123');
    expect(p.title).toBe('Creamy pasta 🍝');
    expect(p.rawTitle).toBe('Creamy pasta 🍝 #pasta #dinnerideas #fyp');
    expect(p.image).toBe('https://p16.tiktokcdn.com/a.jpg');
  });

  it('uses microlink for other sites, with author, date and language', async () => {
    const fetch = mockFetch((url) => {
      if (isMicrolink(url)) {
        return json({
          status: 'success',
          data: {
            title: 'The best focaccia | BBC Good Food',
            description: '  Crisp,   airy focaccia. ',
            image: { url: 'https://images.example.com/focaccia.jpg' },
            publisher: 'BBC Good Food',
            url: 'https://www.bbcgoodfood.com/recipes/focaccia',
            author: 'Jane Doe',
            date: '2024-03-05T10:00:00.000Z',
            lang: 'en',
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const p = await fetchPreview('https://www.bbcgoodfood.com/recipes/focaccia');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/api\.microlink\.io\/\?url=/);
    expect(p).toEqual({
      title: 'The best focaccia',
      rawTitle: 'The best focaccia | BBC Good Food',
      description: 'Crisp, airy focaccia.',
      image: 'https://images.example.com/focaccia.jpg',
      siteName: 'BBC Good Food',
      finalUrl: 'https://www.bbcgoodfood.com/recipes/focaccia',
      author: 'Jane Doe',
      publishedAt: '2024-03-05T10:00:00.000Z',
      lang: 'en',
    });
  });

  it('falls back to microlink when noembed has no match or fails', async () => {
    const microlink = { status: 'success', data: { title: 'A Vimeo film', image: { url: 'https://i.vimeocdn.com/a.jpg' } } };
    const noMatch = mockFetch((url) => (isNoembed(url) ? json({ error: 'no matching providers found' }) : json(microlink)));
    expect((await fetchPreview('https://vimeo.com/123')).title).toBe('A Vimeo film');
    expect(noMatch).toHaveBeenCalledTimes(2);

    mockFetch((url) => {
      if (isNoembed(url)) throw new TypeError('Failed to fetch');
      return json(microlink);
    });
    expect(await fetchPreview('https://vimeo.com/123')).toEqual({
      title: 'A Vimeo film',
      rawTitle: 'A Vimeo film',
      image: 'https://i.vimeocdn.com/a.jpg',
    });
  });

  it('fills gaps from the second provider without mixing up titles', async () => {
    mockFetch((url) =>
      isNoembed(url)
        ? json({ title: 'Clean title', thumbnail_url: 'data:image/png;base64,AAAA', author_name: 'Someone' })
        : json({ status: 'success', data: { title: 'Other title | Vimeo', image: { url: 'https://i.vimeocdn.com/b.jpg' }, lang: 'fr' } }),
    );
    const p = await fetchPreview('https://vimeo.com/456');
    expect(p.title).toBe('Clean title');
    // The raw title always belongs to the title that was kept, never the other provider's.
    expect(p.rawTitle).toBe('Clean title');
    expect(p.image).toBe('https://i.vimeocdn.com/b.jpg');
    expect(p.author).toBe('Someone');
    expect(p.lang).toBe('fr');
  });

  it('drops unsafe image and redirect URLs', async () => {
    mockFetch(() =>
      json({
        status: 'success',
        data: { title: 'Page', image: { url: 'javascript:alert(1)' }, logo: { url: 'https://example.com/logo.png' }, url: 'javascript:alert(2)' },
      }),
    );
    const p = await fetchPreview('https://example.com/a');
    expect(p.image).toBe('https://example.com/logo.png');
    expect(p.finalUrl).toBeUndefined();

    mockFetch(() => json({ status: 'success', data: { title: 'Page', image: { url: 'data:image/svg+xml,<svg/>' }, logo: 'nope' } }));
    expect((await fetchPreview('https://example.com/b')).image).toBeUndefined();
  });

  it('ignores login walls, bad dates and odd languages', async () => {
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Just a moment...', date: 'yesterday-ish', lang: 'english please', type: 'Article' } }),
    );
    const p = await fetchPreview('https://example.com/c');
    expect(p).toEqual({ type: 'article' });
  });

  it('only accepts real ISO dates', async () => {
    const dateOf = async (date: unknown) => {
      mockFetch(() => json({ status: 'success', data: { title: 'Page', date } }));
      return (await fetchPreview('https://example.com/dated')).publishedAt;
    };
    // Date.parse would roll these over to 1 March / 1 May.
    expect(await dateOf('2024-02-30')).toBeUndefined();
    expect(await dateOf('2023-02-29')).toBeUndefined();
    expect(await dateOf('2024-04-31T10:00:00Z')).toBeUndefined();
    expect(await dateOf('2024-13-01')).toBeUndefined();
    expect(await dateOf('2024-01-01T24:00:00Z')).toBeUndefined();
    // Locale-dependent formats, junk and implausible years.
    expect(await dateOf('March 5, 2024')).toBeUndefined();
    expect(await dateOf('05/03/2024')).toBeUndefined();
    expect(await dateOf(1709632800000)).toBeUndefined();
    expect(await dateOf('1970-01-01T00:00:00Z')).toBeUndefined();
    // Real ones, including leap days and offsets without a colon.
    expect(await dateOf('2024-02-29')).toBe('2024-02-29T00:00:00.000Z');
    expect(await dateOf(' 2024-03-05T10:00:00.250Z ')).toBe('2024-03-05T10:00:00.250Z');
    expect(await dateOf('2024-03-05T10:00:00+0100')).toBe('2024-03-05T09:00:00.000Z');
    expect(await dateOf('2024-03-05T10:00+01:00')).toBe('2024-03-05T09:00:00.000Z');
    expect(await dateOf('2024-03-05 10:00:00-05')).toBe('2024-03-05T15:00:00.000Z');
  });

  it('never throws on HTTP errors or bad JSON', async () => {
    mockFetch(() => json({ oops: true }, 500));
    expect(await fetchPreview('https://example.com/d')).toEqual({});
    mockFetch(() => new Response('<html>not json</html>', { status: 200 }));
    expect(await fetchPreview('https://www.tiktok.com/@a/video/1')).toEqual({});
    mockFetch(() => json(null));
    expect(await fetchPreview('https://example.com/e')).toEqual({});
  });

  it('gives up on slow services after the timeout', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(hang);
    const pending = fetchPreview('https://vimeo.com/789');
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) expect(init?.signal?.aborted).toBe(true);
  });

  it('stops when the caller aborts', async () => {
    const ctrl = new AbortController();
    const fetch = mockFetch(hang);
    const pending = fetchPreview('https://vimeo.com/1', ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    await expect(pending).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);

    const early = mockFetch(() => json({}));
    const aborted = new AbortController();
    aborted.abort();
    expect(await fetchPreview('https://youtu.be/dQw4w9WgXcQ', aborted.signal)).toEqual({
      image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    });
    expect(early).not.toHaveBeenCalled();
  });

  it('only previews web links', async () => {
    const fetch = mockFetch(() => json({}));
    expect(await fetchPreview('geo:51.5,-0.12')).toEqual({});
    expect(await fetchPreview('javascript:alert(1)')).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});
