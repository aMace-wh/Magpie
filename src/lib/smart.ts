import type { Collection, Item, SmartRules } from './types';

export const EMPTY_RULES: SmartRules = { tags: [], match: 'any', types: [], status: 'any' };

export function hasRules(rules: SmartRules | undefined): boolean {
  return !!rules && (rules.tags.length > 0 || rules.types.length > 0 || rules.status !== 'any');
}

/** Does an item satisfy a smart collection's rules? Empty rules match nothing. */
export function matchesRules(item: Item, rules: SmartRules): boolean {
  if (!hasRules(rules)) return false;
  if (rules.types.length && !rules.types.includes(item.type)) return false;
  if (rules.status !== 'any' && item.status !== rules.status) return false;
  if (rules.tags.length) {
    const has = (t: string) => item.tags.includes(t);
    if (rules.match === 'all' ? !rules.tags.every(has) : !rules.tags.some(has)) return false;
  }
  return true;
}

export function itemsInCollection(items: Item[], collection: Collection): Item[] {
  if (collection.kind === 'smart') return items.filter((i) => matchesRules(i, collection.rules ?? EMPTY_RULES));
  return items.filter((i) => i.collectionIds.includes(collection.id));
}

export function describeRules(rules: SmartRules): string {
  const parts: string[] = [];
  if (rules.tags.length) {
    const tags = rules.tags.map((t) => `#${t}`);
    parts.push(rules.tags.length === 1 ? tags[0] : `${rules.match === 'all' ? 'all of' : 'any of'} ${tags.join(', ')}`);
  }
  if (rules.types.length) parts.push(rules.types.join(' / '));
  if (rules.status !== 'any') parts.push(rules.status === 'done' ? 'done' : 'not done yet');
  return parts.join(' · ') || 'No rules yet';
}
