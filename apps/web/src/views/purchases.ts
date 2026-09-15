/**
 * Every line item ever scanned, in one sortable and filterable list.
 *
 * This is the view that makes the archive useful: "what do I actually pay for
 * milk", "how much went on sweets last month", "where did I buy that". Filters
 * live in the URL, same as the receipts list.
 */

import {
  formatAmount,
  formatDate,
  formatMoney,
  formatQuantity,
  formatUnit,
  type Category,
  type Tag,
} from '@kvitto/shared';

import { actionSheet } from '../components/dialog.js';
import { actionRow, chip as chipControl, emptyState, searchField } from '../components/ui.js';
import { debounce, el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { liveView } from '../core/live-view.js';
import { router } from '../core/router.js';
import type { RouteContext } from '../core/router.js';
import { getSettings } from '../core/settings.js';
import {
  categoriesById,
  knownMerchants,
  searchPurchases,
  tagsById,
  type ItemFilter,
  type ItemSortKey,
  type PurchaseRow,
} from '../db/queries.js';

const SORT_LABELS: Record<ItemSortKey, string> = {
  date: 'Datum',
  name: 'Namn',
  price: 'Pris',
  unitPrice: 'Jämförpris',
  quantity: 'Antal',
  merchant: 'Butik',
};

/** Rows rendered before the "show more" button appears. */
const PAGE_SIZE = 150;

interface PurchasesData {
  rows: PurchaseRow[];
  categories: Map<string, Category>;
  tags: Map<string, Tag>;
  merchants: string[];
}

export function purchasesView(context: RouteContext): Promise<HTMLElement> {
  const filter = filterFromParams(context.params);
  filter.includeDiscounts ??= getSettings().ui.showAuxiliaryLines;
  filter.includeDeposits ??= getSettings().ui.showAuxiliaryLines;

  // "Show more" paging, like the filter panel elsewhere, is UI state that must
  // survive a `data:changed` refresh rather than reset the list to one page.
  let limit = PAGE_SIZE;
  let refreshView: () => Promise<void> = async () => {};

  function updateUrl(): void {
    const query = paramsFromFilter(filter).toString();
    router.navigate(query ? `/purchases?${query}` : '/purchases', { replace: true });
  }

  function onFilterChange(): void {
    limit = PAGE_SIZE;
    updateUrl();
    void refreshView();
  }

  const applySearch = debounce((value: string) => {
    filter.query = value || undefined;
    onFilterChange();
  }, 220);

  return liveView<PurchasesData>({
    // Merchants, categories and tags are reloaded on every pass — not cached
    // once outside it — so a tag or category created elsewhere shows up in
    // these filters immediately instead of only after leaving and returning.
    load: async () => {
      const [rows, categories, tags, merchants] = await Promise.all([
        searchPurchases(filter),
        categoriesById(),
        tagsById(),
        knownMerchants(),
      ]);
      return { rows, categories, tags, merchants };
    },
    render: ({ rows, categories, tags, merchants }, refresh) => {
      refreshView = refresh;

      return [
        renderFilters({ filter, categories, tags, merchants, onSearch: applySearch, onChange: onFilterChange }),
        renderPurchaseHero(rows, filter.query),
        el(
          'div',
          { class: 'purchase-list' },
          renderRows(rows, categories, limit, () => {
            limit += PAGE_SIZE;
            void refreshView();
          }),
        ),
      ];
    },
  });
}

function renderFilters(options: {
  filter: ItemFilter;
  categories: Map<string, Category>;
  tags: Map<string, Tag>;
  merchants: string[];
  onSearch: (value: string) => void;
  onChange: () => void;
}): HTMLElement {
  const { filter, categories, tags, merchants, onSearch, onChange } = options;

  return el(
    'div',
    { class: 'purchase-filters' },
    searchField({
      value: filter.query ?? '',
      placeholder: 'Sök vara, t.ex. mjölk',
      label: 'Sök bland köpta varor',
      onInput: onSearch,
    }),
    el(
      'div',
      { class: 'stack stack--between pad' },
      el(
        'button',
        {
          class: 'btn btn--sm btn--plain btn--flush-start',
          type: 'button',
          on: {
            click: async () => {
              const chosen = await actionSheet({
                title: 'Sortera efter',
                selected: (filter.sort ?? 'date') as ItemSortKey,
                options: Object.entries(SORT_LABELS).map(([value, label]) => ({
                  value: value as ItemSortKey,
                  label,
                })),
              });
              if (!chosen) return;
              filter.sort = chosen;
              onChange();
            },
          },
        },
        el('span', { text: `Sortera: ${SORT_LABELS[(filter.sort ?? 'date') as ItemSortKey]}` }),
        icon('chevron-right', { size: 12, weight: 2.4, className: 'row__chevron' }),
      ),
      el(
        'button',
        {
          class: 'btn btn--sm btn--plain btn--flush-end',
          type: 'button',
          'aria-label': 'Byt sorteringsordning',
          on: {
            click: () => {
              filter.direction = (filter.direction ?? 'desc') === 'desc' ? 'asc' : 'desc';
              onChange();
            },
          },
        },
        icon('arrow-up-arrow-down', { size: 16 }),
        el('span', { text: (filter.direction ?? 'desc') === 'desc' ? 'Fallande' : 'Stigande' }),
      ),
    ),
    el(
      'div',
      { class: 'stack pad' },
      el('input', {
        type: 'date',
        value: filter.from ?? '',
        'aria-label': 'Från datum',
        on: {
          change: (event) => {
            filter.from = (event.target as HTMLInputElement).value || undefined;
            onChange();
          },
        },
      }),
      el('input', {
        type: 'date',
        value: filter.to ?? '',
        'aria-label': 'Till datum',
        on: {
          change: (event) => {
            filter.to = (event.target as HTMLInputElement).value || undefined;
            onChange();
          },
        },
      }),
    ),
    renderChipRow('Kategori', [...categories.values()], filter.categoryIds ?? [], (ids) => {
      filter.categoryIds = ids.length ? ids : undefined;
      onChange();
    }),
    renderChipRow('Etikett', [...tags.values()], filter.tagIds ?? [], (ids) => {
      filter.tagIds = ids.length ? ids : undefined;
      onChange();
    }),
    merchants.length > 1
      ? renderChipRow(
          'Butik',
          merchants.map((name) => ({ id: name, name, color: 'var(--text-faint)' })),
          filter.merchants ?? [],
          (ids) => {
            filter.merchants = ids.length ? ids : undefined;
            onChange();
          },
        )
      : null,
    el(
      'div',
      { class: 'chip-row' },
      chipControl({
        label: 'Rabattrader',
        pressed: filter.includeDiscounts ?? false,
        onToggle: () => {
          filter.includeDiscounts = !filter.includeDiscounts;
          onChange();
        },
      }),
      chipControl({
        label: 'Pant',
        pressed: filter.includeDeposits ?? false,
        onToggle: () => {
          filter.includeDeposits = !filter.includeDeposits;
          onChange();
        },
      }),
    ),
  );
}

function renderPurchaseHero(rows: PurchaseRow[], query?: string): HTMLElement | null {
  if (rows.length === 0) return null;
  const queryMatches = query
    ? rows.filter((row) => row.item.searchName.includes(query.toLocaleLowerCase('sv-SE')))
    : rows;
  const lead = queryMatches[0] ?? rows[0]!;
  const source = rows.filter((row) => row.item.searchName === lead.item.searchName);
  const chronological = [...source].sort((a, b) =>
    (a.purchasedAt ?? '').localeCompare(b.purchasedAt ?? ''),
  );
  const prices = chronological
    .map((row) => row.item.unitPrice ?? row.item.totalPrice / Math.max(row.item.quantity, 1))
    .filter(Number.isFinite);
  const average = prices.reduce((sum, price) => sum + price, 0) / Math.max(prices.length, 1);
  const first = prices[0] ?? average;
  const last = prices.at(-1) ?? average;
  const change = first === 0 ? 0 : Math.round(((last - first) / first) * 100);
  const samples = prices.slice(-9);
  const max = Math.max(...samples, 1);
  const item = lead.item;
  const firstDate = chronological[0]?.purchasedAt;
  const lastDate = chronological.at(-1)?.purchasedAt;

  return el(
    'section',
    { class: 'purchase-hero' },
    el(
      'div',
      { class: 'purchase-hero__heading' },
      el('h2', { class: 'truncate', text: item.name }),
      prices.length > 1
        ? el('span', { class: 'purchase-hero__change', text: `${change >= 0 ? '+' : ''}${change} %` })
        : null,
    ),
    el(
      'div',
      { class: 'purchase-hero__average' },
      el('strong', { text: formatAmount(average) }),
      el('span', { text: `kr/${formatUnit(item.unit) || 'st'} i snitt` }),
    ),
    el(
      'div',
      { class: 'purchase-hero__bars', 'aria-label': 'Prisutveckling' },
      ...samples.map((price, index) =>
        el('span', {
          class: `purchase-hero__bar purchase-hero__bar--${Math.min(5, Math.floor(index / Math.max(samples.length / 5, 1)) + 1)}`,
          style: `height:${Math.max(28, (price / max) * 100)}%`,
        }),
      ),
    ),
    el('p', {
      class: 'purchase-hero__range',
      text: firstDate && lastDate ? `${formatDate(firstDate)} — ${formatDate(lastDate)}` : `${rows.length} rader`,
    }),
  );
}

interface ChipOption {
  id: string;
  name: string;
  color: string;
}

function renderChipRow(
  label: string,
  options: ChipOption[],
  selected: string[],
  onChange: (ids: string[]) => void,
): HTMLElement | null {
  if (options.length === 0) return null;
  const active = new Set(selected);

  return el(
    'div',
    { class: 'chip-row', role: 'group', 'aria-label': label },
    ...options.map((option) =>
      chipControl({
        label: option.name,
        pressed: active.has(option.id),
        dotColor: option.color,
        onToggle: () => {
          if (active.has(option.id)) active.delete(option.id);
          else active.add(option.id);
          onChange([...active]);
        },
      }),
    ),
  );
}

function renderRows(
  rows: PurchaseRow[],
  categories: Map<string, Category>,
  limit: number,
  onMore: () => void,
): HTMLElement {
  if (rows.length === 0) {
    return emptyState({
      icon: 'search',
      title: 'Inga varor matchar',
      body: 'Prova en annan sökning, eller skanna fler kvitton.',
    });
  }

  const container = el('div', { class: 'purchase-list__rows' });
  for (const row of rows.slice(0, limit)) {
    container.appendChild(renderRow(row, categories));
  }

  if (rows.length > limit) {
    container.appendChild(
      actionRow({
        label: `Visa ${Math.min(PAGE_SIZE, rows.length - limit)} till (${rows.length - limit} kvar)`,
        onClick: onMore,
      }),
    );
  }
  return container;
}

function renderRow(row: PurchaseRow, categories: Map<string, Category>): HTMLElement {
  const { item } = row;
  const category = item.categoryId ? categories.get(item.categoryId) : undefined;
  const quantityLabel =
    item.quantity === 1 && item.unit === 'st'
      ? null
      : `${formatQuantity(item.quantity)} ${formatUnit(item.unit)}`.trim();

  return el(
    'button',
    {
      class: [
        'purchase-row',
        item.isDiscount ? 'purchase-row--discount' : '',
        item.isDeposit ? 'purchase-row--deposit' : '',
      ],
      type: 'button',
      on: { click: () => router.navigate(`/receipt/${row.receiptId}`) },
    },
    el('span', { class: 'purchase-row__name truncate', text: item.name }),
    el('span', {
      class: 'purchase-row__price',
      text: formatMoney(item.totalPrice, row.currency),
    }),
    el(
      'span',
      { class: 'purchase-row__meta' },
      el('span', { text: formatDate(row.purchasedAt) }),
      el('span', { text: row.merchantName ?? 'Okänd butik' }),
      quantityLabel ? el('span', { text: quantityLabel }) : null,
      item.unitPrice !== null && item.quantity !== 1
        ? el('span', { text: `${formatMoney(item.unitPrice, row.currency)}/${formatUnit(item.unit) || 'st'}` })
        : null,
      category
        ? el('span', {}, el('span', { class: 'pill__dot', style: `background:${category.color};display:inline-block;margin-right:4px` }), category.name)
        : null,
    ),
  );
}

// --- URL <-> filter -------------------------------------------------------

function filterFromParams(params: URLSearchParams): ItemFilter {
  const list = (key: string): string[] | undefined => {
    const value = params.get(key);
    return value ? value.split(',').filter(Boolean) : undefined;
  };
  const number = (key: string): number | undefined => {
    const value = params.get(key);
    if (value === null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    query: params.get('q') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    categoryIds: list('cat'),
    tagIds: list('tag'),
    merchants: list('shop'),
    minPrice: number('min'),
    maxPrice: number('max'),
    includeDiscounts: params.get('disc') === '1' ? true : params.get('disc') === '0' ? false : undefined,
    includeDeposits: params.get('pant') === '1' ? true : params.get('pant') === '0' ? false : undefined,
    sort: (params.get('sort') as ItemSortKey | null) ?? 'date',
    direction: params.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

function paramsFromFilter(filter: ItemFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.query) params.set('q', filter.query);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.categoryIds?.length) params.set('cat', filter.categoryIds.join(','));
  if (filter.tagIds?.length) params.set('tag', filter.tagIds.join(','));
  if (filter.merchants?.length) params.set('shop', filter.merchants.join(','));
  if (filter.minPrice !== undefined) params.set('min', String(filter.minPrice));
  if (filter.maxPrice !== undefined) params.set('max', String(filter.maxPrice));
  if (filter.includeDiscounts !== undefined) params.set('disc', filter.includeDiscounts ? '1' : '0');
  if (filter.includeDeposits !== undefined) params.set('pant', filter.includeDeposits ? '1' : '0');
  if (filter.sort && filter.sort !== 'date') params.set('sort', filter.sort);
  if (filter.direction === 'asc') params.set('dir', 'asc');
  return params;
}
