/**
 * Categories, tags and a spending overview.
 *
 * Tags are the collection mechanism: a tag applied to receipts is a saved
 * grouping ("Resa Berlin", "Avdragsgillt", "Renovering"), and tapping one opens
 * the receipt list filtered to it.
 */

import { formatMoney, formatMonth, type Category, type Tag } from '@kvitto/shared';

import { listGroup, row as listRow } from '../components/ui.js';
import { el, replaceChildren } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { bus } from '../core/events.js';
import { router } from '../core/router.js';
import { confirmDialog, toast } from '../core/toast.js';
import {
  categoriesById,
  liveCategories,
  liveTags,
  summarize,
  tagIdsByReceipt,
  type SpendSummary,
} from '../db/queries.js';
import {
  createCategory,
  createTag,
  deleteCategory,
  deleteTag,
  updateCategory,
  updateTag,
} from '../db/repo.js';

export async function collectionsView(): Promise<HTMLElement> {
  const root = el('div', {});

  const unsubscribe = bus.on('data:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  async function refresh(): Promise<void> {
    const [tags, categories, summary, tagLinks, categoryLookup] = await Promise.all([
      liveTags(),
      liveCategories(),
      summarize(),
      tagIdsByReceipt(),
      categoriesById(),
    ]);

    const tagCounts = new Map<string, number>();
    for (const ids of tagLinks.values()) {
      for (const id of ids) tagCounts.set(id, (tagCounts.get(id) ?? 0) + 1);
    }

    replaceChildren(
      root,
      renderOverview(summary),
      renderSpendByCategory(summary, categoryLookup),
      renderSpendByMonth(summary),
      renderTags(tags, tagCounts),
      renderCategories(categories),
    );
  }

  await refresh();
  return root;
}

function renderOverview(summary: SpendSummary): HTMLElement {
  return el(
    'section',
    { class: 'list-group' },
    el('div', { class: 'stat-grid' },
      stat(String(summary.receiptCount), 'kvitton'),
      stat(String(summary.itemCount), 'varor'),
      stat(formatMoney(summary.total), 'totalt'),
    ),
  );
}

function renderSpendByCategory(summary: SpendSummary, categories: Map<string, Category>): HTMLElement | null {
  const rows = summary.byCategory.filter((row) => row.total > 0).slice(0, 10);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((row) => row.total));

  return listGroup(
    { title: 'Utgifter per kategori' },
    el(
      'div',
      { class: 'bar-chart' },
      ...rows.map((row) => {
        const category = row.categoryId ? categories.get(row.categoryId) : undefined;
        return el(
          'div',
          { class: 'bar-chart__row' },
          el('span', { class: 'truncate', text: category?.name ?? 'Okategoriserat' }),
          el(
            'span',
            { class: 'bar-chart__track' },
            el('span', {
              class: 'bar-chart__fill',
              style: `width:${(row.total / max) * 100}%;background:${category?.color ?? 'var(--accent)'}`,
            }),
          ),
          el('span', { class: 'bar-chart__value', text: formatMoney(row.total) }),
        );
      }),
    ),
  );
}

function renderSpendByMonth(summary: SpendSummary): HTMLElement | null {
  // Most recent twelve months, oldest first so the trend reads left to right.
  const rows = summary.byMonth.slice(-12);
  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((row) => row.total));

  return listGroup(
    { title: 'Utgifter per månad' },
    el(
      'div',
      { class: 'bar-chart' },
      ...rows.map((row) =>
        el(
          'div',
          { class: 'bar-chart__row' },
          el('span', { class: 'truncate', text: formatMonth(`${row.month}-01`) }),
          el(
            'span',
            { class: 'bar-chart__track' },
            el('span', { class: 'bar-chart__fill', style: `width:${max > 0 ? (row.total / max) * 100 : 0}%` }),
          ),
          el('span', { class: 'bar-chart__value', text: formatMoney(row.total) }),
        ),
      ),
    ),
  );
}

function renderTags(tags: Tag[], counts: Map<string, number>): HTMLElement {
  const rows: HTMLElement[] = tags.map((tag) =>
    el(
      'div',
      { class: 'row' },
      el('input', {
        type: 'color',
        value: tag.color,
        'aria-label': `Färg för ${tag.name}`,
        on: {
          change: (event) => void updateTag(tag.id, { color: (event.target as HTMLInputElement).value }),
        },
      }),
      el('input', {
        class: 'row__label',
        type: 'text',
        value: tag.name,
        'aria-label': 'Etikettens namn',
        style: 'text-align:left',
        on: {
          change: (event) => {
            const name = (event.target as HTMLInputElement).value.trim();
            if (name) void updateTag(tag.id, { name });
          },
        },
      }),
      el('button', {
        class: 'row__value',
        type: 'button',
        style: 'background:none;border:0;font:inherit;color:var(--tint);cursor:pointer',
        text: `${counts.get(tag.id) ?? 0} kvitton`,
        on: { click: () => router.navigate(`/receipts?tag=${encodeURIComponent(tag.id)}`) },
      }),
      el(
        'button',
        {
          class: 'btn btn--sm btn--icon btn--plain',
          type: 'button',
          'aria-label': `Ta bort ${tag.name}`,
          style: 'color:var(--danger)',
          on: {
            click: async () => {
              const confirmed = await confirmDialog({
                title: 'Ta bort etiketten?',
                message: `"${tag.name}" tas bort från alla kvitton som har den.`,
                confirmLabel: 'Ta bort',
                destructive: true,
              });
              if (confirmed) {
                await deleteTag(tag.id);
                toast('Etiketten togs bort.');
              }
            },
          },
        },
        icon('trash', { size: 18 }),
      ),
    ),
  );

  rows.push(
    el('button', {
      class: 'row',
      type: 'button',
      style: 'color:var(--tint);justify-content:center;font-weight:500',
      text: 'Ny etikett',
      on: {
        click: () => {
          const name = prompt('Namn på etiketten');
          if (name?.trim()) void createTag(name);
        },
      },
    }),
  );

  return listGroup(
    {
      title: 'Etiketter',
      footer: 'Etiketter grupperar kvitton i samlingar — en resa, ett projekt, allt avdragsgillt.',
    },
    ...rows,
  );
}

function renderCategories(categories: Category[]): HTMLElement {
  const rows: HTMLElement[] = categories.map((category) =>
    el(
      'div',
      { class: 'row' },
      el('input', {
        type: 'color',
        value: category.color,
        'aria-label': `Färg för ${category.name}`,
        on: {
          change: (event) =>
            void updateCategory(category.id, { color: (event.target as HTMLInputElement).value }),
        },
      }),
      el('input', {
        class: 'row__label',
        type: 'text',
        value: category.name,
        'aria-label': 'Kategorinamn',
        style: 'text-align:left',
        on: {
          change: (event) => {
            const name = (event.target as HTMLInputElement).value.trim();
            if (name) void updateCategory(category.id, { name });
          },
        },
      }),
      el('span', { class: 'pill', text: scopeLabel(category.scope) }),
      el(
        'button',
        {
          class: 'btn btn--sm btn--icon btn--plain',
          type: 'button',
          'aria-label': `Ta bort ${category.name}`,
          style: 'color:var(--danger)',
          on: {
            click: async () => {
              const confirmed = await confirmDialog({
                title: 'Ta bort kategorin?',
                message: `Kvitton och varor i "${category.name}" blir okategoriserade.`,
                confirmLabel: 'Ta bort',
                destructive: true,
              });
              if (confirmed) {
                await deleteCategory(category.id);
                toast('Kategorin togs bort.');
              }
            },
          },
        },
        icon('trash', { size: 18 }),
      ),
    ),
  );

  rows.push(
    el('button', {
      class: 'row',
      type: 'button',
      style: 'color:var(--tint);justify-content:center;font-weight:500',
      text: 'Ny kategori',
      on: {
        click: () => {
          const name = prompt('Namn på kategorin');
          if (name?.trim()) void createCategory({ name: name.trim() });
        },
      },
    }),
  );

  return listGroup({ title: `Kategorier (${categories.length})` }, ...rows);
}

function scopeLabel(scope: Category['scope']): string {
  return scope === 'receipt' ? 'kvitto' : scope === 'item' ? 'vara' : 'båda';
}

function stat(value: string, label: string): HTMLElement {
  return el(
    'div',
    { class: 'stat' },
    el('div', { class: 'stat__value', text: value }),
    el('div', { class: 'stat__label', text: label }),
  );
}
