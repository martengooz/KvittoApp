/**
 * The parts the three receipt screens have in common.
 *
 * A receipt is three routes rather than one long page: the receipt itself
 * (`/receipt/:id`), the form that corrects it (`/receipt/:id/edit`) and the
 * secondary details behind it (`/receipt/:id/details`). All three load the same
 * bundle and all three have to re-render when a sync or an edit changes it, so
 * that scaffolding lives here instead of being written out three times.
 */

import { formatDate, formatMoney, type Category, type ItemUnit, type Receipt, type Tag } from '@kvitto/shared';

import { emptyState } from '../components/ui.js';
import { el, type Child } from '../core/dom.js';
import { liveView, type BusyTask } from '../core/live-view.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import { parseReceipt } from '../ai/index.js';
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
) => Child | Promise<Child>;

/**
 * Mounts one of the receipt screens.
 *
 * Returns a container that re-renders itself whenever the data changes —
 * an edit on this screen, an edit on another tab, or an incoming sync — so the
 * views only have to describe what a given bundle looks like.
 */
export function receiptScreen(id: string | undefined, render: ReceiptScreenRender): Promise<HTMLElement> {
  if (!id) return Promise.resolve(receiptNotFound());
  const receiptId = id;

  return liveView<ReceiptScreenData | null>({
    load: async () => {
      const bundle = await getReceiptBundle(receiptId);
      if (!bundle) return null;
      const [categories, tags] = await Promise.all([liveCategories(), liveTags()]);
      return { bundle, categories, tags };
    },
    render: (data, refresh) => (data ? render(data, refresh) : receiptNotFound()),
  });
}

/**
 * Runs the AI extraction for a receipt while the screen shows it as busy.
 *
 * Shared between the receipt screen and its details screen — both offer this
 * action and both need the same "don't run twice, always re-render around it"
 * guard, previously duplicated byte-for-byte between the two.
 */
export async function runParse(id: string, refresh: () => Promise<void>, task: BusyTask): Promise<void> {
  await task.run(async () => {
    const outcome = await parseReceipt(id);
    if (outcome.ok) toast('Kvittot tolkades.', { kind: 'success' });
    else if (outcome.error) toast(outcome.error, { kind: 'error' });
  }, refresh);
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
