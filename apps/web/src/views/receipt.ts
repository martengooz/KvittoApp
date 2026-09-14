/**
 * A single receipt, printed the way the paper one was.
 *
 * This screen is the receipt and nothing else: every line item, in order, with
 * the totals under them. Correcting the data happens in the edit screen and the
 * machinery behind it — the AI run, the company lookup, the payment details —
 * lives in the details screen, so that neither buries what the user came here
 * to look at.
 */

import {
  formatMoney,
  formatQuantity,
  formatUnit,
  type Category,
  type Receipt,
  type ReceiptItem,
  type Tag,
} from '@kvitto/shared';

import { banner, listGroup, row as listRow } from '../components/ui.js';
import { el } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { canShare, haptic, share } from '../core/platform.js';
import { router, type RouteContext } from '../core/router.js';
import { isAiConfigured } from '../core/settings.js';
import { confirmDialog, toast } from '../core/toast.js';
import { parseReceipt } from '../ai/index.js';
import { blobUrl, getBlob } from '../db/blobs.js';
import type { ReceiptBundle } from '../db/queries.js';
import { deleteReceipt, updateReceipt } from '../db/repo.js';
import { receiptScreen } from './receipt-shared.js';

export async function receiptView(context: RouteContext): Promise<HTMLElement> {
  let parsing = false;
  let refreshScreen: () => Promise<void> = async () => {};

  async function runParse(id: string): Promise<void> {
    if (parsing) return;
    parsing = true;
    await refreshScreen();
    const outcome = await parseReceipt(id);
    parsing = false;
    if (outcome.ok) toast('Kvittot tolkades.', { kind: 'success' });
    else if (outcome.error) toast(outcome.error, { kind: 'error' });
    await refreshScreen();
  }

  return receiptScreen(context.segments[1], async ({ bundle, categories }, refresh) => {
    refreshScreen = refresh;
    return render(bundle, categories);
  });

  async function render(bundle: ReceiptBundle, categories: Category[]): Promise<HTMLElement> {
    const { receipt, items } = bundle;
    const imageSrc = await blobUrl(receipt.imageId);
    const imageDetails = imageSrc
      ? el(
          'details',
          { class: 'list-group receipt-image-details' },
          el('summary', {
            class: 'list-group__title',
            style: 'cursor:pointer;color:var(--tint)',
            text: 'Kvittobild',
          }),
          el(
            'div',
            { class: 'pad' },
            el('img', {
              class: 'preview-image',
              src: imageSrc,
              alt: 'Skannat kvitto',
              loading: 'lazy',
            }),
          ),
        )
      : null;

    return el(
      'div',
      { class: 'receipt-detail' },
      renderStatusBanner(receipt, parsing),
      renderPaper(receipt, items),
      renderPaperChips(receipt, bundle.tags, categories),
      el(
        'div',
        { class: 'receipt-primary-actions' },
        receipt.status !== 'confirmed'
          ? el('button', {
              class: 'btn btn--primary grow',
              type: 'button',
              text: 'Allt stämmer',
              on: {
                click: () => {
                  void updateReceipt(receipt.id, { status: 'confirmed' });
                  toast('Markerat som granskat.', { kind: 'success' });
                },
              },
            })
          : el('div', { class: 'receipt-reviewed' }, icon('checkmark', { size: 15, weight: 2.4 }), 'Granskat'),
        imageDetails
          ? el('button', {
              class: 'btn receipt-image-button',
              type: 'button',
              text: 'Bild',
              on: {
                click: () => {
                  imageDetails.open = !imageDetails.open;
                  if (imageDetails.open) imageDetails.scrollIntoView({ behavior: 'smooth', block: 'start' });
                },
              },
            })
          : null,
      ),
      imageDetails,
      renderNavigation(receipt, items),
      renderActions(receipt),
    );
  }

  /**
   * The receipt itself.
   *
   * Every row is printed, however long the receipt is. An archive whose whole
   * point is "what did I actually buy" cannot answer that behind a "+ 24 rader"
   * line, and the rows are cheap: they are text in a flow, not a virtual list.
   */
  function renderPaper(receipt: Receipt, items: ReceiptItem[]): HTMLElement {
    const itemTotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return el(
      'section',
      { class: 'receipt-paper' },
      el('h2', {
        class: 'receipt-paper__merchant',
        text: receipt.merchant.name ?? 'Okänd butik',
      }),
      el('p', {
        class: 'receipt-paper__meta',
        text: [receipt.merchant.city, receipt.merchant.orgNumber ? `ORG ${receipt.merchant.orgNumber}` : null]
          .filter(Boolean)
          .join(' · '),
      }),
      el('p', {
        class: 'receipt-paper__meta receipt-paper__meta--date',
        text: [receipt.purchasedAt?.replace('T', ' ').slice(0, 16), receipt.paymentMethod]
          .filter(Boolean)
          .join(' · '),
      }),
      el(
        'div',
        { class: 'receipt-paper__items' },
        items.length === 0
          ? el('p', { class: 'receipt-paper__empty', text: 'Inga varor registrerade.' })
          : items.map((item) =>
              el(
                'div',
                { class: ['receipt-paper__item', item.isDiscount ? 'receipt-paper__item--discount' : ''] },
                el(
                  'span',
                  {},
                  item.name,
                  item.quantity !== 1 || item.unit !== 'st'
                    ? el('small', { text: ` ${formatQuantity(item.quantity)} ${formatUnit(item.unit)}` })
                    : null,
                ),
                el('span', { text: formatMoney(item.totalPrice, receipt.currency).replace(/\s*kr$/, '') }),
              ),
            ),
      ),
      el(
        'div',
        { class: 'receipt-paper__totals' },
        paperTotalRow('Varor', receipt.subtotal ?? itemTotal, receipt.currency),
        receipt.roundingAmount ? paperTotalRow('Öresavrundning', receipt.roundingAmount, receipt.currency) : null,
        receipt.depositTotal ? paperTotalRow('Varav pant', receipt.depositTotal, receipt.currency) : null,
        el(
          'div',
          { class: 'receipt-paper__pay' },
          el('strong', { text: 'ATT BETALA' }),
          el('strong', { text: formatMoney(receipt.total, receipt.currency).replace(/\s*kr$/, '') }),
        ),
      ),
      // Omitted entirely when there is nothing to print in it, rather than
      // leaving a ruled-off empty strip under the total.
      receipt.vatLines.length > 0 || receipt.status === 'confirmed'
        ? el(
            'div',
            { class: 'receipt-paper__footer' },
            el(
              'div',
              {},
              ...receipt.vatLines.map((line) =>
                el('span', {
                  text: `MOMS ${line.rate}% · ${formatMoney(line.vat, receipt.currency).replace(/\s*kr$/, '')}`,
                }),
              ),
            ),
            receipt.status === 'confirmed'
              ? el('span', { class: 'receipt-paper__status', text: 'GRANSKAT' })
              : null,
          )
        : null,
    );
  }

  function paperTotalRow(label: string, amount: number, currency: string): HTMLElement {
    return el(
      'div',
      { class: 'receipt-paper__total-row' },
      el('span', { text: label }),
      el('span', { text: formatMoney(amount, currency).replace(/\s*kr$/, '') }),
    );
  }

  function renderPaperChips(receipt: Receipt, currentTags: Tag[], categories: Category[]): HTMLElement {
    const receiptCategories = categories.filter((category) => category.scope !== 'item');
    const currentCategory = receiptCategories.find((category) => category.id === receipt.categoryId);
    return el(
      'div',
      { class: 'receipt-paper-chips' },
      currentCategory ? el('span', { class: 'chip chip--active', text: currentCategory.name }) : null,
      ...currentTags.slice(0, 2).map((tag) => el('span', { class: 'chip', text: tag.name })),
      el('button', {
        class: 'chip',
        type: 'button',
        text: '+',
        'aria-label': 'Redigera kategori och etiketter',
        on: { click: () => router.navigate(`/receipt/${receipt.id}/edit`) },
      }),
    );
  }

  function renderStatusBanner(receipt: Receipt, busy: boolean): HTMLElement | null {
    if (busy || receipt.status === 'processing') {
      return el(
        'div',
        { class: 'banner banner--info' },
        el('div', { class: 'spinner', style: 'width:20px;height:20px;flex:none' }),
        el('div', { class: 'banner__body' }, el('strong', { text: 'Tolkar kvittot med AI…' })),
      );
    }
    if (receipt.status === 'failed') {
      return banner({
        tone: 'danger',
        title: 'Tolkningen misslyckades',
        body: receipt.extraction?.error ?? 'Okänt fel.',
      });
    }
    if (receipt.status === 'draft') {
      return banner({
        tone: 'warning',
        title: 'Inte tolkat än',
        body: isAiConfigured()
          ? 'Tryck på "Tolka med AI" nedan, eller fyll i uppgifterna under Redigera.'
          : 'Ställ in en AI-leverantör under Inställningar, eller fyll i uppgifterna under Redigera.',
      });
    }

    const warnings = receipt.extraction?.warnings ?? [];
    if (warnings.length > 0 && receipt.status !== 'confirmed') {
      return banner({
        tone: 'warning',
        title: 'Värt att kontrollera',
        body: el('ul', {}, ...warnings.map((warning) => el('li', { text: warning }))),
      });
    }
    return null;
  }

  /**
   * The way on to the two sub-screens.
   *
   * Both are one tap from the receipt and neither is in front of it: a granskat
   * receipt is something you read, and the rows that would let you rewrite it
   * do not belong underneath it.
   */
  function renderNavigation(receipt: Receipt, items: ReceiptItem[]): HTMLElement {
    return listGroup(
      { footer: 'Detaljer rymmer betalsätt, företagsuppgifter, moms och hur kvittot tolkades.' },
      listRow({
        icon: 'pencil',
        iconColor: 'var(--tint)',
        label: 'Redigera',
        value: items.length === 1 ? '1 vara' : `${items.length} varor`,
        onClick: () => router.navigate(`/receipt/${receipt.id}/edit`),
      }),
      listRow({
        icon: 'info-circle',
        iconColor: 'var(--label-secondary)',
        label: 'Detaljer',
        onClick: () => router.navigate(`/receipt/${receipt.id}/details`),
      }),
    );
  }

  function renderActions(receipt: Receipt): HTMLElement {
    const rows: HTMLElement[] = [];

    // Only while there is nothing parsed yet. Re-running a parse that already
    // produced something is a detail-screen action, next to what it produced.
    if (isAiConfigured() && (receipt.status === 'draft' || receipt.status === 'failed')) {
      rows.push(
        el('button', {
          class: 'row',
          type: 'button',
          style: 'color:var(--tint);justify-content:center;font-weight:600',
          disabled: parsing,
          text: 'Tolka med AI',
          on: { click: () => void runParse(receipt.id) },
        }),
      );
    }

    // The system share sheet, where the platform has one. On iOS this offers
    // Files, Mail, Messages and every share extension the user has installed,
    // which is a better export story than anything the app could build.
    if (canShare()) {
      rows.push(
        el(
          'button',
          {
            class: 'row',
            type: 'button',
            style: 'color:var(--tint);justify-content:center',
            on: { click: () => void shareReceipt(receipt) },
          },
          icon('share', { size: 18 }),
          el('span', { text: 'Dela kvitto' }),
        ),
      );
    }

    rows.push(
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--danger);justify-content:center',
        text: 'Ta bort kvittot',
        on: {
          click: async () => {
            const confirmed = await confirmDialog({
              title: 'Ta bort kvittot?',
              message: 'Kvittot och dess varor tas bort, även på dina andra enheter.',
              confirmLabel: 'Ta bort',
              destructive: true,
            });
            if (!confirmed) return;
            await deleteReceipt(receipt.id);
            toast('Kvittot togs bort.');
            router.navigate('/receipts');
          },
        },
      }),
    );

    return listGroup({}, ...rows);
  }

  /** Hands the receipt to the system share sheet, image included when possible. */
  async function shareReceipt(receipt: Receipt): Promise<void> {
    haptic('impact');
    const merchant = receipt.merchant.name ?? 'Kvitto';
    const summary = [
      merchant,
      receipt.purchasedAt?.slice(0, 10) ?? null,
      receipt.total === null ? null : formatMoney(receipt.total, receipt.currency),
    ]
      .filter(Boolean)
      .join(' · ');

    const files: File[] = [];
    const stored = await getBlob(receipt.imageId);
    if (stored) {
      const extension = stored.mimeType === 'image/png' ? 'png' : 'jpg';
      files.push(
        new File([stored.data], `kvitto-${receipt.purchasedAt?.slice(0, 10) ?? 'odaterat'}.${extension}`, {
          type: stored.mimeType,
        }),
      );
    }

    // Not every platform accepts files; fall back to text rather than failing.
    const withFiles = { title: merchant, text: summary, files };
    const result = canShare(withFiles)
      ? await share(withFiles)
      : await share({ title: merchant, text: summary });

    if (result === 'failed') toast('Kunde inte dela kvittot.', { kind: 'error' });
  }
}
