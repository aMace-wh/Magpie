import { afterEach, describe, expect, it, vi } from 'vitest';
import { badPreviewFields, fetchPreview, previewsLimitedUntil, resetPreviewLimit } from './metadata';

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

  it("says when the platform won't show a post publicly", async () => {
    const reel = 'https://www.instagram.com/reel/AbC123/';
    const logo = { url: 'https://static.cdninstagram.com/rsrc.php/v4/yG/r/logo.png' };
    // Its "isn't available" page, in English or Chinese, with or without the logo.
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Instagram', description: "Sorry, this page isn't available. The link you followed may be broken, or the page may have been removed.", logo, url: reel } }),
    );
    expect(await fetchPreview(reel)).toEqual({ problem: 'unavailable' });
    mockFetch(() => json({ status: 'success', data: { title: 'Page not found • Instagram', url: reel } }));
    expect(await fetchPreview(reel)).toEqual({ problem: 'unavailable' });
    mockFetch(() => json({ status: 'success', data: { title: 'Instagram', description: '抱歉，此頁面無法使用。', url: reel } }));
    expect(await fetchPreview(reel)).toEqual({ problem: 'unavailable' });
    // Sent to the account, the reel's audio, the home page or another post instead.
    for (const url of ['https://www.instagram.com/mei.eats/', 'https://www.instagram.com/reels/audio/123456/', 'https://www.instagram.com/', 'https://www.instagram.com/p/ZzZ999/']) {
      mockFetch(() =>
        json({
          status: 'success',
          data: { title: 'Mei Chan (@mei.eats) • Instagram photos and videos', description: '1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Mei Chan (@mei.eats)', image: { url: 'https://scontent.cdninstagram.com/v/pfp.jpg' }, url },
        }),
      );
      expect(await fetchPreview(reel)).toEqual({ problem: 'unavailable' });
    }
    // A sign-in page is a wall in the way, not a missing post.
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Instagram', description: 'Create an account or log in to Instagram - Share what you’re into with the people who get you.', url: 'https://www.instagram.com/accounts/login/?next=%2Freel%2FAbC123%2F' } }),
    );
    expect(await fetchPreview(reel)).toEqual({ problem: 'failed' });
    // A bare "Instagram" with only the platform's name for a description is nothing too.
    mockFetch(() => json({ status: 'success', data: { title: 'Instagram', description: 'Instagram', logo, url: reel } }));
    expect(await fetchPreview(reel)).toEqual({ problem: 'failed' });
  });

  it('keeps a post that comes back under its other path', async () => {
    mockFetch(() =>
      json({
        status: 'success',
        data: { title: 'Mei Chan (@mei.eats) • Instagram reel', description: '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Night market crawl”.', url: 'https://www.instagram.com/p/AbC123/' },
      }),
    );
    const p = await fetchPreview('https://www.instagram.com/reel/AbC123/');
    expect(p.problem).toBeUndefined();
    expect(p.title).toBe('Night market crawl');
  });

  it("spots the account's or audio's page even under the post's own link, or with no link at all", async () => {
    const reel = 'https://www.instagram.com/reel/AbC123/';
    const pages = [
      { title: 'Mei Chan (@mei.eats) • Instagram photos and videos', description: '12K Followers, 300 Following, 1,234 Posts - See Instagram photos and videos from Mei Chan (@mei.eats)' },
      { title: 'Mei Chan (@mei.eats) • Instagram 相片和影片', description: '1.2萬 位粉絲、300 人追蹤中、1,234 則貼文 - 查看 Mei Chan (@mei.eats) 的 Instagram 相片和影片' },
      { title: 'Mei Chan (@mei.eats) • Instagram photos and videos', description: '12K Followers, 300 Following, 1,234 Posts - Mei Chan (@mei.eats) on Instagram: "Eating my way around Taipei"' },
      { title: 'Original audio - mei.eats | Instagram', description: 'Watch 1,234 reels made with Original audio - mei.eats' },
      { title: 'Original audio - mei.eats | Instagram' },
    ];
    for (const page of pages) {
      for (const url of [reel, undefined]) {
        mockFetch(() => json({ status: 'success', data: { ...page, image: { url: 'https://scontent.cdninstagram.com/v/pfp.jpg' }, publisher: 'Instagram', url } }));
        expect(await fetchPreview(reel), `${page.description ?? page.title} at ${url}`).toEqual({ problem: 'unavailable' });
      }
    }
    // A caption that mentions followers is still a caption.
    mockFetch(() =>
      json({
        status: 'success',
        data: { title: 'Mei Chan (@mei.eats) • Instagram reel', description: '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Thanks for 10K followers! See Instagram photos and videos from our trip”.', url: reel },
      }),
    );
    expect((await fetchPreview(reel)).problem).toBeUndefined();
  });

  it('follows share links to their post, and still spots a share link that lands on an account', async () => {
    const post = (url: string) => ({
      status: 'success',
      data: { title: 'Mei Chan (@mei.eats) • Instagram reel', description: '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Night market crawl”.', url },
    });
    mockFetch(() => json(post('https://www.instagram.com/reel/DAbcdEFGhij/')));
    const reel = await fetchPreview('https://www.instagram.com/share/reel/BAxyz12345/');
    expect(reel.problem).toBeUndefined();
    expect(reel.finalUrl).toBe('https://www.instagram.com/reel/DAbcdEFGhij/');
    mockFetch(() => json(post('https://www.instagram.com/p/DAbcdEFGhij/')));
    expect((await fetchPreview('https://www.instagram.com/share/p/BAxyz12345/')).problem).toBeUndefined();
    mockFetch(() => json(post('https://www.instagram.com/mei.eats/')));
    expect((await fetchPreview('https://www.instagram.com/share/reel/BAxyz12345/')).problem).toBe('unavailable');
  });

  it("keeps Facebook posts that come back under another of their paths, and spots an account's page", async () => {
    const answer = (url: string) => () =>
      json({ status: 'success', data: { title: 'Night market crawl | Mei Chan', description: 'Night market crawl with friends', image: { url: 'https://scontent.xx.fbcdn.net/v/x.jpg' }, url } });
    for (const [from, to] of [
      ['https://www.facebook.com/mei/videos/123456/', 'https://www.facebook.com/video.php?v=123456'],
      ['https://www.facebook.com/watch/?v=123456', 'https://www.facebook.com/watch?v=123456'],
      ['https://www.facebook.com/mei/videos/123456/', 'https://www.facebook.com/watch/?v=123456'],
      ['https://www.facebook.com/photo/?fbid=123', 'https://www.facebook.com/photo.php?fbid=123'],
      ['https://www.facebook.com/reel/123456', 'https://www.facebook.com/mei/videos/123456/'],
      ['https://m.facebook.com/story.php?story_fbid=1&id=2', 'https://www.facebook.com/mei/posts/1'],
    ]) {
      mockFetch(answer(to));
      expect((await fetchPreview(from)).problem, `${from} → ${to}`).toBeUndefined();
    }
    for (const to of ['https://www.facebook.com/mei', 'https://www.facebook.com/profile.php?id=42', 'https://www.facebook.com/']) {
      mockFetch(answer(to));
      expect((await fetchPreview('https://www.facebook.com/mei/videos/123456/')).problem, to).toBe('unavailable');
    }
  });

  it('takes a caption that starts like an error page for a caption', async () => {
    const answers = [
      // A Facebook group post, title and all.
      { title: 'This video is unavailable in my country lol, anyone have a mirror?', description: 'This video is unavailable in my country lol, anyone have a mirror?', publisher: 'Facebook', url: 'https://www.facebook.com/groups/1/posts/2/' },
      // Under just the platform's name.
      { title: 'Facebook', description: 'Page not found. Found this café instead', publisher: 'Facebook', url: 'https://www.facebook.com/groups/1/posts/2/' },
    ];
    for (const data of answers) {
      mockFetch(() => json({ status: 'success', data }));
      const p = await fetchPreview('https://www.facebook.com/groups/1/posts/2/');
      expect(p.problem).toBeUndefined();
      expect(p.description).toBe(data.description);
    }
    mockFetch(() =>
      json({ status: 'success', data: { title: 'Page not found? Try this hidden café | TikTok', author: 'mei', image: { url: 'https://p16-sign.tiktokcdn.com/x.jpg' }, url: 'https://www.tiktok.com/@mei/video/7300000000000000000' } }),
    );
    expect((await fetchPreview('https://www.tiktok.com/@mei/video/7300000000000000000')).problem).toBeUndefined();
  });

  it('asks once more with the link as shared when the plain one is not public', async () => {
    const shared = 'https://www.instagram.com/reel/AbC123/?stkn=abc123';
    const sorry = json({ status: 'success', data: { title: 'Instagram', description: "Sorry, this page isn't available.", url: 'https://www.instagram.com/reel/AbC123/' } });
    const caption = '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Night market crawl”.';
    const fetch = mockFetch((url) =>
      decodeURIComponent(url).includes('stkn=abc123')
        ? json({ status: 'success', data: { title: 'Mei Chan (@mei.eats) • Instagram reel', description: caption, url: shared } })
        : sorry.clone(),
    );
    const p = await fetchPreview(shared);
    expect(p.problem).toBeUndefined();
    expect(p.title).toBe('Night market crawl');
    expect(fetch.mock.calls.map(([u]) => decodeURIComponent(String(u)))).toEqual([
      'https://api.microlink.io/?url=https://www.instagram.com/reel/AbC123/',
      `https://api.microlink.io/?url=${shared}`,
    ]);
    // Still not public, or out of requests the second time: it stays "unavailable". Only once, and never for a plain link.
    for (const second of [sorry, json({ status: 'fail', code: 'ERATE' }, 429)]) {
      const calls = mockFetch((url) => (decodeURIComponent(url).includes('stkn=') ? second.clone() : sorry.clone()));
      expect(await fetchPreview(shared)).toEqual({ problem: 'unavailable' });
      expect(calls).toHaveBeenCalledTimes(2);
      resetPreviewLimit();
    }
    const plain = mockFetch(() => sorry.clone());
    expect(await fetchPreview('https://www.instagram.com/reel/AbC123/')).toEqual({ problem: 'unavailable' });
    expect(plain).toHaveBeenCalledTimes(1);
    // A login wall isn't asked again: that's most Instagram answers, and the allowance is small.
    const wall = mockFetch(() => json({ status: 'success', data: { title: 'Instagram', description: 'Create an account or log in to Instagram', url: 'https://www.instagram.com/accounts/login/' } }));
    expect(await fetchPreview(shared)).toEqual({ problem: 'failed' });
    expect(wall).toHaveBeenCalledTimes(1);
  });

  it("never uses the platform's logo as a post's picture", async () => {
    const caption = '1,204 likes, 33 comments - mei.eats on September 12, 2026: “Night market crawl”.';
    mockFetch(() => json({ status: 'success', data: { title: 'Mei Chan (@mei.eats) • Instagram reel', description: caption, logo: { url: 'https://static.cdninstagram.com/rsrc.php/v4/logo.png' } } }));
    expect((await fetchPreview('https://www.instagram.com/reel/AbC123/')).image).toBeUndefined();
    mockFetch(() => json({ status: 'success', data: { title: 'Mei Chan (@mei.eats) • Instagram reel', description: caption, image: { url: 'https://static.xx.fbcdn.net/rsrc.php/v3/share.png' } } }));
    expect((await fetchPreview('https://www.instagram.com/reel/AbC123/')).image).toBeUndefined();
    // Other sites still fall back to their logo.
    mockFetch(() => json({ status: 'success', data: { title: 'Pasta night', logo: { url: 'https://example.com/logo.png' } } }));
    expect((await fetchPreview('https://example.com/pasta')).image).toBe('https://example.com/logo.png');
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

describe('badPreviewFields', () => {
  const reel = 'https://www.instagram.com/reel/AbC123/';
  const keys = (o: object | undefined) => (o ? Object.keys(o).sort() : o);

  it("clears what an error page and the platform's logo left on a post", () => {
    const fix = badPreviewFields({ url: reel, title: 'Instagram reel', image: 'https://static.cdninstagram.com/rsrc.php/v4/logo.png', description: "Sorry, this page isn't available.", siteName: 'Instagram' });
    expect(keys(fix)).toEqual(['description', 'image', 'siteName']);
    // The error page's title too, and the logo wherever it's served from.
    const notFound = badPreviewFields({ url: reel, title: 'Page not found', image: 'https://www.instagram.com/static/images/ico/favicon-200.png/ab6eff595bb1.png', siteName: 'Instagram' });
    expect(notFound).toEqual({ image: undefined, siteName: undefined, title: 'Instagram reel' });
    expect(keys(badPreviewFields({ url: 'https://www.facebook.com/mei/videos/123/', title: 'Facebook video', image: 'https://www.facebook.com/images/fb_icon_325x325.png' }))).toEqual(['image']);
  });

  it("clears an account's or audio's page, with the title and author it gave the post", () => {
    const profile = { url: reel, title: 'Reel by Mei Chan', author: 'Mei Chan', image: 'https://scontent.cdninstagram.com/v/pfp.jpg', description: '1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Mei Chan (@mei.eats)', siteName: 'Instagram' };
    expect(badPreviewFields(profile)).toEqual({ image: undefined, description: undefined, siteName: undefined, author: undefined, title: 'Instagram reel' });
    const zh = { ...profile, description: '1.2萬 位粉絲、300 人追蹤中、1,234 則貼文 - 查看 Mei Chan (@mei.eats) 的 Instagram 相片和影片' };
    expect(keys(badPreviewFields(zh))).toEqual(['author', 'description', 'image', 'siteName', 'title']);
    const audio = { url: reel, title: 'Original audio - mei.eats', image: 'https://scontent.cdninstagram.com/v/cover.jpg', description: 'Watch 1,234 reels made with Original audio - mei.eats', siteName: 'Instagram' };
    const fix = badPreviewFields(audio);
    expect(keys(fix)).toEqual(['description', 'image', 'siteName', 'title']);
    expect(fix?.title).toBe('Instagram reel');
    // The audio's page with nothing but its name.
    expect(keys(badPreviewFields({ url: reel, title: 'Original audio - mei.eats', image: 'https://scontent.cdninstagram.com/v/cover.jpg', siteName: 'Instagram' }))).toEqual(['image', 'siteName', 'title']);
    // A title the user typed stays.
    expect(keys(badPreviewFields({ ...audio, edited: ['title'] }))).toEqual(['description', 'image', 'siteName']);
    expect(keys(badPreviewFields({ ...profile, title: 'Mei’s ramen spot', edited: ['title'] }))).toEqual(['author', 'description', 'image', 'siteName']);
  });

  it('only drops a logo when the caption is fine, and leaves good saves and other sites alone', () => {
    const caption = { url: reel, title: 'Night market crawl', image: 'https://static.cdninstagram.com/rsrc.php/v4/logo.png', description: 'Night market crawl', siteName: 'Instagram' };
    expect(keys(badPreviewFields(caption))).toEqual(['image']);
    expect(badPreviewFields({ ...caption, image: 'https://scontent.cdninstagram.com/v/x.jpg' })).toBeUndefined();
    expect(badPreviewFields({ url: 'https://example.com/post/1', title: 'Gone', description: "Sorry, this page isn't available." })).toBeUndefined();
    // An account's page saved on purpose is what it is.
    expect(badPreviewFields({ url: 'https://www.instagram.com/mei.eats/', title: 'Mei Chan', description: '1,234 Followers - See Instagram photos and videos from Mei Chan' })).toBeUndefined();
  });

  it('keeps a caption that starts like an error page or mentions followers', () => {
    const good = { url: reel, image: 'https://scontent.cdninstagram.com/v/x.jpg', siteName: 'Instagram', author: 'Mei Chan' };
    for (const description of [
      'Page not found? Try this hidden café in Taipei #taipei',
      'This account is private, DM for collabs',
      'Content not available anywhere else: our secret menu',
      'This video is unavailable in my country lol, anyone have a mirror?',
      'Thanks for 10K followers! See Instagram photos and videos from our trip below',
    ]) {
      expect(badPreviewFields({ ...good, title: description.slice(0, 30), description }), description).toBeUndefined();
      // Even with no picture or author.
      expect(badPreviewFields({ url: reel, title: description.slice(0, 30), description }), description).toBeUndefined();
    }
  });
});
