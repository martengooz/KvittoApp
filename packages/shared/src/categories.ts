/**
 * Seed categories, tuned for Swedish grocery and household spending.
 *
 * Written on first launch and never re-applied, so users are free to rename or
 * delete them.
 */

import type { CategoryScope } from './types.js';

export interface CategorySeed {
  /** Stable slug, also used as the record id so seeding is idempotent. */
  slug: string;
  name: string;
  color: string;
  icon: string;
  scope: CategoryScope;
  /** Lowercase substrings that auto-assign this category to a line item. */
  match: string[];
}

export const DEFAULT_CATEGORIES: CategorySeed[] = [
  { slug: 'livsmedel', name: 'Livsmedel', color: '#3fa34d', icon: '🛒', scope: 'both',
    match: ['mat', 'livsmedel'] },
  { slug: 'frukt-gront', name: 'Frukt & grönt', color: '#6fbf3f', icon: '🥬', scope: 'item',
    match: ['banan', 'äpple', 'apelsin', 'tomat', 'gurka', 'sallad', 'potatis', 'lök', 'morot',
            'paprika', 'avokado', 'citron', 'vindruvor', 'melon', 'broccoli', 'champinjon'] },
  { slug: 'mejeri', name: 'Mejeri & ägg', color: '#f0c419', icon: '🥛', scope: 'item',
    match: ['mjölk', 'mellanmjölk', 'grädde', 'yoghurt', 'fil', 'smör', 'ost', 'ägg', 'kvarg',
            'creme fraiche', 'crème fraîche', 'margarin'] },
  { slug: 'brod', name: 'Bröd & bageri', color: '#c98a3c', icon: '🍞', scope: 'item',
    match: ['bröd', 'limpa', 'frallor', 'knäckebröd', 'bulle', 'kaka', 'tortilla', 'baguette'] },
  { slug: 'kott-fisk', name: 'Kött, chark & fisk', color: '#c0392b', icon: '🥩', scope: 'item',
    match: ['kyckling', 'köttfärs', 'fläsk', 'nöt', 'korv', 'bacon', 'skinka', 'lax', 'torsk',
            'räkor', 'fisk', 'falukorv', 'kassler'] },
  { slug: 'skafferi', name: 'Skafferi', color: '#8e7cc3', icon: '🥫', scope: 'item',
    match: ['pasta', 'ris', 'mjöl', 'socker', 'salt', 'olja', 'krossade tomater', 'bönor',
            'linser', 'müsli', 'flingor', 'havregryn', 'ketchup', 'senap', 'buljong'] },
  { slug: 'fryst', name: 'Fryst', color: '#5dade2', icon: '🧊', scope: 'item',
    match: ['fryst', 'glass', 'pizza', 'pommes'] },
  { slug: 'dryck', name: 'Dryck', color: '#2980b9', icon: '🥤', scope: 'item',
    match: ['läsk', 'juice', 'vatten', 'kaffe', 'te', 'saft', 'cola', 'öl', 'cider', 'energidryck'] },
  { slug: 'godis-snacks', name: 'Godis & snacks', color: '#e91e63', icon: '🍫', scope: 'item',
    match: ['godis', 'choklad', 'chips', 'nötter', 'lösgodis', 'kex'] },
  { slug: 'hushall', name: 'Hushåll & städ', color: '#16a085', icon: '🧻', scope: 'item',
    match: ['toapapper', 'hushållspapper', 'disk', 'tvättmedel', 'sopsäck', 'rengöring',
            'aluminiumfolie', 'plastpåsar'] },
  { slug: 'hygien', name: 'Hygien & apotek', color: '#af7ac5', icon: '🧴', scope: 'item',
    match: ['schampo', 'tvål', 'tandkräm', 'deodorant', 'blöjor', 'bindor', 'tandborste',
            'alvedon', 'plåster'] },
  { slug: 'pant', name: 'Pant', color: '#95a5a6', icon: '♻️', scope: 'item', match: ['pant'] },
  { slug: 'restaurang', name: 'Restaurang & café', color: '#e67e22', icon: '🍽️', scope: 'receipt',
    match: [] },
  { slug: 'transport', name: 'Transport & drivmedel', color: '#34495e', icon: '⛽', scope: 'receipt',
    match: ['bensin', 'diesel', 'drivmedel', 'biljett'] },
  { slug: 'hem', name: 'Hem & inredning', color: '#a0522d', icon: '🛋️', scope: 'receipt',
    match: [] },
  { slug: 'elektronik', name: 'Elektronik', color: '#7f8c8d', icon: '💻', scope: 'receipt',
    match: [] },
  { slug: 'klader', name: 'Kläder & skor', color: '#d35400', icon: '👕', scope: 'receipt',
    match: [] },
  { slug: 'fritid', name: 'Fritid & nöje', color: '#9b59b6', icon: '🎬', scope: 'receipt',
    match: [] },
  { slug: 'ovrigt', name: 'Övrigt', color: '#7f8c8d', icon: '📦', scope: 'both', match: [] },
];

/**
 * Best-effort category guess for a line item, by keyword. Returns the seed slug
 * or `null`. Only used to pre-fill; the user always has the last word.
 */
export function guessCategorySlug(searchName: string): string | null {
  if (!searchName) return null;
  let best: { slug: string; length: number } | null = null;
  for (const category of DEFAULT_CATEGORIES) {
    for (const keyword of category.match) {
      if (!searchName.includes(keyword)) continue;
      // Prefer the most specific keyword that matched.
      if (!best || keyword.length > best.length) {
        best = { slug: category.slug, length: keyword.length };
      }
    }
  }
  return best?.slug ?? null;
}
