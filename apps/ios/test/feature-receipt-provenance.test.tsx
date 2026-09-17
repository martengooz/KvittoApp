/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant, type ExtractionInfo, type OcrInfo, type Receipt } from '@kvitto/shared/domain';

import { ReceiptExtractionScreen, ReceiptOcrScreen } from '../src/features/receipts/provenance-view';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function textOf(renderer: ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return strings.join(' | ');
}

async function render(node: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(node);
  });
  await flush();
  await flush();
  return renderer!;
}

async function seed(repository: IosDataRepository, overrides: Partial<Receipt> = {}): Promise<void> {
  await repository.upsert('receipts', {
    updatedAt: 1000,
    deletedAt: 0,
    rev: 0,
    dirty: 1 as const,
    id: 'r-1',
    merchant: { ...emptyMerchant(), name: 'ICA Maxi' },
    purchasedAt: '2026-02-10T12:00:00.000Z',
    currency: 'SEK',
    total: 120,
    subtotal: null,
    discountTotal: null,
    roundingAmount: null,
    depositTotal: null,
    vatLines: [],
    paymentMethod: null,
    cardLast4: null,
    receiptNumber: null,
    terminalId: null,
    cashier: null,
    categoryId: null,
    companyId: null,
    notes: null,
    source: 'camera',
    imageId: null,
    originalImageId: null,
    thumbId: null,
    status: 'parsed',
    extraction: null,
    ocr: null,
    itemCount: 0,
    ...overrides,
  });
}

const EXTRACTION: ExtractionInfo = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  at: 1_700_000_000_000,
  durationMs: 1234,
  inputTokens: 900,
  outputTokens: 120,
  warnings: ['total did not match the sum of items', 'vat table was unreadable'],
  error: null,
};

const OCR: OcrInfo = {
  text: 'ICA MAXI\nORG 556036-0793\n2026-02-10',
  confidence: 87.4,
  engine: 'vision',
  at: 1_700_000_000_000,
  durationMs: 410,
  orgNumbers: [{ value: '556036-0793', confidence: 91, repaired: true }],
  dates: [{ value: '2026-02-10', confidence: 88 }],
};

describe('extraction screen', () => {
  test('shows provider, model, timing, and every warning', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository, { extraction: EXTRACTION });

    const text = textOf(await render(<ReceiptExtractionScreen repository={repository} receiptId="r-1" />));
    expect(text).toContain('anthropic');
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('1234 ms');
    expect(text).toContain('900 in / 120 out');
    expect(text).toContain('Warnings (2)');
    expect(text).toContain('total did not match the sum of items');
    expect(text).toContain('vat table was unreadable');
    db.close();
  });

  test('surfaces a failed extraction error rather than hiding it', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository, {
      status: 'failed',
      extraction: { ...EXTRACTION, warnings: [], error: 'provider returned 429' },
    });

    const text = textOf(await render(<ReceiptExtractionScreen repository={repository} receiptId="r-1" />));
    expect(text).toContain('provider returned 429');
    db.close();
  });

  test('a receipt with no extraction says so, and names its status', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository, { status: 'draft' });

    const text = textOf(await render(<ReceiptExtractionScreen repository={repository} receiptId="r-1" />));
    expect(text).toContain('No extraction yet');
    expect(text).toContain('draft');
    db.close();
  });

  test('a missing receipt is reported, not left loading', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);

    const text = textOf(await render(<ReceiptExtractionScreen repository={repository} receiptId="nope" />));
    expect(text).toContain('Receipt unavailable');
    expect(text).not.toContain('Loading extraction');
    db.close();
  });
});

describe('OCR screen', () => {
  test('shows the engine, the evidence it produced, and the raw text', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository, { ocr: OCR });

    const text = textOf(await render(<ReceiptOcrScreen repository={repository} receiptId="r-1" />));
    expect(text).toContain('vision');
    expect(text).toContain('87 / 100');
    expect(text).toContain('Organisation numbers (1)');
    expect(text).toContain('556036-0793 — 91% (repaired)');
    expect(text).toContain('Dates (1)');
    expect(text).toContain('2026-02-10 — 88%');
    expect(text).toContain('ORG 556036-0793');
    db.close();
  });

  test('empty recognised text is called out rather than rendered blank', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository, { ocr: { ...OCR, text: '   ', orgNumbers: [], dates: [] } });

    const text = textOf(await render(<ReceiptOcrScreen repository={repository} receiptId="r-1" />));
    expect(text).toContain('(the recognised text was empty)');
    expect(text).toContain('No organisation number was found');
    expect(text).toContain('No purchase date was found');
    db.close();
  });

  test('a receipt with no OCR pass says so', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository);

    const text = textOf(await render(<ReceiptOcrScreen repository={repository} receiptId="r-1" />));
    expect(text).toContain('No OCR text yet');
    db.close();
  });
});
