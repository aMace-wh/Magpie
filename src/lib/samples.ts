import { classify } from './classify';
import { buildItem, db } from './db';
import { uid } from './id';
import type { Collection, Item } from './types';

const DAY = 86400000;

const maps = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

/** A small, realistic starter library so the app isn't empty on first run. */
export async function addSampleData(): Promise<void> {
  const now = Date.now();
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

  const raw: { title: string; url?: string; text?: string; lat?: number; lng?: number; col?: Collection; done?: [number, string]; ago: number }[] = [
    { title: 'Pastéis de Belém', text: 'The original pastel de nata bakery', lat: 38.6975, lng: -9.2032, col: lisbon, done: [5, 'Worth the queue. Get them warm, with cinnamon and icing sugar.'], ago: 20 },
    { title: 'Time Out Market Lisboa', text: 'Food hall — try the prego sandwich', lat: 38.707, lng: -9.1459, col: lisbon, ago: 12 },
    { title: 'LX Factory', text: 'Sunday market, bookshop Ler Devagar', lat: 38.7033, lng: -9.1789, col: lisbon, ago: 11 },
    { title: 'Miradouro da Senhora do Monte', text: 'Best sunset viewpoint in Lisbon', lat: 38.7192, lng: -9.1327, col: lisbon, ago: 11 },
    { title: 'Dishoom Covent Garden', text: 'Bombay café — black daal + bacon naan roll for breakfast', lat: 51.5124, lng: -0.1269, ago: 30 },
    { title: 'Borough Market', text: 'Saturday food market', lat: 51.5055, lng: -0.091, ago: 45, done: [4, 'Great for lunch. Go early, it gets packed by noon.'] },
    { title: 'The Food Lab’s best chocolate chip cookies', url: 'https://www.seriouseats.com/the-food-lab-best-chocolate-chip-cookie-recipe', text: 'Brown the butter! #baking', ago: 9, done: [4, 'Chilled the dough overnight — worth it.'] },
    { title: 'Creamy one-pot lemon orzo', text: 'Quick weeknight recipe #pasta #quick', url: 'https://www.bbcgoodfood.com/search?q=lemon+orzo', ago: 3 },
    { title: '20-minute morning yoga flow', url: 'https://www.youtube.com/results?search_query=20+minute+morning+yoga', ago: 6 },
    { title: '30 min full body dumbbell workout', url: 'https://www.youtube.com/results?search_query=30+minute+full+body+dumbbell+workout', ago: 2 },
    { title: 'Project Hail Mary — Andy Weir', url: 'https://www.goodreads.com/search?q=project+hail+mary', ago: 15 },
    { title: 'Magpie', url: 'https://en.wikipedia.org/wiki/Magpie', text: 'Apparently they recognise themselves in mirrors', ago: 1 },
    { title: 'Gift ideas for Sam', text: 'Ceramics class voucher, the green Moleskine, film camera', ago: 4 },
  ];

  const items: Item[] = raw.map((r) => {
    const c = classify({ title: r.title, text: r.text, url: r.url ?? (r.lat !== undefined ? maps(r.lat, r.lng!) : undefined) });
    const created = now - r.ago * DAY;
    const item = buildItem(
      {
        ...c,
        type: r.lat !== undefined ? 'place' : c.type,
        title: r.title,
        note: r.text?.replace(/\s*#\w+/g, '').trim() || undefined,
        place: r.lat !== undefined ? { lat: r.lat, lng: r.lng! } : c.place,
        collectionIds: r.col ? [r.col.id] : [],
      },
      created,
    );
    if (r.done) {
      item.status = 'done';
      item.rating = r.done[0];
      item.review = r.done[1];
      item.doneAt = created + Math.round((r.ago * DAY) / 2);
    }
    return item;
  });

  await db.transaction('rw', db.items, db.collections, async () => {
    await db.collections.bulkAdd([lisbon, dinner, move]);
    await db.items.bulkAdd(items);
  });
}
