/**
 * Categories, tags and a spending overview.
 *
 * Tags are the collection mechanism: a tag applied to receipts is a saved
 * grouping ("Resa Berlin", "Avdragsgillt", "Renovering"), and tapping one opens
 * the receipt list filtered to it.
 */

import { formatMoney, formatMonth, type Category, type Tag } from '@kvitto/shared';

import { el, replaceChildren } from '../core/dom.js';
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
    { class: 'section' },
    el('h2', { class: 'section__title', text: 'Översikt' }),
    el(
      'div',
      { class: 'stat-grid' },
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

  return el(
    'section',
    { class: 'section' },
    el('h2', { class: 'section__title', text: 'Utgifter per kategori' }),
    el(
      'div',
      { class: 'card card--pad bar-chart' },
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

  return el(
    'section',
    { class: 'section' },
    el('h2', { class: 'section__title', text: 'Utgifter per månad' }),
    el(
      'div',
      { class: 'card card--pad bar-chart' },
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
  return el(
    'section',
    { class: 'section' },
    el(
      'div',
      { class: 'row row--between' },
      el('h2', { class: 'section__title', style: 'margin:0', text: 'Etiketter' }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: '+ Ny',
        on: {
          click: () => {
            const name = prompt('Namn på etiketten');
            if (name?.trim()) void createTag(name);
          },
        },
      }),
    ),
    tags.length === 0
      ? el('p', { class: 'muted', text: 'Skapa etiketter för att gruppera kvitton i samlingar.' })
      : el(
          'div',
          { class: 'card' },
          ...tags.map((tag) =>
            el(
              'div',
              { class: 'row', style: 'padding:0.6rem 0.75rem;border-bottom:1px solid var(--border)' },
              el('input', {
                type: 'color',
                value: tag.color,
                'aria-label': `Färg för ${tag.name}`,
                style: 'width:34px;min-height:34px;padding:2px;flex:none',
                on: {
                  change: (event) => {
                    void updateTag(tag.id, { color: (event.target as HTMLInputElement).value });
                  },
                },
              }),
              el('input', {
                class: 'grow',
                type: 'text',
                value: tag.name,
                'aria-label': 'Etikettens namn',
                on: {
                  change: (event) => {
                    const name = (event.target as HTMLInputElement).value.trim();
                    if (name) void updateTag(tag.id, { name });
                  },
                },
              }),
              el('button', {
                class: 'btn btn--ghost btn--sm',
                type: 'button',
                text: `${counts.get(tag.id) ?? 0} kvitton`,
                on: { click: () => router.navigate(`/receipts?tag=${encodeURIComponent(tag.id)}`) },
              }),
              el('button', {
                class: 'btn btn--ghost btn--sm btn--icon',
                type: 'button',
                'aria-label': `Ta bort ${tag.name}`,
                text: '🗑',
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
              }),
            ),
          ),
        ),
  );
}

function renderCategories(categories: Category[]): HTMLElement {
  return el(
    'details',
    { class: 'section' },
    el('summary', { class: 'section__title', text: `Kategorier (${categories.length})` }),
    el(
      'div',
      { class: 'card' },
      ...categories.map((category) =>
        el(
          'div',
          { class: 'row', style: 'padding:0.6rem 0.75rem;border-bottom:1px solid var(--border)' },
          el('input', {
            type: 'color',
            value: category.color,
            'aria-label': `Färg för ${category.name}`,
            style: 'width:34px;min-height:34px;padding:2px;flex:none',
            on: {
              change: (event) => {
                void updateCategory(category.id, { color: (event.target as HTMLInputElement).value });
              },
            },
          }),
          el('input', {
            class: 'grow',
            type: 'text',
            value: category.name,
            'aria-label': 'Kategorinamn',
            on: {
              change: (event) => {
                const name = (event.target as HTMLInputElement).value.trim();
                if (name) void updateCategory(category.id, { name });
              },
            },
          }),
          el('span', { class: 'pill', text: scopeLabel(category.scope) }),
          el('button', {
            class: 'btn btn--ghost btn--sm btn--icon',
            type: 'button',
            'aria-label': `Ta bort ${category.name}`,
            text: '🗑',
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
          }),
        ),
      ),
      el('button', {
        class: 'btn btn--ghost btn--block',
        type: 'button',
        text: '+ Ny kategori',
        on: {
          click: () => {
            const name = prompt('Namn på kategorin');
            if (name?.trim()) void createCategory({ name: name.trim() });
          },
        },
      }),
    ),
  );
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
