/**
 * The edit screen for one receipt: `#/receipt/:id/edit`.
 *
 * Everything the model produced is editable here, because the model will
 * sometimes be wrong and a receipt archive is only worth keeping if it can be
 * corrected. Edits save on blur rather than behind a "save" button, so a
 * correction is never lost by navigating away — "Klar" only goes back.
 *
 * This lives on its own route rather than under the rendered receipt: once a
 * receipt is granskat it is something you read, and a screenful of input fields
 * per line item is not what should be underneath it.
 */

import {
  formatMoney,
  formatQuantity,
  formatUnit,
  parseAmount,
  parseLocalDateTime,
  type Category,
  type ItemUnit,
  type Receipt,
  type ReceiptItem,
  type Tag,
} from '@kvitto/shared';

import { banner, listGroup, row as listRow } from '../components/ui.js';
import { el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { router, type RouteContext } from '../core/router.js';
import { confirmDialog, toast } from '../core/toast.js';
import type { ReceiptBundle } from '../db/queries.js';
import {
  addItem,
  createTag,
  deleteItem,
  setReceiptTags,
  updateItem,
  updateReceipt,
} from '../db/repo.js';
import { labelled, moneyInput, receiptCrumb, receiptScreen, UNITS } from './receipt-shared.js';

export function receiptEditView(context: RouteContext): Promise<HTMLElement> {
  return receiptScreen(context.segments[1], ({ bundle, categories, tags }) =>
    render(bundle, categories, tags),
  );
}

function render(bundle: ReceiptBundle, categories: Category[], tags: Tag[]): HTMLElement {
  const { receipt, items } = bundle;

  return el(
    'div',
    { class: 'receipt-edit' },
    receiptCrumb(receipt),
    renderFacts(receipt, categories),
    renderTags(receipt.id, bundle.tags, tags),
    renderItems(receipt, items, categories),
    renderTotals(receipt, items),
    el(
      'div',
      { class: 'receipt-edit-done' },
      el('button', {
        class: 'btn btn--primary grow',
        type: 'button',
        text: 'Klar',
        on: { click: () => router.navigate(`/receipt/${receipt.id}`) },
      }),
    ),
  );
}

function renderFacts(receipt: Receipt, categories: Category[]): HTMLElement {
  const receiptCategories = categories.filter((category) => category.scope !== 'item');

  return listGroup(
    { title: 'Uppgifter' },
    listRow({
      label: 'Butik',
      trailing: el('input', {
        type: 'text',
        value: receipt.merchant.name ?? '',
        placeholder: 'Butikens namn',
        'aria-label': 'Butik',
        on: {
          change: (event) => {
            const name = (event.target as HTMLInputElement).value.trim() || null;
            void updateReceipt(receipt.id, { merchant: { ...receipt.merchant, name } });
          },
        },
      }),
    }),
    listRow({
      label: 'Datum',
      trailing: el('input', {
        type: 'text',
        value: receipt.purchasedAt ?? '',
        placeholder: 'ÅÅÅÅ-MM-DD',
        inputmode: 'numeric',
        on: {
          change: (event) => {
            const input = event.target as HTMLInputElement;
            const raw = input.value.trim();
            if (!raw) {
              void updateReceipt(receipt.id, { purchasedAt: null });
              return;
            }
            const parsed = parseLocalDateTime(raw);
            if (!parsed) {
              toast('Kunde inte tolka datumet.', { kind: 'error' });
              input.value = receipt.purchasedAt ?? '';
              return;
            }
            input.value = parsed;
            void updateReceipt(receipt.id, { purchasedAt: parsed });
          },
        },
      }),
    }),
    listRow({
      label: 'Totalt',
      trailing: moneyInput(receipt.total, (value) => updateReceipt(receipt.id, { total: value })),
    }),
    listRow({
      label: 'Öresavrundning',
      trailing: moneyInput(receipt.roundingAmount, (value) =>
        updateReceipt(receipt.id, { roundingAmount: value }),
      ),
    }),
    listRow({
      label: 'Kategori',
      trailing: el(
        'select',
        {
          'aria-label': 'Kategori',
          on: {
            change: (event) => {
              const value = (event.target as HTMLSelectElement).value || null;
              void updateReceipt(receipt.id, { categoryId: value });
            },
          },
        },
        el('option', { value: '', text: 'Ingen', selected: receipt.categoryId === null }),
        ...receiptCategories.map((category) =>
          el('option', {
            value: category.id,
            text: category.name,
            selected: receipt.categoryId === category.id,
          }),
        ),
      ),
    }),
    el(
      'div',
      { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:6px' },
      el('span', { class: 'field__label', style: 'margin:0', text: 'Anteckning' }),
      el('textarea', {
        value: receipt.notes ?? '',
        placeholder: 'Egna anteckningar…',
        rows: 2,
        style: 'background:var(--fill-tertiary);border-radius:8px;padding:8px 10px;text-align:left',
        on: {
          change: (event) => {
            const value = (event.target as HTMLTextAreaElement).value.trim() || null;
            void updateReceipt(receipt.id, { notes: value });
          },
        },
      }),
    ),
  );
}

function renderTags(receiptId: string, current: Tag[], all: Tag[]): HTMLElement {
  const selected = new Set(current.map((tag) => tag.id));

  return el(
    'section',
    { class: 'list-group' },
    el('h2', { class: 'list-group__title', text: 'Etiketter och samlingar' }),
    el(
      'div',
      { class: 'chip-row' },
      ...all.map((tag) =>
        el(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(selected.has(tag.id)),
            on: {
              click: () => {
                if (selected.has(tag.id)) selected.delete(tag.id);
                else selected.add(tag.id);
                void setReceiptTags(receiptId, [...selected]);
              },
            },
          },
          el('span', { class: 'pill__dot', style: `background:${tag.color}` }),
          tag.name,
        ),
      ),
      el('button', {
        class: 'chip',
        type: 'button',
        text: 'Ny etikett',
        on: {
          click: () => {
            const name = prompt('Namn på etiketten');
            if (!name?.trim()) return;
            void createTag(name).then((tag) => setReceiptTags(receiptId, [...selected, tag.id]));
          },
        },
      }),
    ),
  );
}

function renderItems(receipt: Receipt, items: ReceiptItem[], categories: Category[]): HTMLElement {
  const itemCategories = categories.filter((category) => category.scope !== 'receipt');

  return el(
    'section',
    { class: 'list-group' },
    el(
      'div',
      { class: 'stack stack--between pad', style: 'margin-bottom:7px' },
      el('h2', { class: 'list-group__title', style: 'margin:0;padding:0', text: `Varor (${items.length})` }),
      el('button', {
        class: 'btn btn--sm btn--plain',
        type: 'button',
        text: 'Lägg till',
        on: { click: () => void addItem(receipt.id) },
      }),
    ),
    el(
      'div',
      { class: 'inset-list' },
      items.length === 0
        ? el('div', { class: 'row muted', text: 'Inga varor registrerade.' })
        : el('div', {}, ...items.map((item) => renderItem(item, itemCategories))),
    ),
  );
}

function renderItem(item: ReceiptItem, categories: Category[]): HTMLElement {
  return el(
    'div',
    { class: 'item-editor' },
    el(
      'div',
      { class: 'stack' },
      el('input', {
        class: 'grow',
        type: 'text',
        value: item.name,
        'aria-label': 'Varunamn',
        style: 'background:none;padding:0;min-height:24px;font-weight:500',
        on: {
          change: (event) => {
            void updateItem(item.id, { name: (event.target as HTMLInputElement).value.trim() || 'Namnlös' });
          },
        },
      }),
      el(
        'button',
        {
          class: 'btn btn--sm btn--icon btn--plain',
          type: 'button',
          'aria-label': `Ta bort ${item.name}`,
          style: 'color:var(--danger)',
          on: {
            click: async () => {
              const confirmed = await confirmDialog({
                title: 'Ta bort raden?',
                message: `"${item.name}" tas bort från kvittot.`,
                confirmLabel: 'Ta bort',
                destructive: true,
              });
              if (confirmed) void deleteItem(item.id);
            },
          },
        },
        icon('trash', { size: 18 }),
      ),
    ),
    el(
      'div',
      { class: 'item-editor__grid' },
      labelled('Antal', el('input', {
        type: 'text',
        inputmode: 'decimal',
        value: formatQuantity(item.quantity),
        on: {
          change: (event) => {
            const parsed = parseAmount((event.target as HTMLInputElement).value);
            void updateItem(item.id, { quantity: parsed ?? 1 });
          },
        },
      })),
      labelled('Enhet', el(
        'select',
        {
          on: {
            change: (event) => {
              void updateItem(item.id, { unit: (event.target as HTMLSelectElement).value as ItemUnit });
            },
          },
        },
        ...UNITS.map((unit) =>
          el('option', { value: unit, text: formatUnit(unit) || '—', selected: item.unit === unit }),
        ),
      )),
      labelled('À-pris', moneyInput(item.unitPrice, (value) => updateItem(item.id, { unitPrice: value }))),
      labelled('Summa', moneyInput(item.totalPrice, (value) =>
        updateItem(item.id, { totalPrice: value ?? 0 }),
      )),
      labelled('Kategori', el(
        'select',
        {
          on: {
            change: (event) => {
              void updateItem(item.id, { categoryId: (event.target as HTMLSelectElement).value || null });
            },
          },
        },
        el('option', { value: '', text: '—', selected: item.categoryId === null }),
        ...categories.map((category) =>
          el('option', {
            value: category.id,
            text: category.name,
            selected: item.categoryId === category.id,
          }),
        ),
      )),
    ),
    item.isDiscount || item.isDeposit
      ? el(
          'div',
          { class: 'row' },
          item.isDiscount ? el('span', { class: 'pill pill--success', text: 'Rabatt' }) : null,
          item.isDeposit ? el('span', { class: 'pill', text: 'Pant' }) : null,
        )
      : null,
    item.rawName && item.rawName !== item.name
      ? el('p', { class: 'faint', text: `Tryckt som: ${item.rawName}` })
      : null,
  );
}

/**
 * What the rows add up to, and whether that agrees with the printed total.
 *
 * Kept next to the item editors rather than on the details screen: it is the
 * check that tells the user whether their corrections are done.
 */
function renderTotals(receipt: Receipt, items: ReceiptItem[]): HTMLElement | null {
  if (items.length === 0) return null;

  const linesTotal = items.reduce((sum, item) => sum + item.totalPrice, 0);
  const expected = linesTotal + (receipt.roundingAmount ?? 0) - (receipt.discountTotal ?? 0);
  const difference = receipt.total === null ? null : receipt.total - expected;
  const mismatch = difference !== null && Math.abs(difference) > 0.51;

  return el(
    'div',
    {},
    listGroup(
      { title: 'Summering' },
      listRow({ label: 'Varor', value: formatMoney(linesTotal, receipt.currency) }),
      receipt.discountTotal
        ? listRow({ label: 'Rabatt', value: formatMoney(-receipt.discountTotal, receipt.currency) })
        : null,
      receipt.roundingAmount
        ? listRow({ label: 'Öresavrundning', value: formatMoney(receipt.roundingAmount, receipt.currency) })
        : null,
      receipt.depositTotal
        ? listRow({ label: 'Varav pant', value: formatMoney(receipt.depositTotal, receipt.currency) })
        : null,
      listRow({ label: 'Att betala', value: formatMoney(receipt.total, receipt.currency) }),
    ),
    mismatch
      ? banner({
          tone: 'warning',
          body:
            `Raderna summerar till ${formatMoney(expected, receipt.currency)}, ` +
            `${formatMoney(Math.abs(difference), receipt.currency)} ifrån totalen.`,
        })
      : null,
  );
}
