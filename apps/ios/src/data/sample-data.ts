import { emptyMerchant, type ID } from '@kvitto/shared/domain';
import type { IosDataRepository } from './repository';

/**
 * Every sample receipt's id starts with this, which is what makes the seeding
 * reversible: `clearSampleData` removes exactly these rows and cannot touch a
 * real receipt, however it got onto the device.
 */
export const SAMPLE_ID_PREFIX = 'sample:';

export interface SampleDataSummary {
  receipts: number;
  items: number;
}

interface SampleLine {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  categorySlug?: string;
}

interface SampleReceipt {
  suffix: string;
  merchant: string;
  purchasedAt: string;
  total: number;
  status: 'draft' | 'parsed' | 'confirmed' | 'failed';
  notes?: string;
  categorySlug?: string;
  lines: SampleLine[];
  /** Set when this receipt should exercise the needs-review path. */
  mismatched?: boolean;
}

/**
 * Deliberately varied: a confirmed receipt, a parsed one, a draft with no
 * lines, a failed one, and one whose lines do not add up. A screen that only
 * ever sees tidy data is not actually being checked.
 */
const SAMPLE_RECEIPTS: SampleReceipt[] = [
  {
    suffix: 'ica',
    merchant: 'ICA Maxi Lindhagen',
    purchasedAt: '2026-09-12T17:24:00.000Z',
    total: 247.5,
    status: 'confirmed',
    categorySlug: 'livsmedel',
    lines: [
      { name: 'Mellanmjölk 1.5%', quantity: 2, unitPrice: 17.9, totalPrice: 35.8 },
      { name: 'Bröd, grovt', quantity: 1, unitPrice: 32.5, totalPrice: 32.5 },
      { name: 'Ägg 12-pack', quantity: 1, unitPrice: 44.9, totalPrice: 44.9 },
      { name: 'Kaffe 500g', quantity: 1, unitPrice: 79.9, totalPrice: 79.9 },
      { name: 'Bananer', quantity: 1.2, unitPrice: 24.9, totalPrice: 29.9 },
      { name: 'Pant', quantity: 1, unitPrice: 24.5, totalPrice: 24.5 },
    ],
  },
  {
    suffix: 'espresso',
    merchant: 'Espresso House',
    purchasedAt: '2026-09-15T08:11:00.000Z',
    total: 98,
    status: 'parsed',
    notes: 'Fika med kund',
    lines: [
      { name: 'Cappuccino stor', quantity: 2, unitPrice: 39, totalPrice: 78 },
      { name: 'Kanelbulle', quantity: 1, unitPrice: 20, totalPrice: 20 },
    ],
  },
  {
    suffix: 'circlek',
    merchant: 'Circle K',
    purchasedAt: '2026-09-09T06:47:00.000Z',
    total: 812.4,
    status: 'parsed',
    lines: [{ name: 'Bensin 95', quantity: 42.3, unitPrice: 19.21, totalPrice: 812.4 }],
  },
  {
    // Lines that do not add up: a real receipt can disagree with itself, and
    // the edit screen's warning has to have something to warn about.
    suffix: 'mismatch',
    merchant: 'Hemköp Vasastan',
    purchasedAt: '2026-09-14T19:02:00.000Z',
    total: 300,
    status: 'parsed',
    mismatched: true,
    lines: [
      { name: 'Pasta', quantity: 2, unitPrice: 24.5, totalPrice: 49 },
      { name: 'Tomatsås', quantity: 1, unitPrice: 18.9, totalPrice: 18.9 },
    ],
  },
  {
    // No lines at all, to exercise the empty-items branch.
    suffix: 'draft',
    merchant: 'Okänd handlare',
    purchasedAt: '2026-09-16T12:00:00.000Z',
    total: 0,
    status: 'draft',
    lines: [],
  },
  {
    suffix: 'failed',
    merchant: 'Apotek Hjärtat',
    purchasedAt: '2026-09-02T14:30:00.000Z',
    total: 189,
    status: 'failed',
    notes: 'Extraction failed; kept for reference.',
    lines: [],
  },
];

function sampleReceiptId(suffix: string): ID {
  return `${SAMPLE_ID_PREFIX}receipt:${suffix}`;
}

/**
 * Writes a small, varied set of receipts for checking screens on a device.
 *
 * Idempotent: ids are deterministic, so seeding twice overwrites rather than
 * duplicating. The caller is responsible for deciding this is allowed to run -
 * see the `isSimulator` gate on the debug screen.
 */
export async function seedSampleData(repository: IosDataRepository): Promise<SampleDataSummary> {
  await repository.seedDefaultCategoriesOnce();
  const categories = await repository.listCategories();
  const categoryByName = new Map(categories.map((row) => [row.name.toLowerCase(), row.id]));

  let receipts = 0;
  let items = 0;

  for (const sample of SAMPLE_RECEIPTS) {
    const id = sampleReceiptId(sample.suffix);
    const categoryId = sample.categorySlug ? categoryByName.get(sample.categorySlug) ?? null : null;

    // Seeding twice must not leave the previous run's lines behind.
    for (const existing of await repository.listReceiptItems(id)) {
      await repository.deleteItem(existing.id);
    }

    await repository.createReceipt({
      id,
      merchant: { ...emptyMerchant(), name: sample.merchant },
      purchasedAt: sample.purchasedAt,
      currency: 'SEK',
      total: sample.total,
      status: sample.status,
      notes: sample.notes ?? null,
      categoryId,
      source: 'manual',
    });
    receipts += 1;

    for (const [index, line] of sample.lines.entries()) {
      await repository.addItem(id, {
        id: `${SAMPLE_ID_PREFIX}item:${sample.suffix}:${index}`,
        name: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        totalPrice: line.totalPrice,
      });
      items += 1;
    }
  }

  return { receipts, items };
}

/** Removes every row `seedSampleData` wrote, and nothing else. */
export async function clearSampleData(repository: IosDataRepository): Promise<SampleDataSummary> {
  let receipts = 0;
  let items = 0;

  for (const sample of SAMPLE_RECEIPTS) {
    const id = sampleReceiptId(sample.suffix);
    const receipt = await repository.getReceipt(id);
    if (!receipt || receipt.deletedAt !== 0) continue;

    items += (await repository.listReceiptItems(id)).length;
    await repository.deleteReceipt(id);
    receipts += 1;
  }

  return { receipts, items };
}

/** How many sample receipts are currently live on this device. */
export async function countSampleData(repository: IosDataRepository): Promise<number> {
  let count = 0;
  for (const sample of SAMPLE_RECEIPTS) {
    const receipt = await repository.getReceipt(sampleReceiptId(sample.suffix));
    if (receipt && receipt.deletedAt === 0) count += 1;
  }
  return count;
}
