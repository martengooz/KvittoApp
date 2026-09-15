/**
 * Shared plumbing for the receipts and purchases lists: filters that live in
 * the URL query string, and the "sort by X, ascending/descending" row every
 * filter panel ends with.
 *
 * The filter shapes themselves stay separate — `ReceiptFilter` and
 * `ItemFilter` (in `db/queries.ts`) share no fields beyond `sort`/`direction`
 * and a handful of ids, so only that overlap is generalised here rather than
 * forcing one shape on both screens.
 */

import { actionSheet } from '../components/dialog.js';
import { el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { router } from '../core/router.js';
import type { SortDirection } from '../db/queries.js';

export { listParam, numberParam } from './filter-params.js';

/** Replaces the current URL with `path` plus `filter` serialised as query params. */
export function syncFilterToUrl<F>(path: string, filter: F, toParams: (filter: F) => URLSearchParams): void {
  const query = toParams(filter).toString();
  router.navigate(query ? `${path}?${query}` : path, { replace: true });
}

/**
 * "Sort by X" (opens an action sheet) paired with the ascending/descending
 * toggle. Generic over the sort-key union so it fits both `ReceiptSortKey`
 * and `ItemSortKey`.
 */
export function renderSortRow<K extends string>(options: {
  sortKey: K;
  direction: SortDirection;
  labels: Record<K, string>;
  /** The direction button's `aria-label`; the two screens word it differently. */
  directionAriaLabel: (descending: boolean) => string;
  onSort: (key: K) => void;
  onToggleDirection: () => void;
  /** Extra class(es) on the row itself — lets a caller fold its own spacing in rather than add a wrapper. */
  rowClass?: string;
}): HTMLElement {
  const descending = options.direction === 'desc';

  return el(
    'div',
    { class: ['stack', 'stack--between', options.rowClass] },
    el(
      'button',
      {
        class: 'btn btn--sm btn--plain btn--flush-start',
        type: 'button',
        on: {
          click: async () => {
            const chosen = await actionSheet({
              title: 'Sortera efter',
              selected: options.sortKey,
              options: Object.entries<string>(options.labels).map(([value, label]) => ({
                value: value as K,
                label,
              })),
            });
            if (!chosen) return;
            options.onSort(chosen);
          },
        },
      },
      el('span', { text: `Sortera: ${options.labels[options.sortKey]}` }),
      icon('chevron-right', { size: 12, weight: 2.4, className: 'row__chevron' }),
    ),
    el(
      'button',
      {
        class: 'btn btn--sm btn--plain btn--flush-end',
        type: 'button',
        'aria-label': options.directionAriaLabel(descending),
        on: { click: options.onToggleDirection },
      },
      icon('arrow-up-arrow-down', { size: 16 }),
      el('span', { text: descending ? 'Fallande' : 'Stigande' }),
    ),
  );
}
