/**
 * Receipt list, grouped by month, with search and filters.
 *
 * Filter state lives in the URL query string so a filtered view survives a
 * reload and can be bookmarked or shared between the app's own screens.
 */

import { formatDate, formatMoney, formatMonth, type Category, type Receipt, type Tag } from '@kvitto/shared';

import { actionSheet, chip, emptyState, searchField } from '../components/ui.js';
import { debounce, el, replaceChildren } from '../core/dom.js';
import { bus } from '../core/events.js';
import { icon } from '../core/icons.js';
import { router } from '../core/router.js';
import type { RouteContext } from '../core/router.js';
import { blobUrl } from '../db/blobs.js';
import {
  categoriesById,
  receiptNeedsReview,
  searchReceipts,
  tagIdsByReceipt,
  tagsById,
  type ReceiptFilter,
  type ReceiptSortKey,
} from '../db/queries.js';

const SORT_LABELS: Record<ReceiptSortKey, string> = {
  date: 'Datum',
  total: 'Belopp',
  merchant: 'Butik',
  added: 'Tillagd',
  items: 'Antal varor',
};

export async function receiptsView(context: RouteContext): Promise<HTMLElement> {
  const root = el('div', {});
  const filter = filterFromParams(context.params);

  const unsubscribe = bus.on('data:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  const listHost = el('div', {});
  const summaryHost = el('div', {});

  function updateUrl(): void {
    const params = paramsFromFilter(filter);
    const query = params.toString();
    router.navigate(query ? `/receipts?${query}` : '/receipts', { replace: true });
  }

  const applySearch = debounce((value: string) => {
    filter.query = value || undefined;
    updateUrl();
    void refresh();
  }, 220);

  async function refresh(): Promise<void> {
    const [receipts, categories, tags, tagLinks] = await Promise.all([
      searchReceipts(filter),
      categoriesById(),
      tagsById(),
      tagIdsByReceipt(),
    ]);

    const total = receipts.reduce((sum, receipt) => sum + (receipt.total ?? 0), 0);
    replaceChildren(
      summaryHost,
      el(
        'div',
        { class: 'summary-bar' },
        el('span', {}, `${receipts.length} kvitton`),
        el('span', {}, el('strong', { text: formatMoney(total) })),
      ),
    );

    replaceChildren(listHost, await renderList(receipts, categories, tags, tagLinks));
  }

  const onFilterChange = (): void => {
    updateUrl();
    void refresh();
  };

  replaceChildren(
    root,
    el(
      'div',
      { style: 'display:grid;gap:10px;margin-bottom:14px' },
      searchField({
        value: filter.query ?? '',
        placeholder: 'Butik, vara eller anteckning',
        label: 'Sök bland kvitton',
        onInput: applySearch,
      }),
      renderQuickFilters(filter, onFilterChange),
      el('div', { class: 'pad' }, renderSortRow(filter, onFilterChange)),
    ),
    summaryHost,
    listHost,
  );

  await refresh();
  return root;
}

function renderQuickFilters(filter: ReceiptFilter, onChange: () => void): HTMLElement {
  const toggle = (active: boolean, label: string, apply: (on: boolean) => void): HTMLElement =>
    chip({
      label,
      pressed: active,
      onToggle: () => {
        apply(!active);
        onChange();
      },
    });

  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return el(
    'div',
    { class: 'chip-row' },
    toggle(filter.needsReview === true, 'Behöver granskas', (on) => {
      filter.needsReview = on || undefined;
    }),
    toggle(filter.from === `${thisMonth}-01`, 'Denna månad', (on) => {
      filter.from = on ? `${thisMonth}-01` : undefined;
      filter.to = undefined;
    }),
    toggle(filter.statuses?.includes('draft') ?? false, 'Otolkade', (on) => {
      filter.statuses = on ? ['draft', 'failed'] : undefined;
    }),
  );
}

function renderSortRow(filter: ReceiptFilter, onChange: () => void): HTMLElement {
  const key = (filter.sort ?? 'date') as ReceiptSortKey;
  const descending = (filter.direction ?? 'desc') === 'desc';

  return el(
    'div',
    { class: 'stack stack--between' },
    el(
      'button',
      {
        class: 'btn btn--sm btn--plain',
        type: 'button',
        style: 'padding-left:0',
        on: {
          click: async () => {
            const chosen = await actionSheet({
              title: 'Sortera efter',
              selected: key,
              options: Object.entries(SORT_LABELS).map(([value, label]) => ({
                value: value as ReceiptSortKey,
                label,
              })),
            });
            if (!chosen) return;
            filter.sort = chosen;
            onChange();
          },
        },
      },
      el('span', { text: `Sortera: ${SORT_LABELS[key]}` }),
      icon('chevron-right', { size: 12, weight: 2.4, className: 'row__chevron' }),
    ),
    el(
      'button',
      {
        class: 'btn btn--sm btn--plain',
        type: 'button',
        style: 'padding-right:0',
        'aria-label': descending ? 'Sorterar fallande' : 'Sorterar stigande',
        on: {
          click: () => {
            filter.direction = descending ? 'asc' : 'desc';
            onChange();
          },
        },
      },
      icon('arrow-up-arrow-down', { size: 16 }),
      el('span', { text: descending ? 'Fallande' : 'Stigande' }),
    ),
  );
}

async function renderList(
  receipts: Receipt[],
  categories: Map<string, Category>,
  tags: Map<string, Tag>,
  tagLinks: Map<string, string[]>,
): Promise<HTMLElement> {
  if (receipts.length === 0) {
    return emptyState({
      icon: 'receipt',
      title: 'Inga kvitton här',
      body: 'Skanna ditt första kvitto, eller ändra filtren ovan.',
      action: el('button', {
        class: 'btn btn--primary',
        type: 'button',
        text: 'Skanna kvitto',
        on: { click: () => router.navigate('/scan') },
      }),
    });
  }

  // Grouped by month into inset cards, the way a sectioned table view reads.
  const container = el('div', {});
  let currentMonth: string | null = null;
  let group: HTMLElement | null = null;

  for (const receipt of receipts) {
    const month = receipt.purchasedAt?.slice(0, 7) ?? 'okänt';
    if (month !== currentMonth) {
      currentMonth = month;
      container.appendChild(
        el('h2', { class: 'section-heading', text: formatMonth(receipt.purchasedAt) }),
      );
      group = el('div', { class: 'inset-list' });
      container.appendChild(group);
    }
    group?.appendChild(await renderCard(receipt, categories, tags, tagLinks));
  }
  return container;
}

async function renderCard(
  receipt: Receipt,
  categories: Map<string, Category>,
  tags: Map<string, Tag>,
  tagLinks: Map<string, string[]>,
): Promise<HTMLElement> {
  const thumb = await blobUrl(receipt.thumbId ?? receipt.imageId);
  const category = receipt.categoryId ? categories.get(receipt.categoryId) : undefined;
  const ownTags = (tagLinks.get(receipt.id) ?? [])
    .map((id) => tags.get(id))
    .filter((tag): tag is Tag => tag !== undefined);

  return el(
    'button',
    {
      class: 'receipt-card',
      type: 'button',
      on: { click: () => router.navigate(`/receipt/${receipt.id}`) },
    },
    el(
      'span',
      { class: 'receipt-card__thumb' },
      thumb
        ? el('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' })
        : icon('receipt', { size: 20 }),
    ),
    el(
      'span',
      { class: 'receipt-card__body' },
      el('span', {
        class: 'receipt-card__title truncate',
        text: receipt.merchant.name ?? 'Okänd butik',
      }),
      el(
        'span',
        { class: 'receipt-card__meta' },
        [formatDate(receipt.purchasedAt), `${receipt.itemCount} varor`].join(' · '),
      ),
      el(
        'span',
        { class: 'receipt-card__tags' },
        statusPill(receipt),
        category
          ? el(
              'span',
              { class: 'pill' },
              el('span', { class: 'pill__dot', style: `background:${category.color}` }),
              category.name,
            )
          : null,
        ...ownTags.slice(0, 3).map((tag) =>
          el('span', { class: 'pill' }, el('span', { class: 'pill__dot', style: `background:${tag.color}` }), tag.name),
        ),
      ),
    ),
    el('span', { class: 'receipt-card__amount', text: formatMoney(receipt.total, receipt.currency) }),
    icon('chevron-right', { size: 12, className: 'row__chevron', weight: 2.4 }),
  );
}

function statusPill(receipt: Receipt): HTMLElement | null {
  if (receipt.status === 'failed') return el('span', { class: 'pill pill--danger', text: 'Tolkning misslyckades' });
  if (receipt.status === 'processing') return el('span', { class: 'pill pill--accent', text: 'Tolkar…' });
  if (receipt.status === 'draft') return el('span', { class: 'pill pill--warning', text: 'Otolkat' });
  if (receiptNeedsReview(receipt)) return el('span', { class: 'pill pill--warning', text: 'Granska' });
  return null;
}

// --- URL <-> filter -------------------------------------------------------

function filterFromParams(params: URLSearchParams): ReceiptFilter {
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
    statuses: list('status') as ReceiptFilter['statuses'],
    minTotal: number('min'),
    maxTotal: number('max'),
    needsReview: params.get('review') === '1' ? true : undefined,
    sort: (params.get('sort') as ReceiptSortKey | null) ?? 'date',
    direction: params.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

function paramsFromFilter(filter: ReceiptFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.query) params.set('q', filter.query);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.categoryIds?.length) params.set('cat', filter.categoryIds.join(','));
  if (filter.tagIds?.length) params.set('tag', filter.tagIds.join(','));
  if (filter.statuses?.length) params.set('status', filter.statuses.join(','));
  if (filter.minTotal !== undefined) params.set('min', String(filter.minTotal));
  if (filter.maxTotal !== undefined) params.set('max', String(filter.maxTotal));
  if (filter.needsReview) params.set('review', '1');
  if (filter.sort && filter.sort !== 'date') params.set('sort', filter.sort);
  if (filter.direction === 'asc') params.set('dir', 'asc');
  return params;
}
