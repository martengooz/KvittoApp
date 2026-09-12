/**
 * The contract between the app and whichever AI model reads the receipt.
 *
 * {@link RECEIPT_JSON_SCHEMA} is handed to providers that support structured
 * output (Anthropic tool use, OpenAI `json_schema`, Ollama `format`). Models
 * that only speak prose get the same shape described in the prompt. Either way
 * the response goes through {@link normalizeExtraction}, which is written to
 * assume nothing about how well the model followed instructions.
 */

import {
  normalizeOrgNumber,
  normalizeSearchName,
  normalizeVatNumber,
  parseAmount,
  parseLocalDateTime,
  parseQuantity,
  roundMoney,
} from './parse.js';
import { emptyMerchant, type ItemUnit, type Merchant, type VatLine } from './types.js';

/** Whatever the model returned, before any coercion. */
export type RawExtraction = Record<string, unknown>;

/** A normalised, ready-to-store extraction result. */
export interface NormalizedExtraction {
  merchant: Merchant;
  purchasedAt: string | null;
  currency: string;
  total: number | null;
  subtotal: number | null;
  discountTotal: number | null;
  roundingAmount: number | null;
  depositTotal: number | null;
  vatLines: VatLine[];
  paymentMethod: string | null;
  cardLast4: string | null;
  receiptNumber: string | null;
  terminalId: string | null;
  cashier: string | null;
  items: NormalizedItem[];
  /** Model-reported confidence in 0..1, when offered. */
  confidence: number | null;
  warnings: string[];
}

export interface NormalizedItem {
  name: string;
  rawName: string | null;
  searchName: string;
  quantity: number;
  unit: ItemUnit;
  unitPrice: number | null;
  totalPrice: number;
  discount: number | null;
  vatRate: number | null;
  ean: string | null;
  deposit: number | null;
  isDeposit: boolean;
  isDiscount: boolean;
}

const VALID_UNITS: ReadonlySet<string> = new Set<ItemUnit>([
  'st', 'kg', 'hg', 'g', 'l', 'dl', 'cl', 'm', 'förp', 'other',
]);

/** Words that mark a line as a bottle/can deposit rather than a product. */
const DEPOSIT_PATTERN = /\bpant\b/i;
/** Words Swedish stores print on discount lines. */
const DISCOUNT_PATTERN =
  /(rabatt|prisneds[äa]ttning|kampanj|erbjudande|extrapris|stammis|medlemspris|klubbpris|avdrag|\brea\b|prisjustering)/i;

/** `{ "type": ["string", "null"] }` — the shape every optional text field takes. */
const nullableString = { type: ['string', 'null'] } as const;

/**
 * JSON Schema describing the extraction result.
 *
 * Handed to providers that support structured output (Anthropic
 * `output_config.format`, OpenAI `json_schema`, Ollama `format`). Two
 * deliberate choices:
 *
 * 1. **Every amount is a string.** The model transcribes what is printed
 *    (`"1 234,50"`, `"25,00-"`) and {@link normalizeExtraction} converts it with
 *    the Swedish number parser. Asking a model to also do locale conversion is
 *    where silent off-by-100 errors come from, and a string round-trips the
 *    printed form exactly.
 * 2. **Strict-mode friendly.** Every property is listed in `required` and every
 *    object sets `additionalProperties: false`, because strict structured-output
 *    modes reject schemas that do not. Optionality is expressed as a `null`
 *    union instead.
 */
export const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'merchant', 'purchasedAt', 'currency', 'total', 'subtotal', 'discountTotal',
    'roundingAmount', 'depositTotal', 'vatLines', 'paymentMethod', 'cardLast4',
    'receiptNumber', 'terminalId', 'cashier', 'items', 'confidence',
  ],
  properties: {
    merchant: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'orgNumber', 'vatNumber', 'address', 'postalCode', 'city', 'country', 'phone', 'storeId'],
      properties: {
        name: { ...nullableString, description: 'Store name, e.g. "ICA Kvantum Emporia".' },
        orgNumber: { ...nullableString, description: 'Swedish organisationsnummer as printed.' },
        vatNumber: { ...nullableString, description: 'Momsregistreringsnummer.' },
        address: nullableString,
        postalCode: nullableString,
        city: nullableString,
        country: nullableString,
        phone: nullableString,
        storeId: { ...nullableString, description: 'Butiks- or kassanummer.' },
      },
    },
    purchasedAt: {
      ...nullableString,
      description: 'Date and time exactly as printed, e.g. "2024-03-15 14:22" or "15/3-24".',
    },
    currency: { ...nullableString, description: 'ISO 4217 code. "SEK" unless the receipt says otherwise.' },
    total: { ...nullableString, description: 'Att betala — the amount actually paid, as printed.' },
    subtotal: { ...nullableString, description: 'Sum before receipt-level discounts, as printed.' },
    discountTotal: { ...nullableString, description: 'Receipt-level discount total, as printed.' },
    roundingAmount: { ...nullableString, description: 'Öresavrundning, as printed. May be negative.' },
    depositTotal: { ...nullableString, description: 'Total pant on the receipt, as printed.' },
    vatLines: {
      type: 'array',
      description: 'One entry per row of the Moms/VAT summary table. Empty array if there is none.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rate', 'net', 'vat', 'gross'],
        properties: {
          rate: { type: 'string', description: 'Percentage as printed, e.g. "12" or "12,00".' },
          net: { ...nullableString, description: 'Netto column.' },
          vat: { ...nullableString, description: 'Moms column.' },
          gross: { ...nullableString, description: 'Brutto column.' },
        },
      },
    },
    paymentMethod: {
      ...nullableString,
      description: 'e.g. "Kontokort", "Swish", "Kontant", "Presentkort".',
    },
    cardLast4: { ...nullableString, description: 'Last four digits of the card, if shown.' },
    receiptNumber: nullableString,
    terminalId: { ...nullableString, description: 'Kassa or terminal identifier.' },
    cashier: nullableString,
    items: {
      type: 'array',
      description: 'Every printed line, in order, including pant and discount rows.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'rawName', 'quantity', 'unit', 'unitPrice', 'totalPrice', 'discount', 'vatRate', 'ean', 'deposit'],
        properties: {
          name: {
            type: 'string',
            description: 'Product name with obvious abbreviations expanded, e.g. "MJÖLK MELLAN 1,5%" → "Mjölk mellan 1,5 %".',
          },
          rawName: { ...nullableString, description: 'The line exactly as printed.' },
          quantity: { ...nullableString, description: 'As printed, e.g. "2" or "0,412".' },
          unit: { ...nullableString, description: 'One of st, kg, hg, g, l, dl, cl, m, förp.' },
          unitPrice: { ...nullableString, description: 'Price per unit before discount, as printed.' },
          totalPrice: {
            type: 'string',
            description: 'What this line contributed to the total, as printed. Negative for discounts.',
          },
          discount: { ...nullableString, description: 'Discount applied to this line, as printed.' },
          vatRate: { ...nullableString, description: 'VAT percentage for this line, if shown.' },
          ean: { ...nullableString, description: 'EAN/GTIN barcode digits, if printed.' },
          deposit: { ...nullableString, description: 'Pant on this line, if broken out.' },
        },
      },
    },
    confidence: {
      type: ['number', 'null'],
      description: 'How confident you are that the whole receipt was read correctly, 0..1.',
    },
  },
} as const;

/**
 * Coerces an arbitrary model response into {@link NormalizedExtraction}.
 * Never throws: anything unusable becomes a warning and a `null`.
 */
export function normalizeExtraction(raw: RawExtraction): NormalizedExtraction {
  const warnings: string[] = [];
  const merchant = normalizeMerchant(pickObject(raw, 'merchant', 'store', 'seller'));

  const currencyRaw = pickString(raw, 'currency');
  const currency = currencyRaw && /^[A-Za-z]{3}$/.test(currencyRaw)
    ? currencyRaw.toUpperCase()
    : 'SEK';

  const purchasedAtRaw =
    pickString(raw, 'purchasedAt', 'purchased_at', 'date', 'datetime', 'dateTime');
  const purchasedAt = parseLocalDateTime(purchasedAtRaw);
  if (purchasedAtRaw && !purchasedAt) {
    warnings.push(`Could not read the purchase date from "${purchasedAtRaw}".`);
  }

  const items = normalizeItems(pickArray(raw, 'items', 'lineItems', 'line_items', 'products'), warnings);
  const vatLines = normalizeVatLines(pickArray(raw, 'vatLines', 'vat_lines', 'vat', 'moms'));

  let total = parseAmount(pickUnknown(raw, 'total', 'totalAmount', 'amountPaid', 'attBetala'));
  const subtotal = parseAmount(pickUnknown(raw, 'subtotal', 'sum', 'netTotal'));
  const roundingAmount = parseAmount(pickUnknown(raw, 'roundingAmount', 'rounding', 'oresavrundning'));

  const discountRaw = parseAmount(pickUnknown(raw, 'discountTotal', 'discount', 'totalDiscount'));
  const discountTotal = discountRaw === null ? null : Math.abs(discountRaw);

  let depositTotal = parseAmount(pickUnknown(raw, 'depositTotal', 'deposit', 'pant'));
  if (depositTotal === null) {
    const fromLines = items
      .filter((item) => item.isDeposit)
      .reduce((sum, item) => sum + item.totalPrice, 0);
    depositTotal = fromLines === 0 ? null : roundMoney(fromLines);
  }

  // A missing total is recoverable: the VAT table's gross column, or the line
  // items, both add up to the same number on a well-formed receipt.
  if (total === null) {
    const grossSum = vatLines.reduce((sum, line) => sum + (line.gross ?? 0), 0);
    if (grossSum > 0) {
      total = roundMoney(grossSum);
      warnings.push('Total was missing; derived it from the VAT summary.');
    } else if (items.length > 0) {
      total = roundMoney(items.reduce((sum, item) => sum + item.totalPrice, 0));
      warnings.push('Total was missing; derived it by summing the line items.');
    } else {
      warnings.push('No total could be found on this receipt.');
    }
  }

  const confidenceRaw = pickUnknown(raw, 'confidence');
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : null;

  return {
    merchant,
    purchasedAt,
    currency,
    total,
    subtotal,
    discountTotal,
    roundingAmount,
    depositTotal,
    vatLines,
    paymentMethod: pickString(raw, 'paymentMethod', 'payment_method', 'payment'),
    cardLast4: normalizeLast4(pickString(raw, 'cardLast4', 'card_last4', 'cardNumber')),
    receiptNumber: pickString(raw, 'receiptNumber', 'receipt_number', 'kvittonummer'),
    terminalId: pickString(raw, 'terminalId', 'terminal', 'kassa'),
    cashier: pickString(raw, 'cashier', 'kassör', 'kassor'),
    items,
    confidence,
    warnings,
  };
}

function normalizeMerchant(source: Record<string, unknown> | null): Merchant {
  const merchant = emptyMerchant();
  if (!source) return merchant;
  merchant.name = pickString(source, 'name', 'merchant', 'store', 'storeName');
  merchant.orgNumber = normalizeOrgNumber(pickString(source, 'orgNumber', 'org_number', 'orgnr'));
  merchant.vatNumber = normalizeVatNumber(pickString(source, 'vatNumber', 'vat_number', 'momsnr'));
  merchant.address = pickString(source, 'address', 'street');
  merchant.postalCode = pickString(source, 'postalCode', 'postal_code', 'zip');
  merchant.city = pickString(source, 'city', 'town', 'ort');
  merchant.country = pickString(source, 'country');
  merchant.phone = pickString(source, 'phone', 'tel', 'telefon');
  merchant.storeId = pickString(source, 'storeId', 'store_id', 'butiksnummer');
  return merchant;
}

function normalizeItems(source: unknown[], warnings: string[]): NormalizedItem[] {
  const items: NormalizedItem[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;

    const rawName = pickString(row, 'rawName', 'raw_name', 'printedName');
    const name = (pickString(row, 'name', 'description', 'product', 'title') ?? rawName ?? '').trim();
    if (!name) continue;

    const totalPrice = parseAmount(pickUnknown(row, 'totalPrice', 'total_price', 'total', 'amount', 'price'));
    if (totalPrice === null) {
      warnings.push(`Skipped "${name}" because it had no readable price.`);
      continue;
    }

    const { quantity, unit: parsedUnit } = parseQuantity(pickUnknown(row, 'quantity', 'qty', 'antal'));
    const explicitUnit = (pickString(row, 'unit', 'enhet') ?? '').toLowerCase().replace(/\./g, '');
    const unit = (VALID_UNITS.has(explicitUnit) ? explicitUnit : parsedUnit) as ItemUnit;

    const discountRaw = parseAmount(pickUnknown(row, 'discount', 'rabatt'));
    const depositRaw = parseAmount(pickUnknown(row, 'deposit', 'pant'));

    const haystack = `${name} ${rawName ?? ''}`;
    const isDeposit = DEPOSIT_PATTERN.test(haystack);
    // A negative line that is not pant is a discount, whether or not it says so.
    const isDiscount = !isDeposit && (DISCOUNT_PATTERN.test(haystack) || totalPrice < 0);

    let unitPrice = parseAmount(pickUnknown(row, 'unitPrice', 'unit_price', 'jmfpris', 'styckpris'));
    if (unitPrice === null && quantity > 0 && !isDiscount) {
      unitPrice = roundMoney(totalPrice / quantity);
    }

    items.push({
      name,
      rawName,
      searchName: normalizeSearchName(name),
      quantity,
      unit,
      unitPrice,
      totalPrice,
      discount: discountRaw === null ? null : Math.abs(discountRaw),
      vatRate: normalizeVatRate(pickUnknown(row, 'vatRate', 'vat_rate', 'moms', 'momssats')),
      ean: normalizeEan(pickString(row, 'ean', 'gtin', 'barcode')),
      deposit: depositRaw === null ? null : Math.abs(depositRaw),
      isDeposit,
      isDiscount,
    });
  }
  return items;
}

function normalizeVatLines(source: unknown[]): VatLine[] {
  const lines: VatLine[] = [];
  for (const entry of source) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const rate = normalizeVatRate(pickUnknown(row, 'rate', 'percent', 'momssats', 'sats'));
    if (rate === null) continue;

    const net = parseAmount(pickUnknown(row, 'net', 'netto', 'excl'));
    const vat = parseAmount(pickUnknown(row, 'vat', 'moms', 'tax'));
    let gross = parseAmount(pickUnknown(row, 'gross', 'brutto', 'incl', 'total'));
    if (gross === null && net !== null && vat !== null) gross = roundMoney(net + vat);
    lines.push({ rate, net, vat, gross });
  }
  return lines;
}

/** Swedish VAT is 0, 6, 12 or 25 percent. Accepts `0.12` and `"12 %"` alike. */
function normalizeVatRate(input: unknown): number | null {
  const parsed = parseAmount(input);
  if (parsed === null) return null;
  const value = Math.abs(parsed);
  if (value === 0) return 0;
  // A fraction like 0.12 means 12 %.
  const percent = value < 1 ? value * 100 : value;
  if (percent > 100) return null;
  return roundMoney(percent);
}

function normalizeEan(input: string | null): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

function normalizeLast4(input: string | null): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// --- tolerant field access ------------------------------------------------

function pickUnknown(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function pickString(source: Record<string, unknown>, ...keys: string[]): string | null {
  const value = pickUnknown(source, ...keys);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Models like to fill blanks with these instead of null.
    if (!trimmed || /^(n\/?a|unknown|okänd|null|-|--)$/i.test(trimmed)) return null;
    return trimmed;
  }
  if (typeof value === 'number') return String(value);
  return null;
}

function pickObject(source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  const value = pickUnknown(source, ...keys);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickArray(source: Record<string, unknown>, ...keys: string[]): unknown[] {
  const value = pickUnknown(source, ...keys);
  return Array.isArray(value) ? value : [];
}
