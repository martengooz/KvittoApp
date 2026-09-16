/**
 * Receipt list, grouped by month, with search and filters.
 *
 * Filter state lives in the URL query string so a filtered view survives a
 * reload and can be bookmarked or shared between the app's own screens.
 */

import { formatAmount, formatDate, formatMoney, formatMonth, type Category, type Receipt } from '@kvitto/shared';

import { swipeRow } from '../components/swipe-actions.js';
import { chip, emptyState, searchField } from '../components/ui.js';
import { debounce, el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { liveView } from '../core/live-view.js';
import { router } from '../core/router.js';
import type { RouteContext } from '../core/router.js';
import { toast } from '../core/toast.js';
import { blobUrl } from '../db/blobs.js';
import {
  categoriesById,
  liveReceipts,
  receiptNeedsReview,
  searchReceipts,
  type ReceiptFilter,
  type ReceiptSortKey,
} from '../db/queries.js';
import { deleteReceipt, restoreReceipt } from '../db/repo.js';
import { listParam, numberParam, renderSortRow, syncFilterToUrl } from './filters.js';

const SORT_LABELS: Record<ReceiptSortKey, string> = {
  date: 'Datum',
  total: 'Belopp',
  merchant: 'Butik',
  added: 'Tillagd',
  items: 'Antal varor',
};

export function receiptsView(context: RouteContext): Promise<HTMLElement> {
  const filter = filterFromParams(context.params);
  // The filter panel's open/closed state is UI, not data — kept outside the
  // reload/render cycle so a `data:changed` refresh doesn't collapse it.
  let filterOpen = false;
  let refreshView: () => Promise<void> = async () => {};

  function updateUrl(): void {
    syncFilterToUrl('/receipts', filter, paramsFromFilter);
  }

  const applySearch = debounce((value: string) => {
    filter.query = value || undefined;
    updateUrl();
    void refreshView();
  }, 220);

  function onFilterChange(): void {
    updateUrl();
    void refreshView();
  }

  return liveView({
    load: async () => {
      const [receipts, allReceipts, categories] = await Promise.all([
        searchReceipts(filter),
        liveReceipts(),
        categoriesById(),
      ]);
      return { receipts, allReceipts, categories };
    },
    render: async ({ receipts, allReceipts, categories }, refresh) => {
      refreshView = refresh;

      return [
        renderSummary(allReceipts, categories),
        el(
          'div',
          { class: 'receipt-tools' },
          el(
            'div',
            { class: 'receipt-search-row' },
            searchField({
              value: filter.query ?? '',
              placeholder: 'Sök butik eller vara',
              label: 'Sök bland kvitton',
              onInput: applySearch,
            }),
            el(
              'button',
              {
                class: 'filter-button',
                type: 'button',
                'aria-label': 'Visa filter',
                'aria-expanded': String(filterOpen),
                on: {
                  click: () => {
                    filterOpen = !filterOpen;
                    void refreshView();
                  },
                },
              },
              icon('filter', { size: 20 }),
            ),
          ),
          el(
            'div',
            { class: 'receipt-filter-panel', hidden: !filterOpen },
            renderQuickFilters(filter, onFilterChange),
            el('div', { class: 'pad' }, renderReceiptSortRow(filter, onFilterChange)),
          ),
        ),
        await renderList(receipts),
      ];
    },
  });
}

function renderSummary(receipts: Receipt[], categories: Map<string, Category>): HTMLElement {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const today = now.toISOString().slice(0, 10);
  const current = receipts.filter((receipt) => {
    const date = receipt.purchasedAt?.slice(0, 10);
    return date !== undefined && date >= monthStart && date <= today;
  });
  const total = current.reduce((sum, receipt) => sum + (receipt.total ?? 0), 0);
  const totals = new Map<string, { name: string; amount: number }>();

  for (const receipt of current) {
    const category = receipt.categoryId ? categories.get(receipt.categoryId) : undefined;
    const key = category?.id ?? 'other';
    const entry = totals.get(key) ?? { name: category?.name ?? 'Övrigt', amount: 0 };
    entry.amount += receipt.total ?? 0;
    totals.set(key, entry);
  }

  const legend = [...totals.values()].sort((a, b) => b.amount - a.amount).slice(0, 4);
  if (legend.length === 0) legend.push({ name: 'Inga köp ännu', amount: 0 });
  const stops: string[] = [];
  let cursor = 0;
  legend.forEach((entry, index) => {
    const end = total > 0 ? cursor + (entry.amount / total) * 100 : 100;
    stops.push(`var(--k-ramp-${Math.min(index + 2, 5)}) ${cursor}% ${end}%`);
    cursor = end;
  });

  const monthName = new Intl.DateTimeFormat('sv-SE', { month: 'long' }).format(now);
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousStart = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-01`;
  const previousEnd = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(Math.min(now.getDate(), new Date(previous.getFullYear(), previous.getMonth() + 1, 0).getDate())).padStart(2, '0')}`;
  const previousTotal = receipts
    .filter((receipt) => {
      const date = receipt.purchasedAt?.slice(0, 10);
      return date !== undefined && date >= previousStart && date <= previousEnd;
    })
    .reduce((sum, receipt) => sum + (receipt.total ?? 0), 0);
  const difference = total - previousTotal;
  const comparison = previousTotal === 0
    ? `${current.length} kvitton hittills`
    : `${formatMoney(Math.abs(difference))} ${difference >= 0 ? 'mer' : 'mindre'} än ${new Intl.DateTimeFormat('sv-SE', { month: 'long' }).format(previous)} vid samma datum`;

  return el(
    'section',
    { class: 'receipt-summary' },
    el('h2', { class: 'receipt-summary__title', text: `${monthName[0]?.toUpperCase() ?? ''}${monthName.slice(1)} hittills` }),
    el(
      'div',
      { class: 'receipt-summary__content' },
      el(
        'div',
        { class: 'receipt-donut', style: `background:conic-gradient(${stops.join(',')})` },
        el('span', { text: formatAmount(total) }),
      ),
      el(
        'div',
        { class: 'receipt-legend' },
        ...legend.map((entry, index) =>
          el(
            'div',
            { class: 'receipt-legend__row' },
            el('span', { class: `receipt-legend__dot receipt-legend__dot--${Math.min(index + 2, 5)}` }),
            el('span', { class: 'truncate', text: entry.name }),
            el('span', { class: 'receipt-legend__amount', text: formatAmount(entry.amount) }),
          ),
        ),
      ),
    ),
    el('p', { class: 'receipt-summary__comparison', text: comparison }),
  );
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

function renderReceiptSortRow(filter: ReceiptFilter, onChange: () => void): HTMLElement {
  const descending = (filter.direction ?? 'desc') === 'desc';

  return renderSortRow({
    sortKey: (filter.sort ?? 'date') as ReceiptSortKey,
    direction: filter.direction ?? 'desc',
    labels: SORT_LABELS,
    directionAriaLabel: (isDescending) => (isDescending ? 'Sorterar fallande' : 'Sorterar stigande'),
    onSort: (key) => {
      filter.sort = key;
      onChange();
    },
    onToggleDirection: () => {
      filter.direction = descending ? 'asc' : 'desc';
      onChange();
    },
  });
}

async function renderList(receipts: Receipt[]): Promise<HTMLElement> {
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

  const container = el('div', {});
  let currentMonth: string | null = null;
  let group: HTMLElement | null = null;

  for (const receipt of receipts) {
    const month = receipt.purchasedAt?.slice(0, 7) ?? 'okänt';
    if (month !== currentMonth) {
      currentMonth = month;
      const monthReceipts = receipts.filter((candidate) => (candidate.purchasedAt?.slice(0, 7) ?? 'okänt') === month);
      const reviewCount = monthReceipts.filter(receiptNeedsReview).length;
      container.appendChild(el(
        'div',
        { class: 'section-heading' },
        el('h2', { text: formatMonth(receipt.purchasedAt) }),
        reviewCount > 0 ? el('span', { text: `${reviewCount} att granska` }) : null,
      ));
      group = el('div', { class: 'receipt-group' });
      container.appendChild(group);
    }
    group?.appendChild(await renderCard(receipt));
  }
  return container;
}

async function renderCard(receipt: Receipt): Promise<HTMLElement> {
  const thumb = await blobUrl(receipt.thumbId ?? receipt.imageId);
  const needsReview = receiptNeedsReview(receipt);
  const merchant = receipt.merchant.name ?? 'Okänd butik';

  const card = el(
    'button',
    {
      class: ['receipt-card', needsReview ? 'receipt-card--review' : ''],
      type: 'button',
      on: { click: () => router.navigate(`/receipt/${receipt.id}`) },
    },
    el(
      'span',
      { class: 'receipt-card__thumb' },
      needsReview
        ? icon('exclamation-triangle', { size: 20 })
        : thumb
        ? el('img', { src: thumb, alt: '', loading: 'lazy', decoding: 'async' })
        : icon('receipt', { size: 20 }),
    ),
    el(
      'span',
      { class: 'receipt-card__body' },
      el('span', {
        class: 'receipt-card__title truncate',
        text: merchant,
      }),
      el('span', {
        class: ['receipt-card__meta', needsReview ? 'receipt-card__meta--review' : ''],
        text: needsReview
          ? 'Behöver granskas'
          : [formatDate(receipt.purchasedAt), `${receipt.itemCount} varor`].join(' · '),
      }),
    ),
    el('span', { class: 'receipt-card__amount', text: formatMoney(receipt.total, receipt.currency) }),
  );

  return swipeRow({
    content: card,
    label: `Ta bort kvittot från ${merchant}`,
    onAction: () => removeReceipt(receipt, merchant),
  });
}

/**
 * The swipe's delete: no alert in front of it, an "Ångra" behind it.
 *
 * The receipt is tombstoned rather than erased, so undoing it is a matter of
 * clearing the tombstone again — which is also why the offer can outlive the
 * list re-rendering without the card in it.
 */
async function removeReceipt(receipt: Receipt, merchant: string): Promise<void> {
  await deleteReceipt(receipt.id);
  toast(`${merchant} togs bort.`, {
    durationMs: 6000,
    action: { label: 'Ångra', onClick: () => void restoreReceipt(receipt.id) },
  });
}

// --- URL <-> filter -------------------------------------------------------

function filterFromParams(params: URLSearchParams): ReceiptFilter {
  return {
    query: params.get('q') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    categoryIds: listParam(params, 'cat'),
    tagIds: listParam(params, 'tag'),
    statuses: listParam(params, 'status') as ReceiptFilter['statuses'],
    minTotal: numberParam(params, 'min'),
    maxTotal: numberParam(params, 'max'),
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
