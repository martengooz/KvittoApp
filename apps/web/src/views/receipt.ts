/**
 * A single receipt: image, parsed header, editable line items, tags.
 *
 * Everything the model produced is editable, because the model will sometimes
 * be wrong and a receipt archive is only worth keeping if it can be corrected.
 * Edits save on blur rather than behind a "save" button, so a correction is
 * never lost by navigating away.
 */

import {
  formatDate,
  formatDateTime,
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

import { banner, emptyState, listGroup, row as listRow } from '../components/ui.js';
import { el, replaceChildren } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { canShare, haptic, share } from '../core/platform.js';
import { bus } from '../core/events.js';
import { router, type RouteContext } from '../core/router.js';
import { isAiConfigured } from '../core/settings.js';
import { confirmDialog, toast } from '../core/toast.js';
import { parseReceipt } from '../ai/index.js';
import { blobUrl, getBlob } from '../db/blobs.js';
import { getReceiptBundle, liveCategories, liveTags, type ReceiptBundle } from '../db/queries.js';
import {
  addItem,
  createTag,
  deleteItem,
  deleteReceipt,
  setReceiptTags,
  updateItem,
  updateReceipt,
} from '../db/repo.js';

const UNITS: ItemUnit[] = ['st', 'kg', 'hg', 'g', 'l', 'dl', 'cl', 'm', 'förp', 'other'];

export async function receiptView(context: RouteContext): Promise<HTMLElement> {
  const id = context.segments[1];
  if (!id) return notFound();

  const root = el('div', {});
  let parsing = false;

  const unsubscribe = bus.on('data:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  async function refresh(): Promise<void> {
    const bundle = await getReceiptBundle(id!);
    if (!bundle) {
      replaceChildren(root, notFound());
      return;
    }
    const [categories, tags] = await Promise.all([liveCategories(), liveTags()]);
    replaceChildren(root, await render(bundle, categories, tags));
  }

  async function runParse(): Promise<void> {
    if (parsing) return;
    parsing = true;
    await refresh();
    const outcome = await parseReceipt(id!);
    parsing = false;
    if (outcome.ok) toast('Kvittot tolkades.', { kind: 'success' });
    else if (outcome.error) toast(outcome.error, { kind: 'error' });
    await refresh();
  }

  async function render(
    bundle: ReceiptBundle,
    categories: Category[],
    tags: Tag[],
  ): Promise<HTMLElement> {
    const { receipt, items } = bundle;
    const imageSrc = await blobUrl(receipt.imageId);

    return el(
      'div',
      {},
      renderStatusBanner(receipt, parsing),
      renderHeader(receipt),
      imageSrc
        ? el(
            'details',
            { class: 'list-group' },
            el('summary', {
              class: 'list-group__title',
              style: 'cursor:pointer;color:var(--tint)',
              text: 'Visa kvittobild',
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
        : null,
      renderFacts(receipt, categories),
      renderTags(receipt.id, bundle.tags, tags),
      renderItems(receipt, items, categories),
      renderTotals(receipt, items),
      renderProvenance(receipt),
      renderActions(receipt),
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
          ? 'Tryck på "Tolka med AI" nedan, eller fyll i uppgifterna själv.'
          : 'Ställ in en AI-leverantör under Inställningar, eller fyll i uppgifterna själv.',
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

  function renderHeader(receipt: Receipt): HTMLElement {
    return el(
      'div',
      { class: 'detail-hero' },
      el('input', {
        class: 'detail-merchant',
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
      receipt.total === null
        ? el('div', { class: 'detail-total muted', text: 'Inget belopp än' })
        : el('div', { class: 'detail-total', text: formatMoney(receipt.total, receipt.currency) }),
    );
  }

  function renderFacts(receipt: Receipt, categories: Category[]): HTMLElement {
    const receiptCategories = categories.filter((category) => category.scope !== 'item');

    return listGroup(
      { title: 'Uppgifter' },
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
        label: 'Betalsätt',
        trailing: el('input', {
          type: 'text',
          value: receipt.paymentMethod ?? '',
          placeholder: 'Kontokort',
          on: {
            change: (event) => {
              const value = (event.target as HTMLInputElement).value.trim() || null;
              void updateReceipt(receipt.id, { paymentMethod: value });
            },
          },
        }),
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
      receipt.merchant.orgNumber
        ? listRow({ label: 'Org.nr', value: receipt.merchant.orgNumber })
        : null,
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

  function renderTotals(receipt: Receipt, items: ReceiptItem[]): HTMLElement | null {
    if (receipt.vatLines.length === 0 && items.length === 0) return null;

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
      receipt.vatLines.length > 0
        ? listGroup(
            { title: 'Moms' },
            el(
              'div',
              { class: 'row table-scroll' },
              el(
                'table',
                { class: 'totals-table' },
                el(
                  'thead',
                  {},
                  el(
                    'tr',
                    {},
                    el('th', { text: 'Moms' }),
                    el('th', { text: 'Netto' }),
                    el('th', { text: 'Moms' }),
                    el('th', { text: 'Brutto' }),
                  ),
                ),
                el(
                  'tbody',
                  {},
                  ...receipt.vatLines.map((line) =>
                    el(
                      'tr',
                      {},
                      el('td', { text: `${line.rate} %` }),
                      el('td', { text: formatMoney(line.net, receipt.currency) }),
                      el('td', { text: formatMoney(line.vat, receipt.currency) }),
                      el('td', { text: formatMoney(line.gross, receipt.currency) }),
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  }

  function renderProvenance(receipt: Receipt): HTMLElement | null {
    const extraction = receipt.extraction;
    if (!extraction) return null;

    return listGroup(
      { title: 'Tolkningsdetaljer' },
      listRow({ label: 'Leverantör', value: extraction.provider }),
      listRow({ label: 'Modell', value: extraction.model }),
      listRow({
        label: 'Tolkat',
        value: formatDateTime(new Date(extraction.at).toISOString().slice(0, 19)),
      }),
      extraction.durationMs !== null
        ? listRow({ label: 'Tid', value: `${extraction.durationMs} ms` })
        : null,
      extraction.inputTokens !== null
        ? listRow({
            label: 'Tokens',
            value: `${extraction.inputTokens} in / ${extraction.outputTokens ?? '?'} ut`,
          })
        : null,
    );
  }

  function renderActions(receipt: Receipt): HTMLElement {
    const rows: HTMLElement[] = [];

    if (isAiConfigured()) {
      rows.push(
        el('button', {
          class: 'row',
          type: 'button',
          style: 'color:var(--tint);justify-content:center;font-weight:600',
          disabled: parsing || receipt.status === 'processing',
          text: receipt.status === 'parsed' || receipt.status === 'confirmed' ? 'Tolka om' : 'Tolka med AI',
          on: { click: () => void runParse() },
        }),
      );
    }

    if (receipt.status !== 'confirmed') {
      rows.push(
        el('button', {
          class: 'row',
          type: 'button',
          style: 'color:var(--tint);justify-content:center',
          text: 'Markera som granskat',
          on: {
            click: () => {
              void updateReceipt(receipt.id, { status: 'confirmed' });
              toast('Markerat som granskat.', { kind: 'success' });
            },
          },
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
      formatDate(receipt.purchasedAt),
      receipt.total === null ? null : formatMoney(receipt.total, receipt.currency),
    ]
      .filter(Boolean)
      .join(' · ');

    const files: File[] = [];
    const stored = await getBlob(receipt.imageId);
    if (stored) {
      const extension = stored.mimeType === 'image/png' ? 'png' : 'jpg';
      files.push(
        new File([stored.data], `kvitto-${formatDate(receipt.purchasedAt)}.${extension}`, {
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

  await refresh();
  return root;
}

// --- small helpers --------------------------------------------------------

function labelled(label: string, control: HTMLElement): HTMLElement {
  return el('label', { style: 'display:block' }, el('span', { class: 'field__label', text: label }), control);
}

/**
 * A text input that accepts Swedish money formatting and normalises on blur, so
 * `12,50`, `12.50` and `12 kr` all work.
 */
function moneyInput(value: number | null, onCommit: (value: number | null) => Promise<void> | void): HTMLElement {
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

function notFound(): HTMLElement {
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
