/**
 * Every line item ever scanned, in one sortable and filterable list.
 *
 * This is the view that makes the archive useful: "what do I actually pay for
 * milk", "how much went on sweets last month", "where did I buy that". Filters
 * live in the URL, same as the receipts list.
 */

import {
  formatDate,
  formatMoney,
  formatQuantity,
  formatUnit,
  type Category,
} from '@kvitto/shared';

import { debounce, el, replaceChildren } from '../core/dom.js';
import { bus } from '../core/events.js';
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

export async function purchasesView(context: RouteContext): Promise<HTMLElement> {
  const root = el('div', {});
  const filter = filterFromParams(context.params);
  filter.includeDiscounts ??= getSettings().ui.showAuxiliaryLines;
  filter.includeDeposits ??= getSettings().ui.showAuxiliaryLines;

  let limit = PAGE_SIZE;

  const unsubscribe = bus.on('data:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  const summaryHost = el('div', {});
  const listHost = el('div', { class: 'card' });
  const filtersHost = el('div', { class: 'filter-bar' });

  function updateUrl(): void {
    const query = paramsFromFilter(filter).toString();
    router.navigate(query ? `/purchases?${query}` : '/purchases', { replace: true });
  }

  function onFilterChange(): void {
    limit = PAGE_SIZE;
    updateUrl();
    void refresh();
  }

  const applySearch = debounce((value: string) => {
    filter.query = value || undefined;
    onFilterChange();
  }, 220);

  async function refresh(): Promise<void> {
    const [rows, categories] = await Promise.all([searchPurchases(filter), categoriesById()]);

    const total = rows.reduce((sum, row) => sum + row.item.totalPrice, 0);
    const quantity = rows.reduce((sum, row) => sum + (row.item.unit === 'st' ? row.item.quantity : 0), 0);

    replaceChildren(
      summaryHost,
      el(
        'div',
        { class: 'summary-bar' },
        el('span', {}, `${rows.length} rader`),
        el('span', {}, el('strong', { text: formatMoney(total) })),
        quantity > 0 ? el('span', { class: 'muted' }, `${formatQuantity(quantity)} st`) : null,
      ),
    );

    replaceChildren(listHost, renderRows(rows, categories, limit, () => {
      limit += PAGE_SIZE;
      void refresh();
    }));
  }

  const merchants = await knownMerchants();
  const [categories, tags] = await Promise.all([categoriesById(), tagsById()]);

  replaceChildren(
    filtersHost,
    el('input', {
      type: 'search',
      placeholder: 'Sök vara, t.ex. mjölk…',
      value: filter.query ?? '',
      'aria-label': 'Sök bland köpta varor',
      on: { input: (event) => applySearch((event.target as HTMLInputElement).value.trim()) },
    }),
    el(
      'div',
      { class: 'row' },
      el(
        'div',
        { class: 'grow' },
        el(
          'select',
          {
            'aria-label': 'Sortera efter',
            on: {
              change: (event) => {
                filter.sort = (event.target as HTMLSelectElement).value as ItemSortKey;
                onFilterChange();
              },
            },
          },
          ...Object.entries(SORT_LABELS).map(([value, label]) =>
            el('option', { value, text: label, selected: (filter.sort ?? 'date') === value }),
          ),
        ),
      ),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: (filter.direction ?? 'desc') === 'desc' ? '↓' : '↑',
        'aria-label': 'Byt sorteringsordning',
        on: {
          click: () => {
            filter.direction = (filter.direction ?? 'desc') === 'desc' ? 'asc' : 'desc';
            onFilterChange();
          },
        },
      }),
    ),
    el(
      'div',
      { class: 'row' },
      el('input', {
        type: 'date',
        value: filter.from ?? '',
        'aria-label': 'Från datum',
        on: {
          change: (event) => {
            filter.from = (event.target as HTMLInputElement).value || undefined;
            onFilterChange();
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
            onFilterChange();
          },
        },
      }),
    ),
    renderChipRow('Kategori', [...categories.values()], filter.categoryIds ?? [], (ids) => {
      filter.categoryIds = ids.length ? ids : undefined;
      onFilterChange();
    }),
    renderChipRow('Etikett', [...tags.values()], filter.tagIds ?? [], (ids) => {
      filter.tagIds = ids.length ? ids : undefined;
      onFilterChange();
    }),
    merchants.length > 1
      ? renderChipRow(
          'Butik',
          merchants.map((name) => ({ id: name, name, color: 'var(--text-faint)' })),
          filter.merchants ?? [],
          (ids) => {
            filter.merchants = ids.length ? ids : undefined;
            onFilterChange();
          },
        )
      : null,
    el(
      'div',
      { class: 'chip-row' },
      el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(filter.includeDiscounts ?? false),
        text: 'Visa rabattrader',
        on: {
          click: () => {
            filter.includeDiscounts = !filter.includeDiscounts;
            onFilterChange();
          },
        },
      }),
      el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(filter.includeDeposits ?? false),
        text: 'Visa pant',
        on: {
          click: () => {
            filter.includeDeposits = !filter.includeDeposits;
            onFilterChange();
          },
        },
      }),
    ),
  );

  replaceChildren(root, filtersHost, summaryHost, listHost);
  await refresh();
  return root;
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
      el(
        'button',
        {
          class: 'chip',
          type: 'button',
          'aria-pressed': String(active.has(option.id)),
          on: {
            click: () => {
              if (active.has(option.id)) active.delete(option.id);
              else active.add(option.id);
              onChange([...active]);
            },
          },
        },
        el('span', { class: 'pill__dot', style: `background:${option.color}` }),
        option.name,
      ),
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
    return el(
      'div',
      { class: 'empty-state' },
      el('div', { class: 'empty-state__icon', 'aria-hidden': 'true', text: '🔍' }),
      el('p', { class: 'empty-state__title', text: 'Inga varor matchar' }),
      el('p', { text: 'Prova en annan sökning, eller skanna fler kvitton.' }),
    );
  }

  const container = el('div', {});
  for (const row of rows.slice(0, limit)) {
    container.appendChild(renderRow(row, categories));
  }

  if (rows.length > limit) {
    container.appendChild(
      el('button', {
        class: 'btn btn--ghost btn--block',
        type: 'button',
        style: 'margin-top:0.5rem',
        text: `Visa ${Math.min(PAGE_SIZE, rows.length - limit)} till (${rows.length - limit} kvar)`,
        on: { click: onMore },
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
