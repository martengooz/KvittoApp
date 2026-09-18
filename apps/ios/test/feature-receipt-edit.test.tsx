/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant, type Receipt, type ReceiptItem } from '@kvitto/shared/domain';

import { ReceiptEditScreen } from '../src/features/receipts/edit-view';
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

function control(renderer: ReactTestRenderer, label: string, handler: string): ReactTestInstance {
  const matches = renderer.root.findAll(
    (node) =>
      node.props?.accessibilityLabel === label && typeof node.props?.[handler] === 'function',
  );
  if (matches.length === 0) {
    throw new Error(`No control labelled “${label}” with ${handler}. Rendered: ${textOf(renderer)}`);
  }
  return matches[matches.length - 1]!;
}

async function press(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    (control(renderer, label, 'onPress').props as { onPress: () => void }).onPress();
  });
  await flush();
  await flush();
}

async function type(renderer: ReactTestRenderer, label: string, value: string): Promise<void> {
  await act(async () => {
    (control(renderer, label, 'onChangeText').props as { onChangeText: (v: string) => void }).onChangeText(value);
  });
}

async function blur(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    (control(renderer, label, 'onBlur').props as { onBlur: () => void }).onBlur();
  });
  await flush();
  await flush();
}

function makeRepository(): { db: SqliteTestAdapter; repository: IosDataRepository } {
  const db = new SqliteTestAdapter();
  return { db, repository: new IosDataRepository(db, () => 1000) };
}

async function seedReceipt(repository: IosDataRepository, overrides: Partial<Receipt> = {}): Promise<void> {
  await repository.upsert('receipts', {
    updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
    id: 'r-1',
    merchant: { ...emptyMerchant(), name: 'ICA Maxi' },
    purchasedAt: '2026-02-10T12:00:00.000Z',
    currency: 'SEK', total: 120, subtotal: null, discountTotal: null,
    roundingAmount: null, depositTotal: null, vatLines: [],
    paymentMethod: null, cardLast4: null, receiptNumber: null,
    terminalId: null, cashier: null, categoryId: null, companyId: null,
    notes: null, source: 'manual', imageId: null, originalImageId: null,
    thumbId: null, status: 'parsed', extraction: null, ocr: null, itemCount: 0,
    ...overrides,
  });
}

async function render(repository: IosDataRepository, receiptId = 'r-1', onDone?: () => void) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ReceiptEditScreen repository={repository} receiptId={receiptId} onDone={onDone} />);
  });
  await flush();
  await flush();
  return renderer!;
}

describe('receipt edit screen', () => {
  test('opens with the receipt’s current values', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository, { notes: 'Lunch med kund' });

    const renderer = await render(repository);

    expect(control(renderer, 'Merchant name', 'onChangeText').props.value).toBe('ICA Maxi');
    expect(control(renderer, 'Receipt notes', 'onChangeText').props.value).toBe('Lunch med kund');
    // The screen no longer draws its own "Edit receipt" title - the native
    // header carries it, and drawing both made every screen say its name
    // twice. What the screen owes is the receipt's values, checked above.
    expect(textOf(renderer)).toContain('Line items');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a missing receipt is reported instead of showing an empty form', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository, 'nope');

    expect(textOf(renderer)).toContain('Receipt unavailable');
    expect(
      renderer.root.findAll((node) => node.props?.accessibilityLabel === 'Merchant name'),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('saving writes merchant, notes, status and category, then dismisses', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    const category = await repository.saveCategory({ name: 'Restaurang', color: '#4f7cff' });

    let dismissed = false;
    const renderer = await render(repository, 'r-1', () => {
      dismissed = true;
    });

    await type(renderer, 'Merchant name', 'Espresso House');
    await type(renderer, 'Receipt notes', 'Fika');
    await press(renderer, 'confirmed');
    await press(renderer, 'Restaurang');
    await press(renderer, 'Save receipt');

    const saved = await repository.getReceipt('r-1');
    expect(saved?.merchant.name).toBe('Espresso House');
    expect(saved?.notes).toBe('Fika');
    expect(saved?.status).toBe('confirmed');
    expect(saved?.categoryId).toBe(category.id);
    expect(dismissed).toBe(true);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('cancelling dismisses without writing anything', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);

    let dismissed = false;
    const renderer = await render(repository, 'r-1', () => {
      dismissed = true;
    });

    await type(renderer, 'Merchant name', 'Not saved');
    await press(renderer, 'Cancel');

    expect((await repository.getReceipt('r-1'))?.merchant.name).toBe('ICA Maxi');
    expect(dismissed).toBe(true);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a blank merchant clears the name rather than storing an empty string', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    const renderer = await render(repository);

    await type(renderer, 'Merchant name', '   ');
    await press(renderer, 'Save receipt');

    expect((await repository.getReceipt('r-1'))?.merchant.name).toBeNull();

    await act(async () => renderer.unmount());
    db.close();
  });

  test('tags are attached and detached through the chips', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    const tag = await repository.saveTag({ name: 'Avdrag', color: '#4f7cff' });

    const renderer = await render(repository);
    await press(renderer, 'Avdrag');
    await press(renderer, 'Save receipt');
    expect(await repository.listTagIdsForReceipt('r-1')).toEqual([tag.id]);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('choosing Uncategorised clears an existing category', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Restaurang', color: '#4f7cff' });
    await seedReceipt(repository, { categoryId: category.id });

    const renderer = await render(repository);
    await press(renderer, 'Uncategorised');
    await press(renderer, 'Save receipt');

    expect((await repository.getReceipt('r-1'))?.categoryId).toBeNull();

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('line items', () => {
  async function seedItem(repository: IosDataRepository, overrides: Partial<ReceiptItem> = {}) {
    return repository.addItem('r-1', { name: 'Mjölk', quantity: 2, unitPrice: 10, totalPrice: 20, ...overrides });
  }

  test('adding a line writes it and it appears', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    const renderer = await render(repository);

    expect(textOf(renderer)).toContain('No line items on this receipt.');
    await press(renderer, 'Add line item');

    expect(await repository.listReceiptItems('r-1')).toHaveLength(1);
    expect(textOf(renderer)).toContain('Line items (1)');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a line is written on blur, not on every keystroke', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await seedItem(repository);
    const renderer = await render(repository);

    await type(renderer, 'Item name, line 1', 'Mel');
    // Half-typed text must not reach the database.
    expect((await repository.listReceiptItems('r-1'))[0]!.name).toBe('Mjölk');

    await type(renderer, 'Item name, line 1', 'Mellanmjölk');
    await blur(renderer, 'Item name, line 1');
    expect((await repository.listReceiptItems('r-1'))[0]!.name).toBe('Mellanmjölk');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('removing a line takes it out of the receipt', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await seedItem(repository);
    const renderer = await render(repository);

    await press(renderer, 'Remove line 1, Mjölk');

    expect(await repository.listReceiptItems('r-1')).toEqual([]);
    expect(textOf(renderer)).toContain('No line items on this receipt.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a line whose quantity times unit price misses its total is reported', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await seedItem(repository, { quantity: 2, unitPrice: 10, totalPrice: 20 });
    const renderer = await render(repository);

    expect(textOf(renderer)).not.toContain('not 20.00');

    await type(renderer, 'Item quantity, line 1', '3');
    expect(textOf(renderer)).toContain('Quantity times unit price is 30.00, not 20.00.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('the warning is advice, not a block: the typed value still saves', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await seedItem(repository, { quantity: 2, unitPrice: 10, totalPrice: 20 });
    const renderer = await render(repository);

    await type(renderer, 'Item quantity, line 1', '3');
    await blur(renderer, 'Item quantity, line 1');

    // A real receipt can disagree with its own arithmetic; the app records it.
    expect((await repository.listReceiptItems('r-1'))[0]!.quantity).toBe(3);
    expect((await repository.listReceiptItems('r-1'))[0]!.totalPrice).toBe(20);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('items not adding up to the receipt total is reported without rewriting it', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository, { total: 120 });
    await seedItem(repository, { totalPrice: 20 });
    const renderer = await render(repository);

    expect(textOf(renderer)).toContain('Line items add up to 20.00, but the receipt total is 120.00.');
    // The printed total is evidence; it is not silently corrected.
    expect((await repository.getReceipt('r-1'))?.total).toBe(120);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a blank unit price is stored as not stated, not as zero', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await seedItem(repository, { unitPrice: 10 });
    const renderer = await render(repository);

    await type(renderer, 'Item unit price, line 1', '');
    await blur(renderer, 'Item unit price, line 1');

    expect((await repository.listReceiptItems('r-1'))[0]!.unitPrice).toBeNull();

    await act(async () => renderer.unmount());
    db.close();
  });

  test('unreadable numbers leave the stored value alone', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await seedItem(repository, { totalPrice: 20 });
    const renderer = await render(repository);

    await type(renderer, 'Item total, line 1', 'abc');
    await blur(renderer, 'Item total, line 1');

    expect((await repository.listReceiptItems('r-1'))[0]!.totalPrice).toBe(20);

    await act(async () => renderer.unmount());
    db.close();
  });
});
