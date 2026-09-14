/**
 * The secondary details of one receipt: `#/receipt/:id/details`.
 *
 * Everything that is true about the receipt without being the receipt: how it
 * was paid, which company the shop turned out to be, the VAT table, what the
 * on-device reading found and which model produced the data. All of it is worth
 * keeping and none of it is worth scrolling past on the way to the line items,
 * so it lives one tap behind the receipt rather than under it.
 */

import {
  formatDateTime,
  formatMoney,
  formatRelativeTime,
  type Company,
  type Receipt,
} from '@kvitto/shared';

import { listGroup, row as listRow } from '../components/ui.js';
import { el } from '../core/dom.js';
import { router, type RouteContext } from '../core/router.js';
import { isAiConfigured } from '../core/settings.js';
import { toast } from '../core/toast.js';
import { parseReceipt } from '../ai/index.js';
import { enrichReceipt, verifyCompanyName } from '../ocr/enrich.js';
import type { ReceiptBundle } from '../db/queries.js';
import { updateReceipt } from '../db/repo.js';
import { receiptCrumb, receiptScreen } from './receipt-shared.js';

const STATUS_LABELS: Record<Receipt['status'], string> = {
  draft: 'Inte tolkat',
  processing: 'Tolkas',
  parsed: 'Tolkat',
  failed: 'Tolkningen misslyckades',
  confirmed: 'Granskat',
};

const SOURCE_LABELS: Record<Receipt['source'], string> = {
  camera: 'Kamera',
  upload: 'Uppladdad bild',
  manual: 'Inskrivet för hand',
};

export async function receiptDetailsView(context: RouteContext): Promise<HTMLElement> {
  let reading = false;
  let parsing = false;
  let refreshScreen: () => Promise<void> = async () => {};

  /**
   * Re-reads the stored image and re-links the company.
   *
   * Offered as an explicit action as well as running after a scan, because a
   * receipt saved before OCR existed has no reading at all, and because a user
   * who has just pasted an API key wants the lookup now.
   */
  async function runEnrich(id: string): Promise<void> {
    if (reading) return;
    reading = true;
    await refreshScreen();
    try {
      const outcome = await enrichReceipt(id);
      if (!outcome.ok) {
        toast(outcome.reason ?? 'Kvittot kunde inte läsas av.', { kind: 'error' });
      } else if (outcome.company) {
        toast(`Företag: ${outcome.company.name}`, { kind: 'success' });
      } else {
        toast(describeLookup(outcome.lookupReason), { kind: 'info' });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Avläsningen misslyckades.', { kind: 'error' });
    } finally {
      reading = false;
      await refreshScreen();
    }
  }

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

  return receiptScreen(context.segments[1], ({ bundle }, refresh) => {
    refreshScreen = refresh;
    return render(bundle);
  });

  function render(bundle: ReceiptBundle): HTMLElement {
    const { receipt } = bundle;
    return el(
      'div',
      { class: 'receipt-details' },
      receiptCrumb(receipt),
      renderPayment(receipt),
      renderSlip(receipt),
      renderVat(receipt),
      renderCompany(receipt, bundle.company),
      renderReading(receipt),
      renderExtraction(receipt),
      renderRecord(receipt),
    );
  }

  function renderPayment(receipt: Receipt): HTMLElement {
    return listGroup(
      { title: 'Betalning' },
      listRow({
        label: 'Betalsätt',
        trailing: el('input', {
          type: 'text',
          value: receipt.paymentMethod ?? '',
          placeholder: 'Kontokort',
          'aria-label': 'Betalsätt',
          on: {
            change: (event) => {
              const value = (event.target as HTMLInputElement).value.trim() || null;
              void updateReceipt(receipt.id, { paymentMethod: value });
            },
          },
        }),
      }),
      receipt.cardLast4 ? listRow({ label: 'Kort', value: `•••• ${receipt.cardLast4}` }) : null,
      listRow({ label: 'Valuta', value: receipt.currency }),
      listRow({ label: 'Att betala', value: formatMoney(receipt.total, receipt.currency) }),
    );
  }

  /** What the slip itself printed about the shop and the till. */
  function renderSlip(receipt: Receipt): HTMLElement | null {
    const { merchant } = receipt;
    const address = [merchant.address, [merchant.postalCode, merchant.city].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(', ');

    const rows = [
      merchant.name ? listRow({ label: 'Butik', value: merchant.name }) : null,
      address ? listRow({ label: 'Adress', value: address }) : null,
      merchant.phone ? listRow({ label: 'Telefon', value: merchant.phone }) : null,
      merchant.orgNumber ? listRow({ label: 'Org.nr', value: merchant.orgNumber }) : null,
      merchant.vatNumber ? listRow({ label: 'Momsreg.nr', value: merchant.vatNumber }) : null,
      merchant.storeId ? listRow({ label: 'Butiksnummer', value: merchant.storeId }) : null,
      receipt.receiptNumber ? listRow({ label: 'Kvittonummer', value: receipt.receiptNumber }) : null,
      receipt.terminalId ? listRow({ label: 'Kassa', value: receipt.terminalId }) : null,
      receipt.cashier ? listRow({ label: 'Kassör', value: receipt.cashier }) : null,
    ].filter((row): row is HTMLElement => row !== null);

    if (rows.length === 0) return null;
    return listGroup({ title: 'Tryckt på kvittot' }, ...rows);
  }

  function renderVat(receipt: Receipt): HTMLElement | null {
    if (receipt.vatLines.length === 0) return null;

    return listGroup(
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
    );
  }

  /**
   * The registry company, and how much to trust the link.
   *
   * Only the basics are shown. The full registry payload is stored on the
   * record — a later feature can use it without a second lookup — but a receipt
   * archive is not a company-register browser, so this stays to the handful of
   * fields that tell the user *which* company this is.
   */
  function renderCompany(receipt: Receipt, company: Company | null): HTMLElement | null {
    const orgNumber = receipt.merchant.orgNumber;
    if (!company) {
      if (!orgNumber) return null;
      return listGroup(
        { title: 'Företag', footer: companyFooter(receipt) },
        listRow({ label: 'Org.nr', value: orgNumber }),
        el('button', {
          class: 'row',
          type: 'button',
          style: 'color:var(--tint);justify-content:center',
          disabled: reading,
          text: reading ? 'Läser…' : 'Hämta företagsuppgifter',
          on: { click: () => void runEnrich(receipt.id) },
        }),
      );
    }

    const verdict = verifyCompanyName(company, receipt.ocr);
    return listGroup(
      { title: 'Företag', footer: companyFooter(receipt) },
      listRow({ label: 'Namn', value: company.name }),
      listRow({ label: 'Org.nr', value: company.orgNumber }),
      company.legalForm ? listRow({ label: 'Bolagsform', value: company.legalForm }) : null,
      company.status ? listRow({ label: 'Status', value: company.status }) : null,
      company.city ? listRow({ label: 'Ort', value: company.city }) : null,
      company.industry ? listRow({ label: 'Bransch', value: company.industry }) : null,
      listRow({ label: 'Hittat via', value: identifiedBy(receipt, company) }),
      renderNameCheck(company, verdict),
    );
  }

  /**
   * Whether the registered name actually appears on the paper.
   *
   * This is the check that catches a misread organisation number whose digits
   * happen to satisfy the checksum: the registry will answer for *some*
   * company, and the only thing that says it is the right one is its name
   * turning up in the receipt's own text.
   */
  function renderNameCheck(
    company: Company,
    verdict: ReturnType<typeof verifyCompanyName>,
  ): HTMLElement {
    const score = verdict?.score ?? company.nameMatchScore;
    const confirmed = verdict?.confirmed ?? company.nameConfirmed;

    if (score === null || score === undefined) {
      return listRow({ label: 'Namnkontroll', value: 'Ej kontrollerat' });
    }

    const percent = `${Math.round(score * 100)} %`;
    return listRow({
      label: 'Namnkontroll',
      trailing: el('span', {
        class: 'row__value',
        style: `color:var(--${confirmed ? 'success' : 'warning'})`,
        text: confirmed ? `Hittat på kvittot · ${percent}` : `Osäker träff · ${percent}`,
      }),
    });
  }

  /**
   * How this company was arrived at.
   *
   * Worth showing, because the two routes carry very different weight: an
   * organisation number is checksum-verified, a name is a substring search that
   * happened to agree with the receipt.
   */
  function identifiedBy(receipt: Receipt, company: Company): string {
    const read = receipt.ocr?.orgNumbers.some((candidate) => candidate.value === company.orgNumber);
    return read ? 'Organisationsnummer på kvittot' : 'Sökning på butikens namn';
  }

  function companyFooter(receipt: Receipt): string | undefined {
    const ocr = receipt.ocr;
    if (!ocr) return 'Kvittots text har inte lästs av på den här enheten.';
    const best = ocr.orgNumbers[0];
    if (best?.repaired) {
      return 'Organisationsnumret behövde teckenrättas för att gå ihop — kontrollera det mot kvittot.';
    }
    return undefined;
  }

  function renderReading(receipt: Receipt): HTMLElement | null {
    const ocr = receipt.ocr;
    if (!ocr) {
      if (!receipt.imageId) return null;
      return listGroup(
        { title: 'Avläsning på enheten', footer: 'Texten läses av lokalt och lämnar aldrig enheten.' },
        el('button', {
          class: 'row',
          type: 'button',
          style: 'color:var(--tint);justify-content:center',
          disabled: reading,
          text: reading ? 'Läser…' : 'Läs av kvittot på enheten',
          on: { click: () => void runEnrich(receipt.id) },
        }),
      );
    }

    return listGroup(
      { title: 'Avläsning på enheten' },
      listRow({ label: 'Textsäkerhet', value: `${ocr.confidence} %` }),
      listRow({ label: 'Motor', value: ocr.engine }),
      listRow({
        label: 'Läst',
        value: formatDateTime(new Date(ocr.at).toISOString().slice(0, 19)),
      }),
      ocr.durationMs !== null ? listRow({ label: 'Tid', value: `${ocr.durationMs} ms` }) : null,
      ocr.orgNumbers.length > 1
        ? listRow({
            label: 'Fler org.nr',
            value: ocr.orgNumbers.slice(1).map((candidate) => candidate.value).join(', '),
          })
        : null,
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center',
        disabled: reading,
        text: reading ? 'Läser…' : 'Läs av kvittot igen',
        on: { click: () => void runEnrich(receipt.id) },
      }),
    );
  }

  function renderExtraction(receipt: Receipt): HTMLElement | null {
    const extraction = receipt.extraction;
    const reparse = isAiConfigured()
      ? el('button', {
          class: 'row',
          type: 'button',
          style: 'color:var(--tint);justify-content:center',
          disabled: parsing || receipt.status === 'processing',
          text: parsing ? 'Tolkar…' : extraction ? 'Tolka om' : 'Tolka med AI',
          on: { click: () => void runParse(receipt.id) },
        })
      : null;

    if (!extraction) {
      if (!reparse) return null;
      return listGroup(
        { title: 'AI-tolkning', footer: 'Kvittot har inte tolkats av någon modell än.' },
        reparse,
      );
    }

    return listGroup(
      {
        title: 'AI-tolkning',
        footer: 'En ny tolkning skriver över uppgifterna, även dina egna rättelser.',
      },
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
      extraction.warnings.length > 0
        ? el(
            'div',
            { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:4px' },
            el('span', { class: 'field__label', style: 'margin:0', text: 'Anmärkningar' }),
            el(
              'ul',
              { class: 'faint', style: 'margin:0;padding-left:18px' },
              ...extraction.warnings.map((warning) => el('li', { text: warning })),
            ),
          )
        : null,
      extraction.error ? listRow({ label: 'Fel', value: extraction.error }) : null,
      reparse,
    );
  }

  /** The record itself: where it came from and whether it has reached the server. */
  function renderRecord(receipt: Receipt): HTMLElement {
    const sync =
      receipt.dirty === 1
        ? 'Väntar på synk'
        : receipt.rev === 0
          ? 'Inte synkat'
          : `Synkat · rev ${receipt.rev}`;

    return listGroup(
      { title: 'Om posten' },
      listRow({ label: 'Status', value: STATUS_LABELS[receipt.status] }),
      listRow({ label: 'Källa', value: SOURCE_LABELS[receipt.source] }),
      listRow({ label: 'Ändrad', value: formatRelativeTime(receipt.updatedAt) }),
      listRow({ label: 'Synk', value: sync }),
      listRow({
        label: 'Bild',
        value: receipt.imageId ? `${receipt.imageId.slice(0, 10)}…` : 'Ingen',
      }),
      listRow({
        label: 'Redigera uppgifterna',
        onClick: () => router.navigate(`/receipt/${receipt.id}/edit`),
      }),
    );
  }
}

/** Turns a skipped lookup into something the user can act on. */
function describeLookup(reason: string | null): string {
  switch (reason) {
    case 'not-configured':
      return 'Inget företagsuppslag gjordes — lägg in en API-nyckel under Inställningar.';
    case 'invalid-org-number':
      return 'Inget giltigt organisationsnummer hittades på kvittot.';
    case 'not-found':
      return 'Varken organisationsnummer eller butiksnamn gav någon träff i registret.';
    case 'no-query':
      return 'Inget läsbart butiksnamn hittades att söka på.';
    case 'budget-spent':
      return 'Dagens namnsökningar är slut. Höj gränsen under Inställningar eller försök imorgon.';
    case 'unauthorised':
      return 'API-nyckeln för företagsuppslag avvisades.';
    case 'rate-limited':
      return 'Kvoten för företagsuppslag är slut. Försök igen senare.';
    case 'offline':
      return 'Kunde inte nå företagsregistret. Försök igen när du är uppkopplad.';
    case 'unavailable':
      return 'Företagsregistret svarade inte som väntat.';
    default:
      return 'Kvittot lästes av, men inget företag kunde kopplas.';
  }
}
