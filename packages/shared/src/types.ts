/**
 * Core domain model for KvittoApp.
 *
 * Every synchronisable record carries {@link SyncMeta}. The client and the
 * companion server share these shapes verbatim so the sync payloads need no
 * translation layer on either side.
 */

export type ID = string;

/** ISO-8601 date-time string, e.g. `2024-03-15T14:22:00.000Z`. */
export type IsoDateTime = string;

/** Fields present on every record that participates in sync. */
export interface SyncMeta {
  /**
   * Client wall-clock time (ms since epoch) of the last local edit.
   * This is the last-write-wins key: the newer `updatedAt` wins a conflict.
   */
  updatedAt: number;
  /**
   * Tombstone timestamp, or `0` while the record is live.
   *
   * Zero rather than `null` because IndexedDB refuses to index `null`: a
   * nullable field silently drops every live row out of any index it appears
   * in, which would make "all receipts" queries return only the deleted ones.
   */
  deletedAt: number;
  /**
   * Server-assigned monotonic revision. `0` means "never reached the server".
   * Clients pull everything with `rev > cursor`.
   */
  rev: number;
  /** 1 while the record has local changes awaiting upload. Numeric so IndexedDB can index it. */
  dirty: 0 | 1;
}

export const EMPTY_SYNC_META: SyncMeta = Object.freeze({
  updatedAt: 0,
  deletedAt: 0,
  rev: 0,
  dirty: 1,
});

/** Where a receipt image came from. */
export type ReceiptSource = 'camera' | 'upload' | 'manual';

/** Lifecycle of a receipt as it moves through the scan pipeline. */
export type ReceiptStatus =
  /** Image captured, nothing parsed yet. */
  | 'draft'
  /** Handed to the AI provider, awaiting a response. */
  | 'processing'
  /** AI returned data; not yet reviewed by a human. */
  | 'parsed'
  /** AI call failed. `extraction.error` explains why. */
  | 'failed'
  /** A human has reviewed and accepted the data. */
  | 'confirmed';

/** Store details, as printed on the receipt. */
export interface Merchant {
  name: string | null;
  /** Swedish organisationsnummer, normalised to `NNNNNN-NNNN`. */
  orgNumber: string | null;
  /** VAT/momsregistreringsnummer, e.g. `SE556123456701`. */
  vatNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  /** Butiks-/kassanummer printed on the slip. */
  storeId: string | null;
}

export function emptyMerchant(): Merchant {
  return {
    name: null,
    orgNumber: null,
    vatNumber: null,
    address: null,
    postalCode: null,
    city: null,
    country: null,
    phone: null,
    storeId: null,
  };
}

/** One row of the Swedish `Moms`/VAT summary table. */
export interface VatLine {
  /** VAT percentage, e.g. `12` for the Swedish food rate. */
  rate: number;
  /** Amount excluding VAT (netto). */
  net: number | null;
  /** The VAT amount itself (moms). */
  vat: number | null;
  /** Amount including VAT (brutto). */
  gross: number | null;
}

/** Provenance of the parsed data. */
export interface ExtractionInfo {
  provider: string;
  model: string;
  /** When the extraction completed. */
  at: number;
  /** Wall-clock duration of the provider call, in ms. */
  durationMs: number | null;
  /** Token usage, when the provider reports it. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Non-fatal problems found while normalising/validating the response. */
  warnings: string[];
  /** Populated when `status === 'failed'`. */
  error: string | null;
}

/**
 * What the on-device OCR pass found, kept alongside the AI extraction.
 *
 * Stored rather than recomputed because it is the evidence behind the company
 * link: the fuzzy name check needs the receipt's own text, and re-running
 * Tesseract to re-verify a name would cost seconds and a fresh image.
 */
export interface OcrInfo {
  /** The recognised text, verbatim. */
  text: string;
  /** Mean word confidence, 0..100, as the engine reported it. */
  confidence: number;
  engine: string;
  at: number;
  durationMs: number | null;
  /** Every organisation number the text yielded, best first. */
  orgNumbers: { value: string; confidence: number; repaired: boolean }[];
  /** Every plausible purchase date, best first. */
  dates: { value: string; confidence: number }[];
}

export interface Receipt extends SyncMeta {
  id: ID;
  merchant: Merchant;
  /** When the purchase happened, as printed on the receipt. */
  purchasedAt: IsoDateTime | null;
  /** ISO 4217, defaults to `SEK`. */
  currency: string;

  /** `Att betala` — the amount actually paid, including VAT and rounding. */
  total: number | null;
  /** Sum of line items before receipt-level discounts. */
  subtotal: number | null;
  /** Receipt-level discounts as a positive number. */
  discountTotal: number | null;
  /** `Öresavrundning`. Can be negative. */
  roundingAmount: number | null;
  /** `Pant` (bottle/can deposit) charged on this receipt. */
  depositTotal: number | null;
  vatLines: VatLine[];

  paymentMethod: string | null;
  cardLast4: string | null;
  receiptNumber: string | null;
  terminalId: string | null;
  cashier: string | null;

  categoryId: ID | null;
  /** The looked-up {@link Company}, keyed by organisation number. */
  companyId: ID | null;
  notes: string | null;
  source: ReceiptSource;

  /** SHA-256 (hex) of the processed image, used as the content-addressed blob key. */
  imageId: string | null;
  /** SHA-256 (hex) of the original, unprocessed capture. Kept only if the user opts in. */
  originalImageId: string | null;
  /** SHA-256 (hex) of the list thumbnail. */
  thumbId: string | null;

  status: ReceiptStatus;
  extraction: ExtractionInfo | null;
  /** The on-device OCR pass, or null if it never ran. */
  ocr: OcrInfo | null;
  /** Denormalised count so the list view does not need to join. */
  itemCount: number;
}

/** Unit of measure as printed in Swedish stores. */
export type ItemUnit = 'st' | 'kg' | 'hg' | 'g' | 'l' | 'dl' | 'cl' | 'm' | 'förp' | 'other';

export interface ReceiptItem extends SyncMeta {
  id: ID;
  receiptId: ID;
  /** Position on the receipt, 0-based. Used for stable ordering. */
  lineNo: number;

  /** Cleaned-up, human-friendly product name. */
  name: string;
  /** Exactly what was printed, before any cleanup. Useful when re-parsing. */
  rawName: string | null;
  /** Lowercased, punctuation-stripped name used for search and grouping. */
  searchName: string;

  quantity: number;
  unit: ItemUnit;
  /** Price per unit before discount. */
  unitPrice: number | null;
  /** What this line actually contributed to the total, after its own discount. */
  totalPrice: number;
  /** Line-level discount as a positive number. */
  discount: number | null;
  vatRate: number | null;

  categoryId: ID | null;
  /** EAN/GTIN barcode, when printed. */
  ean: string | null;
  /** Pant charged for this line, if broken out separately. */
  deposit: number | null;
  /** True for standalone `Pant` rows. */
  isDeposit: boolean;
  /** True for standalone discount rows (`Rabatt`, `Prisnedsättning`, member offers). */
  isDiscount: boolean;
  notes: string | null;
}

/** Scope decides which pickers a category shows up in. */
export type CategoryScope = 'receipt' | 'item' | 'both';

export interface Category extends SyncMeta {
  id: ID;
  name: string;
  /** CSS colour, e.g. `#4f7cff`. */
  color: string;
  /** A single emoji used as the category glyph. */
  icon: string | null;
  parentId: ID | null;
  scope: CategoryScope;
  sortOrder: number;
}

/**
 * A company looked up from the registry by organisation number.
 *
 * Stored as its own entity rather than inline on the receipt for two reasons:
 * every receipt from the same shop points at one row, and the lookup costs an
 * API call that must never be repeated for a company already known.
 */
export interface Company extends SyncMeta {
  /** The organisation number, unformatted (ten digits). Also the natural key. */
  id: ID;
  /** `NNNNNN-NNNN`. */
  orgNumber: string;
  /** Registered legal name, e.g. `AB Volvo (publ)`. */
  name: string;
  legalForm: string | null;
  status: string | null;
  active: boolean | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  /** Primary SNI (industry) description, when the registry supplies one. */
  industry: string | null;

  /**
   * The provider's complete response payload.
   *
   * Kept verbatim so a later feature can use a field the app does not surface
   * today without spending another lookup. The UI reads only the flattened
   * fields above.
   */
  raw: Record<string, unknown> | null;
  /** Which provider answered, e.g. `apiverket`. */
  source: string | null;
  /** When the lookup happened. */
  fetchedAt: number | null;

  /**
   * How well the registered name matched the text on the receipt that produced
   * this lookup, 0..1, or null if never checked.
   */
  nameMatchScore: number | null;
  /** True once a receipt's own text corroborated the registered name. */
  nameConfirmed: boolean;
}

/** Free-form label on a receipt. Tags are how collections are built. */
export interface Tag extends SyncMeta {
  id: ID;
  name: string;
  color: string;
}

/** Join record between a receipt and a tag. First-class so it syncs independently. */
export interface ReceiptTag extends SyncMeta {
  id: ID;
  receiptId: ID;
  tagId: ID;
}

/** Every entity kind that takes part in delta sync. */
export const ENTITY_KINDS = [
  // Companies first: a receipt references one, so applying them in this order
  // means an incoming receipt never points at a row that has not arrived yet.
  'companies',
  'receipts',
  'items',
  'categories',
  'tags',
  'receiptTags',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityMap {
  companies: Company;
  receipts: Receipt;
  items: ReceiptItem;
  categories: Category;
  tags: Tag;
  receiptTags: ReceiptTag;
}

export type AnyEntity = EntityMap[EntityKind];
