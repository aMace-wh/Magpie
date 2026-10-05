import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPreview, previewsLimitedUntil, resetPreviewLimit } from './metadata';

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
  resetPreviewLimit();
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

  it('never throws on HTTP errors or bad JSON, and says nothing came back', async () => {
    mockFetch(() => json({ oops: true }, 500));
    expect(await fetchPreview('https://example.com/d')).toEqual({ problem: 'failed' });
    mockFetch(() => new Response('<html>not json</html>', { status: 200 }));
    expect(await fetchPreview('https://www.tiktok.com/@a/video/1')).toEqual({ problem: 'failed' });
    mockFetch(() => json(null));
    expect(await fetchPreview('https://example.com/e')).toEqual({ problem: 'failed' });
    mockFetch(() => json({ status: 'fail' }));
    expect(await fetchPreview('https://example.com/f')).toEqual({ problem: 'failed' });
  });

  it('gives up on slow services after the timeout', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(hang);
    const pending = fetchPreview('https://vimeo.com/789');
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toEqual({ problem: 'timeout' });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) expect(init?.signal?.aborted).toBe(true);
  });

  it('gives Instagram, Facebook and Threads longer', async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(hang);
    const pending = fetchPreview('https://www.instagram.com/reel/AbC123/');
    await vi.advanceTimersByTimeAsync(8000);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(7000);
    await expect(pending).resolves.toEqual({ problem: 'timeout' });
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('says when the daily allowance is used up', async () => {
    mockFetch(() => json({ status: 'fail', code: 'ERATE' }, 429));
    expect(await fetchPreview('https://www.instagram.com/p/AbC123/')).toEqual({ problem: 'limited' });
    resetPreviewLimit();
    mockFetch(() => json({ status: 'fail', code: 'ERATE' }));
    expect(await fetchPreview('https://example.com/g')).toEqual({ problem: 'limited' });
    resetPreviewLimit();
    // The most telling reason wins: one service slow, the other out of requests.
    vi.useFakeTimers();
    mockFetch((url, init) => (isNoembed(url) ? hang(url, init) : json({}, 429)));
    const pending = fetchPreview('https://vimeo.com/42');
    await vi.advanceTimersByTimeAsync(8000);
    await expect(pending).resolves.toEqual({ problem: 'limited' });
  });

  it('leaves microlink alone until tomorrow once its allowance is used up', async () => {
    const now = new Date(2026, 9, 5, 15, 0).getTime();
    vi.useFakeTimers({ now, toFake: ['Date'] });
    let fetch = mockFetch(() => json({ status: 'fail', code: 'ERATE' }, 429));
    expect(await fetchPreview('https://www.instagram.com/p/AbC123/')).toEqual({ problem: 'limited' });
    expect(previewsLimitedUntil()).toBe(new Date(2026, 9, 6).getTime());
    // Not asked again, but oEmbed services still are.
    fetch = mockFetch((url) => (isNoembed(url) ? json({ title: 'A Vimeo film' }) : json({ status: 'success', data: { title: 'A page' } })));
    expect(await fetchPreview('https://example.com/a')).toEqual({ problem: 'limited' });
    expect((await fetchPreview('https://vimeo.com/7')).title).toBe('A Vimeo film');
    expect(fetch.mock.calls.some(([u]) => isMicrolink(String(u)))).toBe(false);
    // Someone tapped "Refresh preview": asked anyway, and an answer lifts the pause.
    expect((await fetchPreview('https://example.com/a', undefined, { force: true })).title).toBe('A page');
    expect(previewsLimitedUntil()).toBe(0);
    // Late in the evening it still waits a few hours.
    vi.setSystemTime(new Date(2026, 9, 5, 23, 30));
    mockFetch(() => json({}, 429));
    await fetchPreview('https://example.com/b');
    expect(previewsLimitedUntil()).toBe(new Date(2026, 9, 6, 2, 30).getTime());
  });

  it('reports no problem once anything came back', async () => {
    mockFetch((url) => (isNoembed(url) ? json({}, 429) : json({ status: 'success', data: { title: 'A Vimeo film' } })));
    expect(await fetchPreview('https://vimeo.com/7')).toEqual({ title: 'A Vimeo film', rawTitle: 'A Vimeo film' });
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

  it('turns Instagram posts into their caption, author and date', async () => {
    const fetch = mockFetch(() =>
      json({
        status: 'success',
        data: {
          title: 'Mei Chan (@mei.eats) • Instagram reel',
          description: '1,234 likes, 56 comments - mei.eats on March 5, 2026: “Best dim sum in Mong Kok 🥟\n📍 Some Teahouse, Mong Kok\n#dimsum #hongkong”.',
          image: { url: 'https://scontent.cdninstagram.com/v/t51/abc.jpg?oe=6A000000' },
          publisher: 'Instagram',
          date: '2026-10-01T00:00:00.000Z',
        },
      }),
    );
    const p = await fetchPreview('https://www.instagram.com/reel/AbC123/?igsh=MWQ1ZGUxMzBkMA==&stkn=YWJjZGVmZ2hpams=&utm_source=ig_web_copy_link');
    // The services are asked about the link without per-share tokens.
    expect(String(fetch.mock.calls[0][0])).toBe(`https://api.microlink.io/?url=${encodeURIComponent('https://www.instagram.com/reel/AbC123/')}`);
    const caption = 'Best dim sum in Mong Kok 🥟\n📍 Some Teahouse, Mong Kok\n#dimsum #hongkong';
    expect(p).toEqual({
      title: 'Best dim sum in Mong Kok',
      rawTitle: 'Best dim sum in Mong Kok 🥟 📍 Some Teahouse, Mong Kok #dimsum #hongkong',
      description: caption,
      caption,
      image: 'https://scontent.cdninstagram.com/v/t51/abc.jpg?oe=6A000000',
      siteName: 'Instagram',
      author: 'Mei Chan',
      publishedAt: '2026-03-05T00:00:00.000Z',
      type: 'video',
    });
  });

  it("reads posts only on social sites: a news site's dated quote is just its description", async () => {
    for (const description of ['Published March 5, 2026: “We will fight on,” said the minister.', 'LONDON, March 5, 2026: "No deal tonight," the union said.']) {
      mockFetch(() => json({ status: 'success', data: { title: 'Talks go on', description, publisher: 'Example News', url: 'https://news.example.com/a' } }));
      const p = await fetchPreview('https://news.example.com/a');
      expect(p).toMatchObject({ title: 'Talks go on', description, siteName: 'Example News' });
      expect(p.author).toBeUndefined();
      expect(p.caption).toBeUndefined();
      expect(p.publishedAt).toBeUndefined();
    }
  });

  it('reads translated Instagram descriptions and names the handle when the title doesn’t', async () => {
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Instagram post', description: 'mei.eats 於 2026年10月3日:「【深水埗】三間必食小店 #美食」' } }),
    );
    expect(await fetchPreview('https://www.instagram.com/p/AbC123/')).toEqual({
      title: '【深水埗】三間必食小店',
      rawTitle: '【深水埗】三間必食小店 #美食',
      description: '【深水埗】三間必食小店 #美食',
      caption: '【深水埗】三間必食小店 #美食',
      author: '@mei.eats',
      publishedAt: '2026-10-03T00:00:00.000Z',
    });
  });

  it('titles a post without a caption after its author', async () => {
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Mei Chan (@mei.eats) • Instagram photo', description: '48K likes, 12K comments - mei.eats on June 2, 2026' } }),
    );
    expect(await fetchPreview('https://www.instagram.com/p/AbC123/?img_index=2')).toEqual({
      title: 'Photo by Mei Chan',
      rawTitle: 'Photo by Mei Chan',
      author: 'Mei Chan',
      publishedAt: '2026-06-02T00:00:00.000Z',
      type: 'photo',
    });
    // A profile keeps its name.
    mockFetch(() =>
      json({
        status: 'success',
        data: { title: 'Mei Chan (@mei.eats) • Instagram photos and videos', description: '1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Mei Chan (@mei.eats)' },
      }),
    );
    const profile = await fetchPreview('https://www.instagram.com/mei.eats/');
    expect(profile.title).toBe('Mei Chan');
    expect(profile.author).toBe('Mei Chan');
    expect(profile.caption).toBeUndefined();
  });

  it('treats login walls as nothing', async () => {
    mockFetch(() => json({ status: 'success', data: { title: 'Instagram', image: { url: 'https://static.cdninstagram.com/logo.png' } } }));
    expect(await fetchPreview('https://www.instagram.com/reel/AbC123/')).toEqual({ problem: 'failed' });
    mockFetch(() =>
      json({
        status: 'success',
        data: { title: 'Login • Instagram', description: 'Create an account or log in to Instagram - Share what you’re into with the people who get you.' },
      }),
    );
    expect(await fetchPreview('https://www.instagram.com/p/AbC123/')).toEqual({ problem: 'failed' });
    mockFetch(() => json({ status: 'success', data: { title: 'Instagram reel' } }));
    expect(await fetchPreview('https://www.instagram.com/reel/AbC123/')).toEqual({ problem: 'failed' });
  });

  it('reads Threads and Facebook posts', async () => {
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Mei Chan (@mei.eats) on Threads', description: 'Where are the best egg tarts in town?\nAsking for a friend' } }),
    );
    const threads = await fetchPreview('https://www.threads.com/@mei.eats/post/AbC123');
    expect(threads.title).toBe('Where are the best egg tarts in town?');
    expect(threads.caption).toBe('Where are the best egg tarts in town?\nAsking for a friend');
    expect(threads.author).toBe('Mei Chan');

    mockFetch(() =>
      json({ status: 'success', data: { title: '12K views · 345 reactions | Best noodles in Jordan 🍜 #food | By Mei Chan | Facebook', description: 'Best noodles in Jordan 🍜 #food' } }),
    );
    const fb = await fetchPreview('https://www.facebook.com/reel/123456789');
    expect(fb).toMatchObject({ title: 'Best noodles in Jordan', caption: 'Best noodles in Jordan 🍜 #food', author: 'Mei Chan', type: 'video' });
  });

  it('only previews web links', async () => {
    const fetch = mockFetch(() => json({}));
    expect(await fetchPreview('geo:51.5,-0.12')).toEqual({});
    expect(await fetchPreview('javascript:alert(1)')).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});
