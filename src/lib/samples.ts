import { classify, itemFieldsFrom, sharedTextOf } from './classify';
import { buildItem, db } from './db';
import { uid } from './id';
import type { Collection, Item, ItemType, Place, When } from './types';
import { addDaysIso, parseLocal, toLocalIso } from './when';

const DAY = 86400000;
const HOUR = 3600000;

const maps = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

const inCity = (city: string, country: string, countryCode: string) => (name: string, lat: number, lng: number): Place => ({
  lat,
  lng,
  name,
  city,
  country,
  countryCode,
});
const lisbonAt = inCity('Lisbon', 'Portugal', 'PT');
const londonAt = inCity('London', 'United Kingdom', 'GB');
const kyotoAt = inCity('Kyoto', 'Japan', 'JP');
const tokyoAt = inCity('Tokyo', 'Japan', 'JP');

interface Seed {
  title: string;
  /** Forced type; otherwise whatever the classifier says. */
  type?: ItemType;
  url?: string;
  /** The user's note (hashtags are dropped). */
  text?: string;
  /** The original post's caption, kept as the save's shared text. */
  caption?: string;
  place?: Place;
  when?: When;
  col?: Collection;
  done?: [rating: number, review: string];
  /** Saved this many days ago. */
  ago: number;
}

/** "Sat 10 Oct" */
const dayLabel = (iso: string) => parseLocal(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** A small, realistic starter library so the app isn't empty on first run. */
export async function addSampleData(): Promise<void> {
  const now = Date.now();
  const today = toLocalIso(new Date(now));
  const lisbon: Collection = { id: uid(), name: 'Weekend in Lisbon', emoji: '🇵🇹', color: '#f97316', kind: 'manual', createdAt: now, updatedAt: now };
  const dinner: Collection = {
    id: uid(),
    name: 'Dinner ideas',
    emoji: '🍝',
    color: '#e11d48',
    kind: 'smart',
    rules: { tags: [], match: 'any', types: ['recipe'], status: 'todo' },
    createdAt: now,
    updatedAt: now,
  };
  const move: Collection = {
    id: uid(),
    name: 'Move more',
    emoji: '🧘',
    color: '#0ea5a4',
    kind: 'smart',
    rules: { tags: [], match: 'any', types: ['workout'], status: 'any' },
    createdAt: now,
    updatedAt: now,
  };

  // Events, relative to today: one coming up, one on now, one already been to.
  const jazzDay = addDaysIso(today, 10);
  const jazz: When = { start: `${jazzDay}T21:30`, source: `${dayLabel(jazzDay)}, 21:30` };
  const exhibition: When = { start: addDaysIso(today, -5), end: addDaysIso(today, 20) };
  const concert: When = { start: `${addDaysIso(today, -25)}T19:00` };

  const seeds: Seed[] = [
    {
      title: 'Pastéis de Belém',
      text: 'The original pastel de nata bakery',
      place: lisbonAt('Pastéis de Belém', 38.6975, -9.2032),
      col: lisbon,
      done: [5, 'Worth the queue. Get them warm, with cinnamon and icing sugar.'],
      ago: 20,
    },
    { title: 'Time Out Market Lisboa', text: 'Food hall — try the prego sandwich', place: lisbonAt('Time Out Market Lisboa', 38.707, -9.1459), col: lisbon, ago: 12 },
    { title: 'LX Factory', text: 'Sunday market, bookshop Ler Devagar', place: lisbonAt('LX Factory', 38.7033, -9.1789), col: lisbon, ago: 11 },
    {
      title: 'Miradouro da Senhora do Monte',
      text: 'Best sunset viewpoint in Lisbon',
      place: lisbonAt('Miradouro da Senhora do Monte', 38.7192, -9.1327),
      col: lisbon,
      ago: 11,
    },
    {
      title: 'Jazz night at Hot Clube de Portugal',
      type: 'event',
      url: 'https://www.instagram.com/explore/tags/hotclubedeportugal/',
      caption: `Live jazz in a tiny basement club that's been going since 1948 🎷 ${dayLabel(jazzDay)}, 21:30 — get there early, it's standing room only\n📍 Hot Clube de Portugal, Lisbon\n#lisbon #jazz #livemusic`,
      place: lisbonAt('Hot Clube de Portugal', 38.7189, -9.1446),
      when: jazz,
      col: lisbon,
      ago: 2,
    },
    {
      title: 'Dishoom Covent Garden',
      text: 'Bombay café — black daal + bacon naan roll for breakfast',
      place: londonAt('Dishoom Covent Garden', 51.5124, -0.1269),
      ago: 30,
    },
    {
      title: 'Borough Market',
      text: 'Saturday food market',
      place: londonAt('Borough Market', 51.5055, -0.091),
      ago: 45,
      done: [4, 'Great for lunch. Go early, it gets packed by noon.'],
    },
    {
      title: 'Photography exhibition at Tate Modern',
      type: 'event',
      url: 'https://www.tate.org.uk/visit/tate-modern',
      text: 'Book a timed ticket — Friday lates are quieter',
      place: londonAt('Tate Modern', 51.5076, -0.0994),
      when: exhibition,
      ago: 8,
    },
    {
      title: 'Vivaldi’s Four Seasons by candlelight',
      type: 'event',
      text: 'St Martin-in-the-Fields, Trafalgar Square',
      place: londonAt('St Martin-in-the-Fields', 51.5089, -0.1266),
      when: concert,
      done: [5, 'Goosebumps in Winter. Sit near the front — the candles make it.'],
      ago: 40,
    },
    {
      title: 'Fushimi Inari Taisha',
      url: 'https://www.instagram.com/explore/tags/fushimiinari/',
      caption:
        'Go at 7am and you’ll have the gates almost to yourself ⛩️ about 2h up to the summit and back, bring water!\n📍 Fushimi Inari Taisha, Kyoto\n#kyoto #japan #fushimiinari #japantravel',
      place: kyotoAt('Fushimi Inari Taisha', 34.9671, 135.7727),
      ago: 7,
    },
    {
      title: 'Tsukiji Outer Market',
      text: 'Tamagoyaki on a stick and fresh tuna — go before 10am, lots of stalls close by 2pm',
      place: tokyoAt('Tsukiji Outer Market', 35.6655, 139.7707),
      ago: 7,
    },
    { title: 'The Food Lab’s best chocolate chip cookies', url: 'https://www.seriouseats.com/the-food-lab-best-chocolate-chip-cookie-recipe', text: 'Brown the butter! #baking', ago: 9, done: [4, 'Chilled the dough overnight — worth it.'] },
    {
      title: 'Creamy one-pot lemon orzo',
      type: 'recipe',
      url: 'https://www.tiktok.com/tag/lemonorzo',
      text: 'Quick weeknight dinner',
      caption: 'Creamy one-pot lemon orzo 🍋 20 minutes, one pan, zero stress. Save this for a cosy weeknight! #pasta #orzo #quickrecipes #dinnerideas #fyp',
      ago: 3,
    },
    { title: '20-minute morning yoga flow', url: 'https://www.youtube.com/results?search_query=20+minute+morning+yoga', ago: 6 },
    { title: '30 min full body dumbbell workout', url: 'https://www.youtube.com/results?search_query=30+minute+full+body+dumbbell+workout', ago: 2 },
    { title: 'Project Hail Mary — Andy Weir', url: 'https://www.goodreads.com/search?q=project+hail+mary', ago: 15 },
    { title: 'Magpie', url: 'https://en.wikipedia.org/wiki/Magpie', text: 'Apparently they recognise themselves in mirrors', ago: 1 },
    { title: 'Gift ideas for Sam', text: 'Ceramics class voucher, the green Moleskine, film camera', ago: 4 },
  ];

  const items: Item[] = seeds.map((s) => {
    const url = s.url ?? (s.place ? maps(s.place.lat, s.place.lng) : undefined);
    const c = classify({ title: s.title, text: s.caption ?? s.text, url });
    const created = now - s.ago * DAY;
    const item = buildItem(
      {
        ...itemFieldsFrom(c),
        type: s.type ?? (s.place ? 'place' : c.type),
        title: s.title,
        note: s.text?.replace(/\s*#\w+/g, '').trim() || undefined,
        place: s.place ?? c.place,
        collectionIds: s.col ? [s.col.id] : [],
      },
      created,
    );
    // Only real captions count as "the original post"; the rest were typed.
    if (s.caption) item.sharedText = sharedTextOf({ text: s.caption, url });
    else delete item.sharedText;
    if (!item.place) delete item.place;
    if (s.when) item.when = s.when;
    if (s.done) {
      item.status = 'done';
      item.rating = s.done[0];
      item.review = s.done[1];
      item.doneAt = s.when ? parseLocal(s.when.start).getTime() + 3 * HOUR : created + Math.round((s.ago * DAY) / 2);
    }
    return item;
  });

  await db.transaction('rw', db.items, db.collections, async () => {
    await db.collections.bulkAdd([lisbon, dinner, move]);
    await db.items.bulkAdd(items);
  });
}
