/**
 * Categories, tags and a spending overview.
 *
 * Tags are the collection mechanism: a tag applied to receipts is a saved
 * grouping ("Resa Berlin", "Avdragsgillt", "Renovering"), and tapping one opens
 * the receipt list filtered to it.
 */

import { formatMoney, formatMonth, type Category, type Tag } from '@kvitto/shared';

import { promptDialog } from '../components/dialog.js';
import { actionRow, deleteButton, listGroup } from '../components/ui.js';
import { el, type Child } from '../core/dom.js';
import { liveView } from '../core/live-view.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
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

interface CollectionsData {
  tags: Tag[];
  categories: Category[];
  summary: SpendSummary;
  tagCounts: Map<string, number>;
  categoryLookup: Map<string, Category>;
}

export function collectionsView(): Promise<HTMLElement> {
  return liveView<CollectionsData>({
    load: async () => {
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

      return { tags, categories, summary, tagCounts, categoryLookup };
    },
    render: ({ tags, categories, summary, tagCounts, categoryLookup }) => [
      renderOverview(summary),
      renderSpendByCategory(summary, categoryLookup),
      renderSpendByMonth(summary),
      renderTags(tags, tagCounts),
      renderCategories(categories),
    ],
  });
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

/**
 * A colour-and-name editable list with a delete action and a "new…" row at
 * the foot — the shape tags and categories both are, differing only in the
 * repo calls behind each action and what (if anything) trails the name.
 */
function renderCollection<T extends { id: string; name: string; color: string }>(
  items: T[],
  options: {
    title: string;
    footer?: string;
    nameLabel: string;
    newLabel: string;
    promptTitle: string;
    trailing?: (item: T) => Child;
    update: (id: string, patch: { name?: string; color?: string }) => Promise<unknown>;
    remove: (item: T) => Promise<void>;
    create: (name: string) => Promise<unknown>;
    deleteTitle: string;
    deleteMessage: (item: T) => string;
    deletedToast: string;
  },
): HTMLElement {
  const rows: HTMLElement[] = items.map((item) =>
    el(
      'div',
      { class: 'row' },
      el('input', {
        type: 'color',
        value: item.color,
        'aria-label': `Färg för ${item.name}`,
        on: {
          change: (event) => void options.update(item.id, { color: (event.target as HTMLInputElement).value }),
        },
      }),
      el('input', {
        class: 'row__label',
        type: 'text',
        value: item.name,
        'aria-label': options.nameLabel,
        on: {
          change: (event) => {
            const name = (event.target as HTMLInputElement).value.trim();
            if (name) void options.update(item.id, { name });
          },
        },
      }),
      options.trailing?.(item) ?? null,
      deleteButton({
        label: `Ta bort ${item.name}`,
        title: options.deleteTitle,
        message: options.deleteMessage(item),
        onConfirm: async () => {
          await options.remove(item);
          toast(options.deletedToast);
        },
      }),
    ),
  );

  rows.push(
    actionRow({
      label: options.newLabel,
      onClick: async () => {
        const name = await promptDialog({ title: options.promptTitle, label: options.nameLabel });
        if (name) void options.create(name);
      },
    }),
  );

  return listGroup({ title: options.title, footer: options.footer }, ...rows);
}

function renderTags(tags: Tag[], counts: Map<string, number>): HTMLElement {
  return renderCollection(tags, {
    title: 'Etiketter',
    footer: 'Etiketter grupperar kvitton i samlingar — en resa, ett projekt, allt avdragsgillt.',
    nameLabel: 'Etikettens namn',
    newLabel: 'Ny etikett',
    promptTitle: 'Namn på etiketten',
    trailing: (tag) =>
      el('button', {
        class: ['row__value', 'row__value--link'],
        type: 'button',
        text: `${counts.get(tag.id) ?? 0} kvitton`,
        on: { click: () => router.navigate(`/receipts?tag=${encodeURIComponent(tag.id)}`) },
      }),
    update: (id, patch) => updateTag(id, patch),
    remove: (tag) => deleteTag(tag.id),
    create: (name) => createTag(name),
    deleteTitle: 'Ta bort etiketten?',
    deleteMessage: (tag) => `"${tag.name}" tas bort från alla kvitton som har den.`,
    deletedToast: 'Etiketten togs bort.',
  });
}

function renderCategories(categories: Category[]): HTMLElement {
  return renderCollection(categories, {
    title: `Kategorier (${categories.length})`,
    nameLabel: 'Kategorinamn',
    newLabel: 'Ny kategori',
    promptTitle: 'Namn på kategorin',
    trailing: (category) => el('span', { class: 'pill', text: scopeLabel(category.scope) }),
    update: (id, patch) => updateCategory(id, patch),
    remove: (category) => deleteCategory(category.id),
    create: (name) => createCategory({ name }),
    deleteTitle: 'Ta bort kategorin?',
    deleteMessage: (category) => `Kvitton och varor i "${category.name}" blir okategoriserade.`,
    deletedToast: 'Kategorin togs bort.',
  });
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
