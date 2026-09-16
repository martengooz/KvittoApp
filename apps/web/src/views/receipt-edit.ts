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

import { swipeRow } from '../components/swipe-actions.js';
import { banner, deleteButton, field, listGroup, moneyInput, row as listRow } from '../components/ui.js';
import { el } from '../core/dom.js';
import { router, type RouteContext } from '../core/router.js';
import { promptDialog } from '../components/dialog.js';
import { toast } from '../core/toast.js';
import type { ReceiptBundle } from '../db/queries.js';
import {
  addItem,
  createTag,
  deleteItem,
  restoreItem,
  setReceiptTags,
  updateItem,
  updateReceipt,
} from '../db/repo.js';
import { receiptCrumb, receiptScreen, UNITS } from './receipt-shared.js';

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
      { class: 'row row--stacked' },
      el('span', { class: 'field__label', text: 'Anteckning' }),
      el('textarea', {
        value: receipt.notes ?? '',
        placeholder: 'Egna anteckningar…',
        rows: 2,
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
          click: async () => {
            const name = await promptDialog({ title: 'Namn på etiketten', label: 'Etikettens namn' });
            if (!name) return;
            const tag = await createTag(name);
            void setReceiptTags(receiptId, [...selected, tag.id]);
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
      { class: ['stack', 'stack--between', 'pad', 'list-group__header'] },
      el('h2', { class: ['list-group__title', 'list-group__title--flush'], text: `Varor (${items.length})` }),
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

/**
 * One line item, editable.
 *
 * The row can be swiped away as well as deleted from its own trash button: the
 * gesture is the quick way through a receipt the model over-read, and the
 * button is the way that works with a keyboard, with VoiceOver, and with a
 * mouse. The swipe deletes on the spot and offers an undo; the button, having
 * no accidental way to fire, asks first.
 */
function renderItem(item: ReceiptItem, categories: Category[]): HTMLElement {
  const editor = el(
    'div',
    { class: 'item-editor' },
    el(
      'div',
      { class: 'stack' },
      el('input', {
        class: ['grow', 'item-editor__name'],
        type: 'text',
        value: item.name,
        'aria-label': 'Varunamn',
        on: {
          change: (event) => {
            void updateItem(item.id, { name: (event.target as HTMLInputElement).value.trim() || 'Namnlös' });
          },
        },
      }),
      deleteButton({
        label: `Ta bort ${item.name}`,
        title: 'Ta bort raden?',
        message: `"${item.name}" tas bort från kvittot.`,
        onConfirm: () => deleteItem(item.id),
      }),
    ),
    el(
      'div',
      { class: 'item-editor__grid' },
      field('Antal', el('input', {
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
      field('Enhet', el(
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
      field('À-pris', moneyInput(item.unitPrice, (value) => updateItem(item.id, { unitPrice: value }))),
      field('Summa', moneyInput(item.totalPrice, (value) =>
        updateItem(item.id, { totalPrice: value ?? 0 }),
      )),
      field('Kategori', el(
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

  return swipeRow({
    content: editor,
    label: `Ta bort ${item.name}`,
    onAction: () => removeItem(item),
  });
}

/** Deletes a line item outright, with the undo that lets the swipe be cheap. */
async function removeItem(item: ReceiptItem): Promise<void> {
  await deleteItem(item.id);
  toast(`"${item.name}" togs bort.`, {
    durationMs: 6000,
    action: { label: 'Ångra', onClick: () => void restoreItem(item.id) },
  });
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
