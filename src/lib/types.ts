export type ItemType =
  | 'link'
  | 'video'
  | 'recipe'
  | 'place'
  | 'product'
  | 'article'
  | 'workout'
  | 'book'
  | 'music'
  | 'note';

export type Status = 'todo' | 'done';

export interface Place {
  lat: number;
  lng: number;
  address?: string;
}

export interface Item {
  id: string;
  type: ItemType;
  title: string;
  url?: string;
  /** The user's own notes. */
  note?: string;
  /** Description pulled from the link preview. */
  description?: string;
  image?: string;
  siteName?: string;
  /** Platform the save came from, e.g. "youtube", "tiktok". */
  source?: string;
  tags: string[];
  collectionIds: string[];
  status: Status;
  /** 1–5, set when the item is marked done. */
  rating?: number;
  /** Journal entry written when the item is marked done. */
  review?: string;
  doneAt?: number;
  place?: Place;
  createdAt: number;
  updatedAt: number;
}

export type StatusFilter = Status | 'any';

export interface SmartRules {
  tags: string[];
  match: 'any' | 'all';
  types: ItemType[];
  status: StatusFilter;
}

export interface Collection {
  id: string;
  name: string;
  emoji: string;
  color: string;
  kind: 'manual' | 'smart';
  rules?: SmartRules;
  createdAt: number;
  updatedAt: number;
}

export interface TypeInfo {
  label: string;
  plural: string;
  emoji: string;
  /** Wording for the "to do" and "done" states of this kind of save. */
  todo: string;
  done: string;
  doneAction: string;
}

export const TYPE_INFO: Record<ItemType, TypeInfo> = {
  link: { label: 'Link', plural: 'Links', emoji: '🔗', todo: 'To check out', done: 'Checked out', doneAction: 'Mark as done' },
  video: { label: 'Video', plural: 'Videos', emoji: '🎬', todo: 'To watch', done: 'Watched', doneAction: 'Mark as watched' },
  recipe: { label: 'Recipe', plural: 'Recipes', emoji: '🍳', todo: 'To cook', done: 'Cooked', doneAction: 'I cooked this' },
  place: { label: 'Place', plural: 'Places', emoji: '📍', todo: 'Want to go', done: 'Visited', doneAction: "I've been here" },
  product: { label: 'Product', plural: 'Products', emoji: '🛍️', todo: 'Wishlist', done: 'Bought', doneAction: 'I bought this' },
  article: { label: 'Article', plural: 'Articles', emoji: '📰', todo: 'To read', done: 'Read', doneAction: 'Mark as read' },
  workout: { label: 'Workout', plural: 'Workouts', emoji: '💪', todo: 'To try', done: 'Done', doneAction: 'I did this workout' },
  book: { label: 'Book', plural: 'Books', emoji: '📚', todo: 'To read', done: 'Read', doneAction: 'Mark as read' },
  music: { label: 'Music', plural: 'Music', emoji: '🎧', todo: 'To listen', done: 'Listened', doneAction: 'Mark as listened' },
  note: { label: 'Note', plural: 'Notes', emoji: '📝', todo: 'Open', done: 'Done', doneAction: 'Mark as done' },
};

export const ITEM_TYPES = Object.keys(TYPE_INFO) as ItemType[];

export const COLLECTION_COLORS = [
  '#6d5dfc',
  '#0ea5a4',
  '#f97316',
  '#e11d48',
  '#16a34a',
  '#0284c7',
  '#a855f7',
  '#ca8a04',
];
