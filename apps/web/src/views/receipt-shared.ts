/**
 * The parts the three receipt screens have in common.
 *
 * A receipt is three routes rather than one long page: the receipt itself
 * (`/receipt/:id`), the form that corrects it (`/receipt/:id/edit`) and the
 * secondary details behind it (`/receipt/:id/details`). All three load the same
 * bundle and all three have to re-render when a sync or an edit changes it, so
 * that scaffolding lives here instead of being written out three times.
 */

import {
  formatDate,
  formatMoney,
  parseAmount,
  type Category,
  type ItemUnit,
  type Receipt,
  type Tag,
} from '@kvitto/shared';

import { emptyState } from '../components/ui.js';
import { el, replaceChildren } from '../core/dom.js';
import { bus } from '../core/events.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import { getReceiptBundle, liveCategories, liveTags, type ReceiptBundle } from '../db/queries.js';

/** Units offered by the item editor, in the order a Swedish shop prints them. */
export const UNITS: ItemUnit[] = ['st', 'kg', 'hg', 'g', 'l', 'dl', 'cl', 'm', 'förp', 'other'];

export interface ReceiptScreenData {
  bundle: ReceiptBundle;
  categories: Category[];
  tags: Tag[];
}

export type ReceiptScreenRender = (
  data: ReceiptScreenData,
  refresh: () => Promise<void>,
) => HTMLElement | Promise<HTMLElement>;

/**
 * Mounts one of the receipt screens.
 *
 * Returns a container that re-renders itself whenever the data changes —
 * an edit on this screen, an edit on another tab, or an incoming sync — so the
 * views only have to describe what a given bundle looks like.
 */
export async function receiptScreen(
  id: string | undefined,
  render: ReceiptScreenRender,
): Promise<HTMLElement> {
  if (!id) return receiptNotFound();
  const receiptId = id;
  const root = el('div', {});

  async function refresh(): Promise<void> {
    const bundle = await getReceiptBundle(receiptId);
    if (!bundle) {
      replaceChildren(root, receiptNotFound());
      return;
    }
    const [categories, tags] = await Promise.all([liveCategories(), liveTags()]);
    replaceChildren(root, await render({ bundle, categories, tags }, refresh));
  }

  const unsubscribe = bus.on('data:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  await refresh();
  return root;
}

/**
 * The header of a sub-screen: which receipt is being edited or inspected.
 *
 * Tapping it goes back to the receipt, so the sub-screens have a way home that
 * does not depend on the navigation bar.
 */
export function receiptCrumb(receipt: Receipt): HTMLElement {
  const meta = [
    formatDate(receipt.purchasedAt),
    receipt.total === null ? null : formatMoney(receipt.total, receipt.currency),
  ]
    .filter(Boolean)
    .join(' · ');

  return el(
    'a',
    { class: 'receipt-crumb', href: `#/receipt/${receipt.id}` },
    el('span', { class: 'receipt-crumb__name', text: receipt.merchant.name ?? 'Okänd butik' }),
    el('span', { class: 'receipt-crumb__meta', text: meta }),
  );
}

/** A labelled form control, for the editor's dense grids. */
export function labelled(label: string, control: HTMLElement): HTMLElement {
  return el('label', { style: 'display:block' }, el('span', { class: 'field__label', text: label }), control);
}

/**
 * A text input that accepts Swedish money formatting and normalises on blur, so
 * `12,50`, `12.50` and `12 kr` all work.
 */
export function moneyInput(
  value: number | null,
  onCommit: (value: number | null) => Promise<void> | void,
): HTMLElement {
  return el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: value === null ? '' : value.toFixed(2).replace('.', ','),
    on: {
      change: (event) => {
        const input = event.target as HTMLInputElement;
        const raw = input.value.trim();
        if (!raw) {
          input.value = '';
          void onCommit(null);
          return;
        }
        const parsed = parseAmount(raw);
        if (parsed === null) {
          toast('Kunde inte tolka beloppet.', { kind: 'error' });
          input.value = value === null ? '' : value.toFixed(2).replace('.', ',');
          return;
        }
        input.value = parsed.toFixed(2).replace('.', ',');
        void onCommit(parsed);
      },
    },
  });
}

export function receiptNotFound(): HTMLElement {
  return emptyState({
    icon: 'receipt',
    title: 'Kvittot hittades inte',
    action: el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: 'Till kvittolistan',
      on: { click: () => router.navigate('/receipts') },
    }),
  });
}
