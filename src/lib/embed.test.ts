import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OriginalPreview, OriginalSnippet } from '../components/OriginalPreview';
import { SourceIcon, hasSourceIcon, sourceTint } from '../components/SourceIcon';
import {
  EMBED_SANDBOX,
  authorOf,
  embedFor,
  embedHeightFromMessage,
  originalTextOf,
  parseStartTime,
  resolvedTheme,
  shortUrl,
  snippetText,
  subscribeResolvedTheme,
  textParts,
  withAutoplay,
  type TextPart,
} from './embed';
import { getSettings, setSettings } from './settings';
import type { Item } from './types';

const src = (url: string, opts?: Parameters<typeof embedFor>[1]) => embedFor(url, opts)?.src;

describe('embedFor: YouTube', () => {
  const NC = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';

  it('handles every common URL shape', () => {
    expect(src('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(NC);
    expect(src('https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2')).toBe(NC);
    expect(src('https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share')).toBe(NC);
    expect(src('https://youtu.be/dQw4w9WgXcQ?si=abcdef')).toBe(NC);
    expect(src('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe(NC);
    expect(src('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(NC);
    expect(src('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(NC);
    expect(src('HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ')).toBe(NC);
  });

  it('describes the player', () => {
    const e = embedFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(e).toMatchObject({ provider: 'youtube', label: 'YouTube', kind: 'video', aspect: 16 / 9 });
    expect(e?.vertical).toBeFalsy();
    expect(e?.allow).toContain('encrypted-media');
    expect(e?.allow).toContain('fullscreen');
    expect(e?.poster).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  });

  it('marks Shorts as vertical', () => {
    const e = embedFor('https://www.youtube.com/shorts/abcDEF12345');
    expect(e?.src).toBe('https://www.youtube-nocookie.com/embed/abcDEF12345');
    expect(e?.vertical).toBe(true);
    expect(e?.aspect).toBe(9 / 16);
  });

  it('keeps the start time, in seconds', () => {
    expect(src('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe(`${NC}?start=42`);
    expect(src('https://youtu.be/dQw4w9WgXcQ?t=42s')).toBe(`${NC}?start=42`);
    expect(src('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s')).toBe(`${NC}?start=90`);
    expect(src('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s')).toBe(`${NC}?start=3723`);
    expect(src('https://www.youtube.com/embed/dQw4w9WgXcQ?start=15')).toBe(`${NC}?start=15`);
    expect(src('https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=2m')).toBe(`${NC}?start=120`);
    expect(src('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=nonsense')).toBe(NC);
  });

  it('treats YouTube Music as its own provider on the same player', () => {
    const e = embedFor('https://music.youtube.com/watch?v=dQw4w9WgXcQ&feature=share');
    expect(e).toMatchObject({ provider: 'youtube-music', label: 'YouTube Music', src: NC });
  });

  it('embeds playlists', () => {
    const PLAYLIST = 'https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';
    expect(src('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')).toBe(PLAYLIST);
    // "videoseries" is 11 characters, like a video id, but it's the playlist player.
    const series = embedFor('https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    expect(series?.src).toBe(PLAYLIST);
    expect(series?.poster).toBeUndefined();
    expect(embedFor('https://www.youtube.com/embed/videoseries')).toBeUndefined();
    expect(embedFor('https://www.youtube-nocookie.com/embed/videoseries?list=bad')).toBeUndefined();
    expect(embedFor('https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv')).toBeUndefined();
  });

  it('rejects malformed ids and pages that are not one video', () => {
    expect(embedFor('https://www.youtube.com/watch?v=short')).toBeUndefined();
    expect(embedFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload%3D')).toBeUndefined();
    expect(embedFor('https://youtu.be/dQw4w9WgXcQ<script>')).toBeUndefined();
    expect(embedFor('https://www.youtube.com/@chef')).toBeUndefined();
    expect(embedFor('https://www.youtube.com/results?search_query=pasta')).toBeUndefined();
    expect(embedFor('https://youtu.be/')).toBeUndefined();
  });
});

describe('embedFor: rejections', () => {
  it('refuses non-http(s) schemes', () => {
    expect(embedFor('javascript:alert(1)//https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(embedFor('ftp://youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('//www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('geo:51.5,-0.12')).toBeUndefined();
  });

  it('refuses lookalike hosts', () => {
    expect(embedFor('https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('https://evil-youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('https://notyoutu.be/dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('https://www.youtube.com@evil.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('https://evil.com/www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
    expect(embedFor('https://open.spotify.com.evil.io/track/4cOdK2wGLETKBW3PvgPWqT')).toBeUndefined();
    expect(embedFor('https://pinterest.evil.com/pin/1234567890/')).toBeUndefined();
    expect(embedFor('https://x.com.evil.com/user/status/1234567890123')).toBeUndefined();
  });

  it('returns undefined for empty or broken input', () => {
    expect(embedFor()).toBeUndefined();
    expect(embedFor('')).toBeUndefined();
    expect(embedFor('not a url')).toBeUndefined();
    expect(embedFor('https://')).toBeUndefined();
    expect(embedFor('https://example.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
  });

  it('tolerates a trailing dot on the host', () => {
    expect(src('https://youtu.be./dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });

  it('accepts http links but always embeds over https', () => {
    expect(src('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(src('http://vimeo.com/123456')?.startsWith('https://player.vimeo.com/')).toBe(true);
  });

  it('never produces a non-https src for any supported link', () => {
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/123456',
      'https://www.tiktok.com/@chef/video/7212345678901234567',
      'https://www.instagram.com/p/CxYz123AbC/',
      'https://x.com/user/status/1234567890123456789',
      'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT',
      'https://music.apple.com/us/album/abbey-road/1441164426',
      'https://soundcloud.com/artist/track-name',
      'https://www.reddit.com/r/Cooking/comments/abc123/my_pasta/',
      'https://www.pinterest.com/pin/123456789012345678/',
      'https://www.facebook.com/somepage/posts/pfbid0abcDEF123',
      'https://www.dailymotion.com/video/x8abcd1',
      'https://www.loom.com/share/0123456789abcdef0123456789abcdef',
    ];
    for (const u of urls) expect(embedFor(u)?.src, u).toMatch(/^https:\/\//);
  });
});

describe('embedFor: Vimeo', () => {
  it('uses the privacy-friendly player', () => {
    expect(src('https://vimeo.com/123456')).toBe('https://player.vimeo.com/video/123456?dnt=1');
    expect(src('https://player.vimeo.com/video/123456')).toBe('https://player.vimeo.com/video/123456?dnt=1');
    expect(src('https://vimeo.com/channels/staffpicks/987654321')).toBe('https://player.vimeo.com/video/987654321?dnt=1');
    expect(src('https://vimeo.com/groups/shortfilms/videos/987654321')).toBe('https://player.vimeo.com/video/987654321?dnt=1');
  });

  it('keeps unlisted hashes and start times', () => {
    expect(src('https://vimeo.com/123456/abcdef1234')).toBe('https://player.vimeo.com/video/123456?h=abcdef1234&dnt=1');
    expect(src('https://player.vimeo.com/video/123456?h=abcdef1234')).toBe('https://player.vimeo.com/video/123456?h=abcdef1234&dnt=1');
    expect(src('https://vimeo.com/123456#t=90s')).toBe('https://player.vimeo.com/video/123456?dnt=1#t=90s');
  });

  it('rejects pages that are not a video', () => {
    expect(embedFor('https://vimeo.com/user12345')).toBeUndefined();
    expect(embedFor('https://vimeo.com/showcase/12345')).toBeUndefined();
    expect(embedFor('https://vimeo.com/about')).toBeUndefined();
  });
});

describe('embedFor: TikTok', () => {
  it('embeds videos as vertical', () => {
    const e = embedFor('https://www.tiktok.com/@chef.cooks/video/7212345678901234567?is_from_webapp=1');
    expect(e).toMatchObject({ provider: 'tiktok', label: 'TikTok', vertical: true, aspect: 9 / 16 });
    expect(e?.src).toBe('https://www.tiktok.com/embed/v2/7212345678901234567');
    expect(src('https://m.tiktok.com/v/7212345678901234567.html')).toBe('https://www.tiktok.com/embed/v2/7212345678901234567');
  });

  it('can’t embed short links (no id) or malformed ids', () => {
    expect(embedFor('https://vm.tiktok.com/ZMabc123/')).toBeUndefined();
    expect(embedFor('https://vt.tiktok.com/ZSabc123/')).toBeUndefined();
    expect(embedFor('https://www.tiktok.com/t/ZTRabc123/')).toBeUndefined();
    expect(embedFor('https://www.tiktok.com/@chef/video/123')).toBeUndefined();
    expect(embedFor('https://www.tiktok.com/@chef')).toBeUndefined();
  });
});

describe('embedFor: Instagram', () => {
  const EMBED = 'https://www.instagram.com/p/CxYz123AbC/embed/captioned/';

  it('embeds posts, reels and IGTV with captions', () => {
    expect(src('https://www.instagram.com/p/CxYz123AbC/')).toBe(EMBED);
    expect(src('https://www.instagram.com/reel/CxYz123AbC/?igsh=abc')).toBe(EMBED);
    expect(src('https://instagram.com/reels/CxYz123AbC')).toBe(EMBED);
    expect(src('https://www.instagram.com/tv/CxYz123AbC/')).toBe(EMBED);
    expect(src('https://www.instagram.com/chef.cooks/p/CxYz123AbC/')).toBe(EMBED);
  });

  it('sizes posts for their captions and marks reels vertical', () => {
    const post = embedFor('https://www.instagram.com/p/CxYz123AbC/');
    expect(post?.kind).toBe('post');
    expect(post?.height).toBeGreaterThan(400);
    expect(post?.vertical).toBeFalsy();
    expect(embedFor('https://www.instagram.com/reel/CxYz123AbC/')?.vertical).toBe(true);
  });

  it('skips profiles, stories and audio pages', () => {
    expect(embedFor('https://www.instagram.com/chef.cooks/')).toBeUndefined();
    expect(embedFor('https://www.instagram.com/stories/chef/1234567890/')).toBeUndefined();
    expect(embedFor('https://www.instagram.com/reels/audio/1234567890/')).toBeUndefined();
    expect(embedFor('https://www.instagram.com/p/bad!code/')).toBeUndefined();
  });
});

describe('embedFor: X / Twitter', () => {
  const TWEET = 'https://platform.twitter.com/embed/Tweet.html?id=1234567890123456789&dnt=true';

  it('embeds posts from either domain', () => {
    expect(src('https://x.com/nasa/status/1234567890123456789')).toBe(TWEET);
    expect(src('https://twitter.com/nasa/status/1234567890123456789?s=20')).toBe(TWEET);
    expect(src('https://mobile.twitter.com/nasa/status/1234567890123456789/photo/1')).toBe(TWEET);
    expect(src('https://x.com/i/web/status/1234567890123456789')).toBe(TWEET);
    expect(embedFor('https://x.com/nasa/status/1234567890123456789')).toMatchObject({ provider: 'x', label: 'X', kind: 'post' });
  });

  it('follows the dark theme', () => {
    expect(src('https://x.com/nasa/status/1234567890123456789', { theme: 'dark' })).toBe(`${TWEET}&theme=dark`);
  });

  it('rejects profiles and junk ids', () => {
    expect(embedFor('https://x.com/nasa')).toBeUndefined();
    expect(embedFor('https://x.com/nasa/status/abc')).toBeUndefined();
    expect(embedFor('https://x.com/nasa/status/12345678901234567890123')).toBeUndefined();
  });
});

describe('embedFor: music', () => {
  it('embeds Spotify with the right player height', () => {
    const track = embedFor('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc');
    expect(track).toMatchObject({ provider: 'spotify', kind: 'audio', height: 152, src: 'https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT' });
    expect(embedFor('https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3')).toMatchObject({
      src: 'https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3',
      height: 352,
    });
    expect(embedFor('https://open.spotify.com/episode/0Q86acNRm6V9GYx55SXKwf')?.height).toBe(152);
    expect(embedFor('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')?.height).toBe(352);
    expect(src('https://open.spotify.com/show/2MAi0BvDc6GTFvKFPXnkCL')).toBe('https://open.spotify.com/embed/show/2MAi0BvDc6GTFvKFPXnkCL');
    expect(src('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF')).toBe('https://open.spotify.com/embed/artist/0OdUWJ0sBjDrqHygGUXeCF');
    expect(embedFor('https://open.spotify.com/track/tooShort')).toBeUndefined();
    expect(embedFor('https://open.spotify.com/user/someone')).toBeUndefined();
    expect(embedFor('https://spotify.link/abc123')).toBeUndefined();
  });

  it('embeds Apple Music, keeping the song id', () => {
    const song = embedFor('https://music.apple.com/gb/album/come-together/1441164426?i=1441164430');
    expect(song).toMatchObject({ provider: 'apple-music', label: 'Apple Music', kind: 'audio', height: 175 });
    expect(song?.src).toBe('https://embed.music.apple.com/gb/album/come-together/1441164426?i=1441164430');
    const album = embedFor('https://music.apple.com/us/album/abbey-road/1441164426?ls=1&app=music');
    expect(album?.src).toBe('https://embed.music.apple.com/us/album/abbey-road/1441164426');
    expect(album?.height).toBe(450);
    expect(src('https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb')).toBe(
      'https://embed.music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb',
    );
    expect(embedFor('https://music.apple.com/us/album/abbey-road/notanid')).toBeUndefined();
    expect(embedFor('https://music.apple.com/us/browse')).toBeUndefined();
  });

  it('embeds SoundCloud with the original link encoded in the url param', () => {
    const e = embedFor('https://soundcloud.com/some-artist/a-track_name?utm_source=clipboard');
    expect(e).toMatchObject({ provider: 'soundcloud', kind: 'audio', height: 166 });
    expect(e?.src).toBe('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fa-track_name');
    expect(src('https://soundcloud.com/some-artist/sets/summer-mix')).toBe(
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fsets%2Fsummer-mix',
    );
    expect(src('https://soundcloud.com/some-artist/private-one/s-AbCdE123')).toBe(
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fprivate-one%2Fs-AbCdE123',
    );
    expect(embedFor('https://soundcloud.com/some-artist')).toBeUndefined();
    expect(embedFor('https://soundcloud.com/discover/sets/charts-top')).toBeUndefined();
    expect(embedFor('https://soundcloud.com/some-artist/likes')).toBeUndefined();
  });
});

describe('embedFor: social posts', () => {
  it('embeds Reddit posts', () => {
    expect(src('https://www.reddit.com/r/Cooking/comments/abc123/my_first_pasta/')).toBe(
      'https://embed.reddit.com/r/Cooking/comments/abc123/?embed=true',
    );
    expect(src('https://old.reddit.com/r/Cooking/comments/abc123/')).toBe('https://embed.reddit.com/r/Cooking/comments/abc123/?embed=true');
    expect(src('https://www.reddit.com/r/Cooking/comments/abc123/x/', { theme: 'dark' })).toContain('&theme=dark');
    expect(embedFor('https://www.reddit.com/r/Cooking/')).toBeUndefined();
    expect(embedFor('https://redd.it/abc123')).toBeUndefined();
    expect(embedFor('https://www.reddit.com/r/Cooking/s/AbCdEf')).toBeUndefined();
  });

  it('embeds Pinterest pins on any country domain', () => {
    const PIN = 'https://assets.pinterest.com/ext/embed.html?id=123456789012345678';
    expect(src('https://www.pinterest.com/pin/123456789012345678/')).toBe(PIN);
    expect(src('https://uk.pinterest.com/pin/123456789012345678/')).toBe(PIN);
    expect(src('https://pinterest.co.uk/pin/123456789012345678')).toBe(PIN);
    expect(src('https://www.pinterest.com.au/pin/123456789012345678/')).toBe(PIN);
    expect(embedFor('https://pin.it/abc123')).toBeUndefined();
    expect(embedFor('https://www.pinterest.com/chef/dinner-ideas/')).toBeUndefined();
  });

  it('embeds Facebook posts and videos with the link encoded in href', () => {
    const post = embedFor('https://www.facebook.com/somepage/posts/pfbid0abcDEF123?__tn__=R');
    expect(post?.kind).toBe('post');
    expect(post?.src).toBe(
      'https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fsomepage%2Fposts%2Fpfbid0abcDEF123&show_text=true&width=350',
    );
    expect(src('https://m.facebook.com/permalink.php?story_fbid=pfbid02xyz&id=100064')).toBe(
      'https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fpermalink.php%3Fstory_fbid%3Dpfbid02xyz%26id%3D100064&show_text=true&width=350',
    );
    const vid = embedFor('https://www.facebook.com/somepage/videos/1234567890/');
    expect(vid?.kind).toBe('video');
    expect(vid?.src).toBe(
      'https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fsomepage%2Fvideos%2F1234567890&show_text=false',
    );
    expect(src('https://www.facebook.com/watch/?v=1234567890')).toContain('video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D1234567890');
    expect(embedFor('https://www.facebook.com/reel/1234567890')?.vertical).toBe(true);
    expect(embedFor('https://www.facebook.com/events/1234567890/')).toBeUndefined();
    expect(embedFor('https://www.facebook.com/share/p/AbCdEf/')).toBeUndefined();
    expect(embedFor('https://www.facebook.com/permalink.php?story_fbid=1&id=abc')).toBeUndefined();
  });

  it('asks Facebook for a post no wider than a phone-width card', () => {
    const post = embedFor('https://www.facebook.com/somepage/posts/pfbid0abcDEF123')!;
    const width = Number(new URL(post.src).searchParams.get('width'));
    expect(width).toBeGreaterThanOrEqual(350);
    expect(width).toBeLessThanOrEqual(360);
    expect(post.maxWidth).toBe(width);
  });

  it('embeds Threads posts', () => {
    expect(src('https://www.threads.net/@chef.cooks/post/C8abcDEF12x')).toBe('https://www.threads.com/@chef.cooks/post/C8abcDEF12x/embed/');
    expect(embedFor('https://www.threads.net/@chef.cooks')).toBeUndefined();
  });
});

describe('embedFor: other video hosts', () => {
  it('embeds Dailymotion', () => {
    expect(src('https://www.dailymotion.com/video/x8abcd1')).toBe('https://www.dailymotion.com/embed/video/x8abcd1');
    expect(src('https://www.dailymotion.com/video/x8abcd1_old-style-slug')).toBe('https://www.dailymotion.com/embed/video/x8abcd1');
    expect(src('https://dai.ly/x8abcd1?start=30')).toBe('https://www.dailymotion.com/embed/video/x8abcd1?start=30');
    expect(embedFor('https://www.dailymotion.com/video/notanid')).toBeUndefined();
  });

  it('embeds Loom', () => {
    expect(src('https://www.loom.com/share/0123456789abcdef0123456789abcdef')).toBe('https://www.loom.com/embed/0123456789abcdef0123456789abcdef');
    expect(src('https://www.loom.com/share/Quarterly-plan-0123456789abcdef0123456789abcdef?sid=1')).toBe(
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
    );
    expect(embedFor('https://www.loom.com/share/tooshort')).toBeUndefined();
  });

  it('embeds Twitch only when it knows the parent host', () => {
    expect(embedFor('https://clips.twitch.tv/FunnyClipSlug-abc123')).toBeUndefined();
    expect(embedFor('https://www.twitch.tv/videos/1234567890')).toBeUndefined();
    const opts = { parentHost: 'magpie.example' };
    expect(src('https://clips.twitch.tv/FunnyClipSlug-abc123', opts)).toBe(
      'https://clips.twitch.tv/embed?clip=FunnyClipSlug-abc123&parent=magpie.example&autoplay=false',
    );
    expect(src('https://www.twitch.tv/somestreamer/clip/FunnyClipSlug-abc123', opts)).toBe(
      'https://clips.twitch.tv/embed?clip=FunnyClipSlug-abc123&parent=magpie.example&autoplay=false',
    );
    expect(src('https://www.twitch.tv/videos/1234567890?t=1h2m3s', opts)).toBe(
      'https://player.twitch.tv/?video=v1234567890&parent=magpie.example&autoplay=false&time=1h2m3s',
    );
    expect(src('https://www.twitch.tv/SomeStreamer', opts)).toBe('https://player.twitch.tv/?channel=somestreamer&parent=magpie.example&autoplay=false');
    expect(embedFor('https://www.twitch.tv/directory', opts)).toBeUndefined();
    expect(embedFor('https://www.twitch.tv/videos/1234567890', { parentHost: 'evil.com&parent=x' })).toBeUndefined();
    expect(embedFor('https://www.twitch.tv/videos/1234567890', { parentHost: '' })).toBeUndefined();
  });

  it('doesn’t embed Google Maps (the app has its own map)', () => {
    expect(embedFor('https://www.google.com/maps/place/Dishoom/@51.5,-0.12,17z')).toBeUndefined();
    expect(embedFor('https://maps.app.goo.gl/abc123')).toBeUndefined();
  });
});

describe('parseStartTime', () => {
  it('reads the formats platforms use', () => {
    expect(parseStartTime('75')).toBe(75);
    expect(parseStartTime('75s')).toBe(75);
    expect(parseStartTime('2m')).toBe(120);
    expect(parseStartTime('1h')).toBe(3600);
    expect(parseStartTime('1:05')).toBe(65);
    expect(parseStartTime('1:02:03')).toBe(3723);
    expect(parseStartTime('0')).toBeUndefined();
    expect(parseStartTime('')).toBeUndefined();
    expect(parseStartTime('abc')).toBeUndefined();
    expect(parseStartTime(null)).toBeUndefined();
  });
});

describe('withAutoplay', () => {
  it('adds autoplay to video players only', () => {
    const yt = embedFor('https://youtu.be/dQw4w9WgXcQ?t=42')!;
    expect(withAutoplay(yt).src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42&autoplay=1');
    const vimeo = embedFor('https://vimeo.com/123456#t=90s')!;
    expect(withAutoplay(vimeo).src).toBe('https://player.vimeo.com/video/123456?dnt=1&autoplay=1#t=90s');
    const twitch = embedFor('https://www.twitch.tv/videos/1234567890', { parentHost: 'localhost' })!;
    expect(withAutoplay(twitch).src).toContain('autoplay=true');
    expect(withAutoplay(twitch).src).not.toContain('autoplay=false');
    const spotify = embedFor('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')!;
    expect(withAutoplay(spotify)).toBe(spotify);
    expect(yt.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42');
  });
});

describe('resolvedTheme / subscribeResolvedTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and watches the theme attribute on <html>', () => {
    const root = { dataset: {} as Record<string, string> };
    const seen: { target?: unknown; opts?: MutationObserverInit; fire?: () => void; disconnected: boolean } = { disconnected: false };
    class FakeObserver {
      constructor(cb: () => void) {
        seen.fire = cb;
      }
      observe(target: unknown, opts: MutationObserverInit) {
        seen.target = target;
        seen.opts = opts;
      }
      disconnect() {
        seen.disconnected = true;
      }
    }
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('MutationObserver', FakeObserver);

    expect(resolvedTheme()).toBeUndefined();
    root.dataset.resolvedTheme = 'dark';
    expect(resolvedTheme()).toBe('dark');
    root.dataset.resolvedTheme = 'sepia';
    expect(resolvedTheme()).toBeUndefined();

    const cb = vi.fn();
    const off = subscribeResolvedTheme(cb);
    expect(seen.target).toBe(root);
    expect(seen.opts).toMatchObject({ attributes: true, attributeFilter: ['data-resolved-theme'] });
    seen.fire?.();
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(seen.disconnected).toBe(true);
  });

  it('does nothing without a DOM', () => {
    expect(resolvedTheme()).toBeUndefined();
    const off = subscribeResolvedTheme(() => {});
    expect(typeof off).toBe('function');
    off();
  });
});

describe('embedHeightFromMessage', () => {
  it('reads resize messages from Instagram, X and Reddit', () => {
    expect(embedHeightFromMessage('instagram', JSON.stringify({ type: 'MEASURE', details: { height: 812.4 } }))).toBe(812);
    expect(embedHeightFromMessage('x', { 'twttr.embed': { method: 'twttr.private.resize', params: [{ height: 640, width: 550 }] } })).toBe(640);
    expect(embedHeightFromMessage('reddit', JSON.stringify({ type: 'resize.embed', data: 455 }))).toBe(455);
  });

  it('clamps and ignores anything else', () => {
    expect(embedHeightFromMessage('instagram', { type: 'MEASURE', details: { height: 999999 } })).toBe(2000);
    expect(embedHeightFromMessage('instagram', { type: 'MEASURE', details: { height: 5 } })).toBe(80);
    expect(embedHeightFromMessage('instagram', { type: 'MEASURE', details: { height: 'NaN' } })).toBeUndefined();
    expect(embedHeightFromMessage('instagram', { type: 'OTHER', details: { height: 500 } })).toBeUndefined();
    expect(embedHeightFromMessage('youtube', { type: 'MEASURE', details: { height: 500 } })).toBeUndefined();
    expect(embedHeightFromMessage('reddit', 'not json')).toBeUndefined();
    expect(embedHeightFromMessage('reddit', null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

const kinds = (parts: TextPart[]) => parts.map((p) => `${p.kind}:${p.text}`);

describe('textParts', () => {
  it('splits links, hashtags and mentions and keeps everything else verbatim', () => {
    const text = 'Best pasta 🍝 by @chef.cooks!\n#pasta #dinnerideas https://vm.tiktok.com/ZMabc123/.';
    const parts = textParts(text);
    expect(parts.map((p) => p.text).join('')).toBe(text);
    expect(kinds(parts)).toEqual([
      'text:Best pasta 🍝 by ',
      'mention:@chef.cooks',
      'text:!\n',
      'tag:#pasta',
      'text: ',
      'tag:#dinnerideas',
      'text: ',
      'url:https://vm.tiktok.com/ZMabc123/',
      'text:.',
    ]);
    const url = parts.find((p) => p.kind === 'url');
    expect(url && url.kind === 'url' && url.href).toBe('https://vm.tiktok.com/ZMabc123/');
    expect(url && url.kind === 'url' && url.display).toBe('vm.tiktok.com/ZMabc123/');
  });

  it('only links http(s) and never treats emails or #1 as tags/mentions', () => {
    const parts = textParts('javascript:alert(1) mail me@example.com, #1 spot, (see www.example.com/a_(b)) ok');
    expect(parts.filter((p) => p.kind !== 'text')).toEqual([
      { kind: 'url', text: 'www.example.com/a_(b)', href: 'https://www.example.com/a_(b)', display: 'example.com/a_(b)' },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('javascript:alert(1) mail me@example.com, #1 spot, (see www.example.com/a_(b)) ok');
  });

  it('keeps markup as plain text', () => {
    const parts = textParts('<img src=x onerror=alert(1)> #tag');
    expect(parts[0]).toEqual({ kind: 'text', text: '<img src=x onerror=alert(1)> ' });
    expect(textParts('')).toEqual([]);
    expect(textParts(undefined)).toEqual([]);
  });

  it('shortens long links for display', () => {
    expect(shortUrl('https://www.bbcgoodfood.com/recipes/collection/easy-pasta-recipes-for-weeknights')).toBe('bbcgoodfood.com/recipes/collection/…');
    expect(shortUrl('https://example.com/')).toBe('example.com');
    expect(shortUrl('https://example.com/caf%C3%A9')).toBe('example.com/café');
    // Direction overrides and zero-width characters can't disguise the link text.
    expect(shortUrl('https://example.com/%E2%80%AEgpj.exe%E2%80%8B')).toBe('example.com/gpj.exe');
  });

  it('trims trailing brackets only when unbalanced, even in long runs', () => {
    const parts = textParts(`(${'x'.repeat(10)} https://example.com/a${')'.repeat(3000)}`);
    const url = parts.find((p) => p.kind === 'url');
    expect(url?.text).toBe('https://example.com/a');
  });
});

describe('originalTextOf / authorOf / snippetText', () => {
  it('prefers the shared text, then a real description', () => {
    expect(originalTextOf({ sharedText: '  Tried this!\nhttps://x.com/a/status/123456  ', description: 'Meta' })).toBe('Tried this!\nhttps://x.com/a/status/123456');
    expect(originalTextOf({ sharedText: 'https://vm.tiktok.com/ZMabc123/', description: 'A lovely pasta.' })).toBe('A lovely pasta.');
    expect(originalTextOf({ description: 'by Rick Astley' })).toBeUndefined();
    expect(originalTextOf({})).toBeUndefined();
  });

  it('finds the author only in a "by …" description', () => {
    expect(authorOf({ description: 'by Joshua Weissman' })).toBe('Joshua Weissman');
    expect(authorOf({ description: 'By the sea, a lovely spot' })).toBeUndefined();
    expect(authorOf({ description: 'A description\nby someone' })).toBeUndefined();
    expect(authorOf({})).toBeUndefined();
  });

  it('makes a tidy card snippet without repeating the title', () => {
    const shared = 'Creamy garlic pasta\nReady in 15 minutes and so good 😍 #pasta #easyrecipes\nhttps://vm.tiktok.com/ZMabc123/';
    expect(snippetText(shared, 'Creamy garlic pasta')).toBe('Ready in 15 minutes and so good 😍');
    expect(snippetText('@chef Creamy garlic pasta! Worth it', 'Creamy garlic pasta')).toBe('Worth it');
    expect(snippetText('Creamy garlic pasta #pasta', 'Creamy garlic pasta')).toBeUndefined();
    expect(snippetText('Something else entirely', 'Creamy garlic pasta')).toBe('Something else entirely');
    expect(snippetText('https://example.com #tag')).toBeUndefined();
    expect(snippetText(undefined)).toBeUndefined();
    expect(snippetText('word '.repeat(100), undefined, 20)?.length).toBeLessThanOrEqual(20);
  });

  it('only cuts the title off at the end of a word', () => {
    expect(snippetText('Romeo and Juliet tickets', 'Rome')).toBe('Romeo and Juliet tickets');
    expect(snippetText('Bestseller books list', 'Best')).toBe('Bestseller books list');
    expect(snippetText('Best pasta everywhere in Rome', 'Best pasta ever')).toBe('Best pasta everywhere in Rome');
    expect(snippetText('@chef Best pasta everywhere', 'Best pasta ever')).toBe('@chef Best pasta everywhere');
    expect(snippetText('Rome: three days on foot', 'Rome')).toBe('three days on foot');
    expect(snippetText('Best pasta ever. Seriously', 'Best pasta ever')).toBe('Seriously');
    expect(snippetText('Best pasta ever2 remix', 'Best pasta ever')).toBe('Best pasta ever2 remix');
    expect(snippetText("Rome's best pizza", 'Rome')).toBe("Rome's best pizza");
    expect(snippetText('Rome’s best pizza', 'Rome')).toBe('Rome’s best pizza');
    expect(snippetText("Rome 'til dawn", 'Rome')).toBe("'til dawn");
  });

  it('still cuts titles in scripts written without spaces', () => {
    expect(snippetText('東京タワーの夜景がきれい', '東京タワー')).toBe('の夜景がきれい');
    expect(snippetText('上海美食推荐 超好吃', '上海美食')).toBe('推荐 超好吃');
  });
});

// ---------------------------------------------------------------------------
// Components, rendered to static markup (no DOM needed).

function item(patch: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    type: 'video',
    title: 'Creamy garlic pasta',
    tags: [],
    collectionIds: [],
    status: 'todo',
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  };
}

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe('OriginalPreview', () => {
  const previewsWas = getSettings().previews;
  afterEach(() => setSettings({ previews: previewsWas }));

  it('shows a tap-to-load preview first, not the iframe', () => {
    const out = html(createElement(OriginalPreview, { item: item({ url: 'https://youtu.be/dQw4w9WgXcQ', source: 'youtube' }) }));
    expect(out).toContain('Original');
    expect(out).toContain('Load video');
    expect(out).not.toContain('<iframe');
    expect(out).toContain('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(out).toMatch(/referrerpolicy="no-referrer"/i);
    expect(out).toContain('Open original');
  });

  it('doesn’t fetch the platform’s thumbnail when link previews are off', () => {
    setSettings({ previews: false });
    const yt = item({ url: 'https://youtu.be/dQw4w9WgXcQ', source: 'youtube' });
    const out = html(createElement(OriginalPreview, { item: yt }));
    expect(out).toContain('Load video');
    expect(out).not.toContain('ytimg.com');
    expect(out).not.toContain('<img');
    expect(out).toContain('is-bare');
    const music = html(createElement(OriginalPreview, { item: item({ url: 'https://music.youtube.com/watch?v=dQw4w9WgXcQ' }) }));
    expect(music).not.toContain('ytimg.com');
    // An image the item already has (e.g. from a friend's share) is still shown.
    const own = html(createElement(OriginalPreview, { item: { ...yt, image: 'https://example.com/thumb.jpg' } }));
    expect(own).toContain('src="https://example.com/thumb.jpg"');
    expect(own).not.toContain('ytimg.com');
  });

  it('renders the sandboxed iframe when open by default', () => {
    const out = html(createElement(OriginalPreview, { item: item({ url: 'https://youtu.be/dQw4w9WgXcQ' }), defaultOpen: true }));
    expect(out).toContain('<iframe');
    expect(out).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(out).toContain(`sandbox="${EMBED_SANDBOX}"`);
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('Hide');
    expect(out).not.toContain('autoplay=1');
  });

  it('styles X and Reddit posts with the theme the app is showing now', () => {
    const root = { dataset: { resolvedTheme: 'dark' } as Record<string, string> };
    vi.stubGlobal('document', { documentElement: root });
    try {
      const tweet = item({ url: 'https://x.com/nasa/status/1234567890123456789', source: 'x' });
      expect(html(createElement(OriginalPreview, { item: tweet, defaultOpen: true }))).toContain('theme=dark');
      root.dataset.resolvedTheme = 'light';
      expect(html(createElement(OriginalPreview, { item: tweet, defaultOpen: true }))).not.toContain('theme=dark');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders shared text safely as text with http(s) links only', () => {
    const out = html(
      createElement(OriginalPreview, {
        item: item({
          type: 'note',
          url: 'https://example.com/post',
          sharedText: '<script>alert(1)</script> javascript:alert(2) #tag @me https://example.com/a',
        }),
      }),
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).toContain('<span class="orig-tag">#tag</span>');
    expect(out).toContain('<span class="orig-mention">@me</span>');
  });

  it('shows the platform and author in the source line', () => {
    const out = html(createElement(OriginalPreview, { item: item({ url: 'https://example.com/r', description: 'by Nigella', siteName: 'Nigella Lawson' }) }));
    expect(out).toContain('Nigella Lawson');
    expect(out).toContain(' · ');
    expect(out).toContain('Nigella</span>');
    expect(out).not.toContain('<blockquote');
  });

  it('never links unsafe item urls', () => {
    const out = html(createElement(OriginalPreview, { item: item({ url: 'javascript:alert(1)', sharedText: 'Hello there' }) }));
    expect(out).toContain('Hello there');
    expect(out).not.toContain('href=');
  });

  it('renders nothing when there is nothing to show', () => {
    expect(html(createElement(OriginalPreview, { item: item() }))).toBe('');
    expect(html(createElement(OriginalPreview, { item: item({ type: 'note', sharedText: 'Buy milk', note: 'Buy milk' }) }))).toBe('');
  });
});

describe('OriginalSnippet', () => {
  it('shows the original text without the title, or nothing', () => {
    const shared = 'Creamy garlic pasta\nReady in 15 minutes #pasta\nhttps://vm.tiktok.com/ZMabc123/';
    expect(html(createElement(OriginalSnippet, { item: item({ sharedText: shared }) }))).toContain('Ready in 15 minutes');
    expect(html(createElement(OriginalSnippet, { item: item({ sharedText: 'Creamy garlic pasta' }) }))).toBe('');
    expect(html(createElement(OriginalSnippet, { item: item({ sharedText: 'a\nb\nc other words' }), lines: 1 }))).toContain('-webkit-line-clamp:1');
  });
});

describe('SourceIcon', () => {
  it('is decorative unless titled', () => {
    expect(html(createElement(SourceIcon, { source: 'youtube' }))).toContain('aria-hidden="true"');
    const titled = html(createElement(SourceIcon, { source: 'tiktok', title: 'TikTok' }));
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="TikTok"');
  });

  it('knows the main platforms and falls back to a link icon', () => {
    for (const s of ['youtube', 'tiktok', 'instagram', 'x', 'spotify', 'pinterest', 'reddit', 'facebook', 'vimeo', 'threads', 'bluesky', 'rednote', 'google-maps']) {
      expect(hasSourceIcon(s), s).toBe(true);
    }
    expect(hasSourceIcon('twitter')).toBe(true);
    expect(hasSourceIcon('something-else')).toBe(false);
    expect(hasSourceIcon('__proto__')).toBe(false);
    expect(sourceTint('youtube')).toBe('#ff0033');
    expect(html(createElement(SourceIcon, { source: 'unknown' }))).toContain('var(--surface-3)');
  });
});

describe('Instagram share links', () => {
  it('are not embedded: the share token is not the post code', () => {
    expect(embedFor('https://www.instagram.com/share/p/BAAbCdEfGh')).toBeUndefined();
    expect(embedFor('https://www.instagram.com/share/reel/BAAbCdEfGh')).toBeUndefined();
    expect(embedFor('https://www.instagram.com/share/BAAbCdEfGh')).toBeUndefined();
    expect(embedFor('https://www.instagram.com/p/DAbCdEfGhIj/?igsh=MWQ1')?.src).toBe('https://www.instagram.com/p/DAbCdEfGhIj/embed/captioned/');
  });
});
