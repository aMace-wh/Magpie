import { describe, expect, it } from 'vitest';
import { buildItem } from './db';
import { shareCollection, shareItem, type SharedPayloadV2 } from './share';
import {
  acceptsLongText,
  acceptsText,
  buildShareUrl,
  composeShare,
  fileMessage,
  flag,
  placeLabel,
  shareMessage,
  SOCIAL_TARGETS,
  targetShareUrl,
  whenLabel,
  X_LIMIT,
  X_URL_LENGTH,
  xLength,
  type SocialTargetId,
} from './social';
import type { Collection } from './types';

const LINK = 'https://me.example/magpie/#/import/zAbC_123-xyz';
// Everything that breaks naive URL building.
const NASTY = 'Tom & Jerry? #1 + 50% "off" / 🍜\nline two';
const NOW = new Date(2026, 8, 30);

const collection: Collection = { id: 'c1', name: 'Weekend in Lisbon', emoji: '🇵🇹', color: '#0ea5a4', kind: 'manual', createdAt: 0, updatedAt: 0 };

const tarts = buildItem({
  title: 'Pastéis de Belém',
  type: 'place',
  url: 'https://pasteisdebelem.pt/',
  place: { lat: 38.69, lng: -9.2, name: 'Pastéis de Belém', city: 'Lisbon', country: 'Portugal', countryCode: 'PT' },
});
const gig = buildItem({ title: 'Fado night', type: 'event', when: { start: '2026-10-12T19:30' }, url: 'https://tickets.example/fado' });

const many = (n: number): SharedPayloadV2 =>
  shareCollection(
    collection,
    Array.from({ length: n }, (_, i) => buildItem({ title: `Save number ${i + 1}`, type: 'link' })),
  );

describe('share URLs', () => {
  const parts = { text: NASTY, url: LINK, title: 'Title & more #1' };

  it('covers the common apps', () => {
    expect(SOCIAL_TARGETS.map((t) => t.id)).toEqual(['whatsapp', 'telegram', 'messenger', 'facebook', 'x', 'email', 'sms', 'line', 'reddit', 'linkedin']);
    expect(SOCIAL_TARGETS.find((t) => t.id === 'messenger')?.mobileOnly).toBe(true);
    expect(SOCIAL_TARGETS.filter((t) => t.mobileOnly)).toHaveLength(1);
  });

  it('WhatsApp puts the message and link in text', () => {
    const u = new URL(buildShareUrl('whatsapp', parts));
    expect(`${u.origin}${u.pathname}`).toBe('https://wa.me/');
    expect(u.searchParams.get('text')).toBe(`${NASTY}\n${LINK}`);
    expect([...u.searchParams.keys()]).toEqual(['text']);
  });

  it("WhatsApp doesn't repeat a link that's already in the text", () => {
    const u = new URL(buildShareUrl('whatsapp', { text: `Look: ${LINK}`, url: LINK }));
    expect(u.searchParams.get('text')).toBe(`Look: ${LINK}`);
  });

  it('Telegram takes the link separately and drops it (and its label) from the text', () => {
    const u = new URL(buildShareUrl('telegram', { text: `🍮 Tarts\n\nAdd it to your Magpie: ${LINK}`, url: LINK }));
    expect(`${u.origin}${u.pathname}`).toBe('https://t.me/share/url');
    expect(u.searchParams.get('url')).toBe(LINK);
    expect(u.searchParams.get('text')).toBe('🍮 Tarts');
  });

  it('Messenger (app link), Facebook and LinkedIn only take the link', () => {
    expect(buildShareUrl('messenger', parts)).toBe(`fb-messenger://share/?link=${encodeURIComponent(LINK)}`);
    const fb = new URL(buildShareUrl('facebook', parts));
    expect(`${fb.origin}${fb.pathname}`).toBe('https://www.facebook.com/sharer/sharer.php');
    expect(fb.searchParams.get('u')).toBe(LINK);
    const li = new URL(buildShareUrl('linkedin', parts));
    expect(`${li.origin}${li.pathname}`).toBe('https://www.linkedin.com/sharing/share-offsite/');
    expect(li.searchParams.get('url')).toBe(LINK);
  });

  it('X gets text + url and stays within 280 (links count as 23)', () => {
    const u = new URL(buildShareUrl('x', parts));
    expect(`${u.origin}${u.pathname}`).toBe('https://x.com/intent/post');
    expect(u.searchParams.get('url')).toBe(LINK);
    expect(u.searchParams.get('text')).toBe(NASTY);

    const long = new URL(buildShareUrl('x', { text: 'word '.repeat(200), url: LINK })).searchParams.get('text')!;
    expect(xLength(long) + 1 + X_URL_LENGTH).toBeLessThanOrEqual(X_LIMIT);
    expect(long.endsWith('…')).toBe(true);

    const emoji = new URL(buildShareUrl('x', { text: '🍜'.repeat(200), url: LINK })).searchParams.get('text')!;
    expect(xLength(emoji) + 1 + X_URL_LENGTH).toBeLessThanOrEqual(X_LIMIT);
    expect(xLength('🍜')).toBe(2);
    expect(xLength('abc é')).toBe(5);

    const noUrl = new URL(buildShareUrl('x', { text: 'a'.repeat(400) })).searchParams;
    expect(noUrl.has('url')).toBe(false);
    expect(xLength(noUrl.get('text')!)).toBeLessThanOrEqual(X_LIMIT);
  });

  it('LINE, Reddit, Email and SMS', () => {
    const line = new URL(buildShareUrl('line', parts));
    expect(`${line.origin}${line.pathname}`).toBe('https://line.me/R/share');
    expect(line.searchParams.get('text')).toBe(`${NASTY}\n${LINK}`);

    const reddit = new URL(buildShareUrl('reddit', parts));
    expect(`${reddit.origin}${reddit.pathname}`).toBe('https://www.reddit.com/submit');
    expect(reddit.searchParams.get('url')).toBe(LINK);
    expect(reddit.searchParams.get('title')).toBe('Title & more #1');

    const mail = buildShareUrl('email', parts);
    expect(mail.startsWith('mailto:?subject=')).toBe(true);
    const [, query] = mail.split('?');
    const [subject, body] = query.split('&');
    expect(subject).toBe(`subject=${encodeURIComponent('Title & more #1')}`);
    expect(decodeURIComponent(body.replace(/^body=/, ''))).toBe(`${NASTY}\n${LINK}`);
    expect(mail).not.toContain(' ');
    expect(mail).not.toContain('+');

    const sms = buildShareUrl('sms', parts);
    expect(sms.startsWith('sms:?&body=')).toBe(true);
    expect(decodeURIComponent(sms.slice('sms:?&body='.length))).toBe(`${NASTY}\n${LINK}`);
  });

  it('never leaves a raw & # ? or newline in a query value', () => {
    for (const t of SOCIAL_TARGETS) {
      const url = buildShareUrl(t, parts);
      const query = url.slice(url.indexOf('?') + 1);
      expect(query, t.id).not.toMatch(/[#\s]/);
      for (const pair of query.split('&').filter(Boolean)) {
        expect(pair.split('=').length, `${t.id}: ${pair}`).toBe(2);
      }
    }
  });

  it('knows which targets take long text', () => {
    const long = (id: SocialTargetId) => acceptsLongText(id);
    expect((['whatsapp', 'telegram', 'email', 'line'] as const).every(long)).toBe(true);
    expect((['x', 'sms', 'reddit', 'facebook', 'messenger', 'linkedin'] as const).some(long)).toBe(false);
    expect(acceptsText('facebook')).toBe(false);
    expect(acceptsText('sms')).toBe(true);
  });
});

describe('shareMessage', () => {
  it('single save: title, original link, date / place, then the Magpie link', () => {
    const msg = shareMessage(shareItem(tarts), LINK, { locale: 'en-GB', now: NOW });
    expect(msg).toBe(`📍 Pastéis de Belém\nhttps://pasteisdebelem.pt/\n🇵🇹 Pastéis de Belém, Lisbon, Portugal\n\nAdd it to your Magpie: ${LINK}`);
    const event = shareMessage(shareItem(gig), LINK, { locale: 'en-GB', now: NOW });
    expect(event).toBe(`🎟️ Fado night\nhttps://tickets.example/fado\n📅 Mon 12 Oct, 19:30\n\nAdd it to your Magpie: ${LINK}`);
  });

  it("single save: leaves out links that aren't http(s)", () => {
    const evil = shareItem(buildItem({ title: 'Evil', type: 'link', url: 'javascript:alert(1)' }));
    expect(shareMessage(evil, LINK)).toBe(`🔗 Evil\n\nAdd it to your Magpie: ${LINK}`);
  });

  it('collections: count, first five titles and how many more', () => {
    const msg = shareMessage(many(8), LINK);
    expect(msg).toBe(
      [
        '🇵🇹 Weekend in Lisbon — 8 saves',
        '• Save number 1',
        '• Save number 2',
        '• Save number 3',
        '• Save number 4',
        '• Save number 5',
        '…and 3 more',
        '',
        `Open in Magpie: ${LINK}`,
      ].join('\n'),
    );
    expect(shareMessage(many(1), LINK)).toBe(`🇵🇹 Weekend in Lisbon — 1 save\n• Save number 1\n\nOpen in Magpie: ${LINK}`);
    expect(shareMessage(many(2))).toBe('🇵🇹 Weekend in Lisbon — 2 saves\n• Save number 1\n• Save number 2');
  });

  it('libraries use the sender name', () => {
    const lib: SharedPayloadV2 = { v: 2, kind: 'library', shareId: 'l:x', from: 'Sam', items: many(3).items };
    expect(shareMessage(lib).split('\n')[0]).toBe("📚 Sam's saves — 3 saves");
  });

  it('respects limits without ever cutting the link', () => {
    const p = many(40);
    for (const max of [400, 150, 90, 60]) {
      const msg = shareMessage(p, LINK, { maxLength: max });
      expect(Array.from(msg).length, `max ${max}`).toBeLessThanOrEqual(Math.max(max, LINK.length));
      expect(msg.endsWith(LINK)).toBe(true);
    }
    // Only room for the link.
    expect(shareMessage(p, LINK, { maxLength: LINK.length })).toBe(LINK);
    const short = shareMessage(p, LINK, { short: true });
    expect(short).toBe(`🇵🇹 Weekend in Lisbon — 40 saves\n\nOpen in Magpie: ${LINK}`);
  });

  it('fits Telegram (4096 for link + text) and keeps SMS short', () => {
    const huge = shareCollection(
      collection,
      Array.from({ length: 200 }, (_, i) => buildItem({ title: `${'Very long title '.repeat(10)}${i}`, type: 'link' })),
    );
    const bigLink = `${LINK}${'x'.repeat(1800)}`;
    const tg = composeShare('telegram', huge, bigLink);
    expect(tg.url).toBe(bigLink);
    expect(Array.from(tg.text!).length + 1 + bigLink.length).toBeLessThanOrEqual(4096);
    const tgUrl = new URL(targetShareUrl('telegram', huge, bigLink));
    expect(Array.from(tgUrl.searchParams.get('text') ?? '').length + 1 + bigLink.length).toBeLessThanOrEqual(4096);

    const sms = composeShare('sms', huge, LINK).text!;
    expect(sms).not.toContain('•');
    expect(sms.endsWith(LINK)).toBe(true);

    const wa = new URL(targetShareUrl('whatsapp', many(8), LINK)).searchParams.get('text')!;
    expect(wa).toContain('• Save number 5');
    expect(wa.match(new RegExp(LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);

    const x = new URL(targetShareUrl('x', many(8), LINK));
    expect(x.searchParams.get('text')).toBe('🇵🇹 Weekend in Lisbon — 8 saves');
    expect(x.searchParams.get('url')).toBe(LINK);
  });

  it('file message', () => {
    expect(fileMessage(many(12), 'https://me.example/magpie/')).toBe(
      "I'm sending you 🇵🇹 Weekend in Lisbon (12 saves) from my Magpie. To add them, open Magpie (https://me.example/magpie/) → Settings → " +
        "Add a friend's share → Open a share file, and pick the attached file. On Android you can also share the file straight to Magpie.",
    );
    expect(fileMessage(shareItem(gig))).toContain('“Fado night” from my Magpie. To add it, open Magpie → Settings');
    expect(fileMessage(shareItem(gig), 'javascript:alert(1)')).not.toContain('javascript');
  });
});

describe('labels', () => {
  it('flags', () => {
    expect(flag('PT')).toBe('🇵🇹');
    expect(flag('gb')).toBe('🇬🇧');
    expect(flag('P1')).toBe('');
    expect(flag('Portugal')).toBe('');
    expect(flag(undefined)).toBe('');
  });

  it('place labels skip repeats and fall back to the address', () => {
    expect(placeLabel({ lat: 0, lng: 0, name: 'Lisbon', city: 'lisbon', country: 'Portugal' })).toBe('Lisbon, Portugal');
    expect(placeLabel({ lat: 0, lng: 0, address: '84 Rua de Belém' })).toBe('84 Rua de Belém');
    expect(placeLabel({ lat: 0, lng: 0 })).toBeUndefined();
    expect(placeLabel(undefined)).toBeUndefined();
  });

  it('dates, times and ranges', () => {
    const o = { locale: 'en-GB', now: NOW } as const;
    expect(whenLabel({ start: '2026-10-12' }, o.locale, o.now)).toBe('Mon 12 Oct');
    expect(whenLabel({ start: '2026-10-12T19:30', end: '2026-10-12T22:00' }, o.locale, o.now)).toBe('Mon 12 Oct, 19:30 – 22:00');
    expect(whenLabel({ start: '2026-10-12', end: '2026-10-14' }, o.locale, o.now)).toBe('Mon 12 Oct – Wed 14 Oct');
    expect(whenLabel({ start: '2027-01-03' }, o.locale, o.now)).toContain('2027');
    expect(whenLabel({ start: 'soon' }, o.locale, o.now)).toBeUndefined();
    expect(whenLabel(undefined)).toBeUndefined();
  });
});
