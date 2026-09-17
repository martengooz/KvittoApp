/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';

import { ReceiptDetailScreen } from '../src/features/receipts/detail-view';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every string rendered anywhere in the tree, for content assertions. */
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

async function seed(repository: IosDataRepository, overrides: Partial<Receipt> = {}): Promise<Receipt> {
  const receipt = await repository.upsert('receipts', {
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
    notes: 'Tjansteresa',
    source: 'manual',
    imageId: null,
    originalImageId: null,
    thumbId: null,
    status: 'parsed',
    extraction: null,
    ocr: null,
    itemCount: 0,
    ...overrides,
  });
  return receipt;
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

describe('receipt detail screen', () => {
  test('renders the receipt, its provenance, and its line items in order', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository);
    await repository.addItem('r-1', { id: 'i-2', name: 'Brod', totalPrice: 25 });
    await repository.addItem('r-1', { id: 'i-1', name: 'Havremjolk', totalPrice: 24.9 });

    const renderer = await render(<ReceiptDetailScreen repository={repository} receiptId="r-1" />);
    const text = textOf(renderer);

    expect(text).toContain('ICA Maxi');
    expect(text).toContain('Source: manual');
    expect(text).toContain('Items (2)');
    // Line order, not insertion order.
    expect(text.indexOf('Brod')).toBeLessThan(text.indexOf('Havremjolk'));

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a receipt that does not exist reports it instead of hanging on a spinner', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);

    const renderer = await render(<ReceiptDetailScreen repository={repository} receiptId="missing" />);
    const text = textOf(renderer);

    expect(text).toContain('Receipt unavailable');
    expect(text).not.toContain('Loading receipt');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a deleted receipt is reported as unavailable', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository);
    await repository.deleteReceipt('r-1');

    const renderer = await render(<ReceiptDetailScreen repository={repository} receiptId="r-1" />);
    expect(textOf(renderer)).toContain('Receipt unavailable');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a receipt with no items says so rather than rendering an empty list', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository);

    const renderer = await render(<ReceiptDetailScreen repository={repository} receiptId="r-1" />);
    const text = textOf(renderer);
    expect(text).toContain('Items (0)');
    expect(text).toContain('No line items on this receipt.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('the screen follows repository changes without being remounted', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository);

    const renderer = await render(<ReceiptDetailScreen repository={repository} receiptId="r-1" />);
    expect(textOf(renderer)).toContain('Items (0)');

    await act(async () => {
      await repository.addItem('r-1', { id: 'i-1', name: 'Havremjolk', totalPrice: 24.9 });
    });
    await flush();
    await flush();

    expect(textOf(renderer)).toContain('Items (1)');
    expect(textOf(renderer)).toContain('Havremjolk');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('indexed receipt item lookup', () => {
  test('returns only the receipt’s live items, in line order', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seed(repository);
    await seed(repository, { id: 'r-2' });

    await repository.addItem('r-1', { id: 'a', name: 'First', totalPrice: 1 });
    await repository.addItem('r-1', { id: 'b', name: 'Second', totalPrice: 2 });
    await repository.addItem('r-2', { id: 'c', name: 'Other receipt', totalPrice: 3 });
    await repository.deleteItem('b');

    const items = await repository.listReceiptItems('r-1');
    expect(items.map((item) => item.id)).toEqual(['a']);

    await repository.restoreItem('b');
    const restored = await repository.listReceiptItems('r-1');
    expect(restored.map((item) => item.name)).toEqual(['First', 'Second']);
    db.close();
  });
});
