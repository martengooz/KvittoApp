/**
 * A single receipt: image, parsed header, editable line items, tags.
 *
 * Everything the model produced is editable, because the model will sometimes
 * be wrong and a receipt archive is only worth keeping if it can be corrected.
 * Edits save on blur rather than behind a "save" button, so a correction is
 * never lost by navigating away.
 */

import {
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

import { el, replaceChildren } from '../core/dom.js';
import { bus } from '../core/events.js';
import { router, type RouteContext } from '../core/router.js';
import { isAiConfigured } from '../core/settings.js';
import { confirmDialog, toast } from '../core/toast.js';
import { parseReceipt } from '../ai/index.js';
import { blobUrl } from '../db/blobs.js';
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
            { class: 'section' },
            el('summary', { class: 'section__title', text: 'Kvittobild' }),
            el('img', { class: 'preview-image', src: imageSrc, alt: 'Skannat kvitto', loading: 'lazy' }),
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
        el('div', { class: 'spinner', style: 'width:18px;height:18px;border-width:2px' }),
        el('div', { class: 'banner__body', text: 'Tolkar kvittot med AI…' }),
      );
    }
    if (receipt.status === 'failed') {
      return el(
        'div',
        { class: 'banner banner--danger' },
        el('span', { 'aria-hidden': 'true', text: '⚠️' }),
        el(
          'div',
          { class: 'banner__body' },
          el('strong', { text: 'Tolkningen misslyckades' }),
          el('p', { text: receipt.extraction?.error ?? 'Okänt fel.' }),
        ),
      );
    }
    if (receipt.status === 'draft') {
      return el(
        'div',
        { class: 'banner banner--warning' },
        el('span', { 'aria-hidden': 'true', text: '📝' }),
        el(
          'div',
          { class: 'banner__body' },
          el('strong', { text: 'Inte tolkat än' }),
          el('p', {
            text: isAiConfigured()
              ? 'Tryck på "Tolka med AI" nedan, eller fyll i uppgifterna själv.'
              : 'Ställ in en AI-leverantör under Inställningar, eller fyll i uppgifterna själv.',
          }),
        ),
      );
    }

    const warnings = receipt.extraction?.warnings ?? [];
    if (warnings.length > 0 && receipt.status !== 'confirmed') {
      return el(
        'div',
        { class: 'banner banner--warning' },
        el('span', { 'aria-hidden': 'true', text: '🔍' }),
        el(
          'div',
          { class: 'banner__body' },
          el('strong', { text: 'Värt att kontrollera' }),
          el('ul', { style: 'margin:0.3rem 0 0;padding-left:1.1rem' }, ...warnings.map((warning) => el('li', { text: warning }))),
        ),
      );
    }
    return null;
  }

  function renderHeader(receipt: Receipt): HTMLElement {
    return el(
      'div',
      { class: 'detail-hero' },
      el('input', {
        type: 'text',
        value: receipt.merchant.name ?? '',
        placeholder: 'Butikens namn',
        'aria-label': 'Butik',
        style: 'font-size:1.15rem;font-weight:600',
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

    return el(
      'section',
      { class: 'section' },
      el('h2', { class: 'section__title', text: 'Uppgifter' }),
      el(
        'div',
        { class: 'card card--pad' },
        field('Datum', el('input', {
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
        })),
        field('Totalt', moneyInput(receipt.total, (value) => updateReceipt(receipt.id, { total: value }))),
        field('Öresavrundning', moneyInput(receipt.roundingAmount, (value) =>
          updateReceipt(receipt.id, { roundingAmount: value }),
        )),
        field('Betalsätt', el('input', {
          type: 'text',
          value: receipt.paymentMethod ?? '',
          placeholder: 'Kontokort, Swish, kontant…',
          on: {
            change: (event) => {
              const value = (event.target as HTMLInputElement).value.trim() || null;
              void updateReceipt(receipt.id, { paymentMethod: value });
            },
          },
        })),
        field('Kategori', el(
          'select',
          {
            on: {
              change: (event) => {
                const value = (event.target as HTMLSelectElement).value || null;
                void updateReceipt(receipt.id, { categoryId: value });
              },
            },
          },
          el('option', { value: '', text: '— ingen —', selected: receipt.categoryId === null }),
          ...receiptCategories.map((category) =>
            el('option', {
              value: category.id,
              text: `${category.icon ?? ''} ${category.name}`.trim(),
              selected: receipt.categoryId === category.id,
            }),
          ),
        )),
        field('Anteckning', el('textarea', {
          value: receipt.notes ?? '',
          placeholder: 'Egna anteckningar…',
          rows: 2,
          on: {
            change: (event) => {
              const value = (event.target as HTMLTextAreaElement).value.trim() || null;
              void updateReceipt(receipt.id, { notes: value });
            },
          },
        })),
        receipt.merchant.orgNumber
          ? el('p', { class: 'faint', text: `Org.nr ${receipt.merchant.orgNumber}` })
          : null,
      ),
    );
  }

  function renderTags(receiptId: string, current: Tag[], all: Tag[]): HTMLElement {
    const selected = new Set(current.map((tag) => tag.id));

    return el(
      'section',
      { class: 'section' },
      el('h2', { class: 'section__title', text: 'Etiketter och samlingar' }),
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
          text: '+ Ny etikett',
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
      { class: 'section' },
      el(
        'div',
        { class: 'row row--between' },
        el('h2', { class: 'section__title', style: 'margin:0', text: `Varor (${items.length})` }),
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          text: '+ Lägg till rad',
          on: { click: () => void addItem(receipt.id) },
        }),
      ),
      items.length === 0
        ? el('p', { class: 'muted', text: 'Inga varor registrerade på det här kvittot.' })
        : el('div', { class: 'list' }, ...items.map((item) => renderItem(item, itemCategories))),
    );
  }

  function renderItem(item: ReceiptItem, categories: Category[]): HTMLElement {
    return el(
      'div',
      { class: 'item-editor' },
      el(
        'div',
        { class: 'row' },
        el('input', {
          class: 'grow',
          type: 'text',
          value: item.name,
          'aria-label': 'Varunamn',
          on: {
            change: (event) => {
              void updateItem(item.id, { name: (event.target as HTMLInputElement).value.trim() || 'Namnlös' });
            },
          },
        }),
        el('button', {
          class: 'btn btn--ghost btn--sm btn--icon',
          type: 'button',
          'aria-label': `Ta bort ${item.name}`,
          text: '🗑',
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
        }),
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
      'section',
      { class: 'section' },
      el('h2', { class: 'section__title', text: 'Summering' }),
      el(
        'div',
        { class: 'card card--pad' },
        el(
          'div',
          { class: 'kv-list' },
          kv('Varor', formatMoney(linesTotal, receipt.currency)),
          receipt.discountTotal ? kv('Rabatt', formatMoney(-receipt.discountTotal, receipt.currency)) : null,
          receipt.roundingAmount ? kv('Öresavrundning', formatMoney(receipt.roundingAmount, receipt.currency)) : null,
          receipt.depositTotal ? kv('Varav pant', formatMoney(receipt.depositTotal, receipt.currency)) : null,
          kv('Att betala', formatMoney(receipt.total, receipt.currency)),
        ),
        mismatch
          ? el('p', {
              class: 'banner banner--warning',
              style: 'margin:0.75rem 0 0',
              text: `Raderna summerar till ${formatMoney(expected, receipt.currency)}, ` +
                `${formatMoney(Math.abs(difference), receipt.currency)} ifrån totalen.`,
            })
          : null,
        receipt.vatLines.length > 0
          ? el(
              'div',
              { class: 'table-scroll', style: 'margin-top:0.75rem' },
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
            )
          : null,
      ),
    );
  }

  function renderProvenance(receipt: Receipt): HTMLElement | null {
    const extraction = receipt.extraction;
    if (!extraction) return null;

    return el(
      'details',
      { class: 'section' },
      el('summary', { class: 'section__title', text: 'Tolkningsdetaljer' }),
      el(
        'div',
        { class: 'card card--pad kv-list' },
        kv('Leverantör', extraction.provider),
        kv('Modell', extraction.model),
        kv('Tolkat', formatDateTime(new Date(extraction.at).toISOString().slice(0, 19))),
        extraction.durationMs !== null ? kv('Tid', `${extraction.durationMs} ms`) : null,
        extraction.inputTokens !== null
          ? kv('Tokens', `${extraction.inputTokens} in / ${extraction.outputTokens ?? '?'} ut`)
          : null,
      ),
    );
  }

  function renderActions(receipt: Receipt): HTMLElement {
    return el(
      'section',
      { class: 'section' },
      el(
        'div',
        { class: 'row row--wrap' },
        isAiConfigured()
          ? el('button', {
              class: 'btn btn--primary grow',
              type: 'button',
              disabled: parsing || receipt.status === 'processing',
              text: receipt.status === 'parsed' || receipt.status === 'confirmed' ? 'Tolka om' : 'Tolka med AI',
              on: { click: () => void runParse() },
            })
          : null,
        receipt.status !== 'confirmed'
          ? el('button', {
              class: 'btn btn--ghost grow',
              type: 'button',
              text: '✓ Markera som granskat',
              on: {
                click: () => {
                  void updateReceipt(receipt.id, { status: 'confirmed' });
                  toast('Markerat som granskat.', { kind: 'success' });
                },
              },
            })
          : el('span', { class: 'pill pill--success', text: '✓ Granskat' }),
      ),
      el('button', {
        class: 'btn btn--ghost btn--block',
        type: 'button',
        style: 'margin-top:0.75rem;color:var(--danger)',
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
  }

  await refresh();
  return root;
}

// --- small helpers --------------------------------------------------------

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), control);
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  return el('label', { style: 'display:block' }, el('span', { class: 'field__label', text: label }), control);
}

function kv(key: string, value: string): HTMLElement {
  return el('div', { class: 'kv' }, el('span', { class: 'kv__key', text: key }), el('span', { class: 'kv__value', text: value }));
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
  return el(
    'div',
    { class: 'empty-state' },
    el('div', { class: 'empty-state__icon', 'aria-hidden': 'true', text: '🤷' }),
    el('p', { class: 'empty-state__title', text: 'Kvittot hittades inte' }),
    el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: 'Till kvittolistan',
      on: { click: () => router.navigate('/receipts') },
    }),
  );
}
