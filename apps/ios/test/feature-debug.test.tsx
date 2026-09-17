/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant } from '@kvitto/shared/domain';

import { DebugScreen } from '../src/features/debug/debug-view';
import { clearSampleData, countSampleData, seedSampleData, SAMPLE_ID_PREFIX } from '../src/data/sample-data';
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

function pressable(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const matches = renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
  );
  if (matches.length === 0) throw new Error(`No pressable labelled “${label}”.`);
  return matches[matches.length - 1]!;
}

async function press(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    (pressable(renderer, label).props as { onPress: () => void }).onPress();
  });
  await flush();
  await flush();
}

function makeRepository(): { db: SqliteTestAdapter; repository: IosDataRepository } {
  const db = new SqliteTestAdapter();
  return { db, repository: new IosDataRepository(db, () => 1000) };
}

async function render(repository: IosDataRepository, allowSampleData = true) {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <DebugScreen repository={repository} startupSteps={['opened database']} allowSampleData={allowSampleData} />,
    );
  });
  await flush();
  await flush();
  return renderer!;
}

describe('sample data', () => {
  test('seeds a varied set, including the awkward cases', async () => {
    const { db, repository } = makeRepository();

    const summary = await seedSampleData(repository);

    expect(summary.receipts).toBe(6);
    expect(summary.items).toBeGreaterThan(0);

    const receipts = await repository.queryReceipts({}, 100);
    const statuses = receipts.items.map((row) => row.status);
    // A screen that only ever sees tidy data is not being checked.
    expect(statuses).toContain('confirmed');
    expect(statuses).toContain('draft');
    expect(statuses).toContain('failed');

    const empty = receipts.items.find((row) => row.merchant.name === 'Okänd handlare');
    expect(await repository.listReceiptItems(empty!.id)).toEqual([]);
    db.close();
  });

  test('one receipt deliberately does not add up, so the warning has something to warn about', async () => {
    const { db, repository } = makeRepository();
    await seedSampleData(repository);

    const receipts = await repository.queryReceipts({}, 100);
    const mismatched = receipts.items.find((row) => row.merchant.name === 'Hemköp Vasastan')!;
    const items = await repository.listReceiptItems(mismatched.id);
    const sum = items.reduce((total, item) => total + item.totalPrice, 0);

    expect(mismatched.total).toBe(300);
    expect(Math.abs(sum - 300)).toBeGreaterThan(1);
    db.close();
  });

  test('seeding twice overwrites rather than duplicating', async () => {
    const { db, repository } = makeRepository();

    await seedSampleData(repository);
    const first = await repository.queryReceipts({}, 100);
    await seedSampleData(repository);
    const second = await repository.queryReceipts({}, 100);

    expect(second.items).toHaveLength(first.items.length);

    const ica = second.items.find((row) => row.merchant.name === 'ICA Maxi Lindhagen')!;
    // Line items must not accumulate across runs either.
    expect(await repository.listReceiptItems(ica.id)).toHaveLength(6);
    db.close();
  });

  test('clearing removes the samples and leaves real receipts alone', async () => {
    const { db, repository } = makeRepository();
    await repository.upsert('receipts', {
      updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
      id: 'mine-1',
      merchant: { ...emptyMerchant(), name: 'Min affär' },
      purchasedAt: '2026-02-10T12:00:00.000Z',
      currency: 'SEK', total: 42, subtotal: null, discountTotal: null,
      roundingAmount: null, depositTotal: null, vatLines: [],
      paymentMethod: null, cardLast4: null, receiptNumber: null,
      terminalId: null, cashier: null, categoryId: null, companyId: null,
      notes: null, source: 'manual', imageId: null, originalImageId: null,
      thumbId: null, status: 'parsed', extraction: null, ocr: null, itemCount: 0,
    });
    await seedSampleData(repository);

    const removed = await clearSampleData(repository);

    expect(removed.receipts).toBe(6);
    const left = await repository.queryReceipts({}, 100);
    expect(left.items.map((row) => row.id)).toEqual(['mine-1']);
    db.close();
  });

  test('every sample row carries the prefix that makes clearing safe', async () => {
    const { db, repository } = makeRepository();
    await seedSampleData(repository);

    const receipts = await repository.queryReceipts({}, 100);
    for (const receipt of receipts.items) {
      expect(receipt.id.startsWith(SAMPLE_ID_PREFIX)).toBe(true);
      for (const item of await repository.listReceiptItems(receipt.id)) {
        expect(item.id.startsWith(SAMPLE_ID_PREFIX)).toBe(true);
      }
    }
    db.close();
  });

  test('clearing when nothing was seeded is a no-op', async () => {
    const { db, repository } = makeRepository();
    expect(await clearSampleData(repository)).toEqual({ receipts: 0, items: 0 });
    expect(await countSampleData(repository)).toBe(0);
    db.close();
  });
});

describe('debug screen', () => {
  test('counts what is in the database', async () => {
    const { db, repository } = makeRepository();
    await seedSampleData(repository);

    const renderer = await render(repository);
    const text = textOf(renderer);

    expect(text).toContain('Receipts: 6');
    expect(text).toContain('Sample receipts: 6');
    expect(text).toContain('Categories: 19');
    expect(text).toContain('opened database');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('seeding from the screen writes and the counts follow', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository);

    expect(textOf(renderer)).toContain('Receipts: 0');
    await press(renderer, 'Seed sample data');

    expect(textOf(renderer)).toContain('Seeded 6 receipts');
    expect(textOf(renderer)).toContain('Receipts: 6');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('clearing from the screen removes them', async () => {
    const { db, repository } = makeRepository();
    await seedSampleData(repository);
    const renderer = await render(repository);

    await press(renderer, 'Clear sample data');

    expect(textOf(renderer)).toContain('Removed 6 receipts');
    expect(await countSampleData(repository)).toBe(0);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('clearing nothing says so rather than claiming a removal', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository);

    await press(renderer, 'Clear sample data');
    expect(textOf(renderer)).toContain('No sample receipts to remove.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('off a simulator the actions are absent, not merely disabled', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository, false);

    expect(
      renderer.root.findAll((node) => node.props?.accessibilityLabel === 'Seed sample data'),
    ).toHaveLength(0);
    expect(textOf(renderer)).toContain('only available on a simulator');
    // The diagnostics themselves still work on a real device.
    expect(textOf(renderer)).toContain('Receipts: 0');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('the smoke check and the sample data agree', () => {
  test('the receipt id the smoke check visits is one the seed actually writes', async () => {
    const script = readFileSync(join(__dirname, '..', 'scripts', 'smoke.mjs'), 'utf8');

    const match = /const SAMPLE_RECEIPT_ID = '([^']+)'/.exec(script);
    expect(match).not.toBeNull();

    const { db, repository } = makeRepository();
    await seedSampleData(repository);

    /*
     * If these drift, the smoke check visits a receipt that does not exist,
     * the screen renders its not-found state, and the check passes while
     * proving nothing about the populated path.
     */
    const receipt = await repository.getReceipt(match![1]!);
    expect(receipt).not.toBeNull();
    expect(await repository.listReceiptItems(match![1]!)).not.toHaveLength(0);
    db.close();
  });

  test('the marker the smoke check waits for is the one the route logs', () => {
    const script = readFileSync(join(__dirname, '..', 'scripts', 'smoke.mjs'), 'utf8');
    const route = readFileSync(join(__dirname, '..', 'app', 'debug', 'log.tsx'), 'utf8');

    const inScript = /const SAMPLE_SEEDED = '([^']+)'/.exec(script);
    const inRoute = /const SAMPLE_SEEDED_MARKER = '([^']+)'/.exec(route);

    expect(inScript).not.toBeNull();
    expect(inRoute).not.toBeNull();
    expect(inScript![1]).toBe(inRoute![1]);
  });
});
