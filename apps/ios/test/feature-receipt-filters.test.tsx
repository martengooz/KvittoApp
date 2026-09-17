/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { ScrollView } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';

import { countActiveFilters, createReceiptFilterStore } from '../src/features/receipts/filter-store';
import { ReceiptFiltersScreen } from '../src/features/receipts/filters-view';
import { ReceiptsFeatureController } from '../src/features/receipts/controller';
import { IosDataRepository } from '../src/data/repository';
import { PUSHED_MODAL_ROUTE_CONTRACTS } from '../src/app/routes';
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

async function seedReceipt(repository: IosDataRepository, overrides: Partial<Receipt>): Promise<void> {
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
}

describe('receipt filter store', () => {
  test('an explicit undefined clears a field rather than leaving it set', () => {
    const store = createReceiptFilterStore({ needsReview: true, minTotal: 50 });
    expect(store.activeCount()).toBe(2);

    store.setFilter({ needsReview: undefined });
    expect(store.getFilter()).toEqual({ minTotal: 50 });
    expect('needsReview' in store.getFilter()).toBe(false);
    expect(store.activeCount()).toBe(1);
  });

  test('subscribers see real changes once, and never a no-op write', () => {
    const store = createReceiptFilterStore();
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe((filter) => seen.push(filter));

    store.setFilter({ minTotal: 10 });
    store.setFilter({ minTotal: 10 });
    expect(seen).toHaveLength(1);

    store.clear();
    expect(seen).toHaveLength(2);
    expect(store.getFilter()).toEqual({});

    unsubscribe();
    store.setFilter({ maxTotal: 5 });
    expect(seen).toHaveLength(2);
  });

  test('empty arrays, empty strings and false do not count as active filters', () => {
    expect(countActiveFilters({})).toBe(0);
    expect(countActiveFilters({ categoryIds: [], statuses: [], from: '', needsReview: false })).toBe(0);
    expect(countActiveFilters({ categoryIds: ['a'], needsReview: true })).toBe(2);
    // `query` belongs to the search field, so it is not counted here.
    expect(countActiveFilters({ query: 'ica' })).toBe(0);
  });
});

describe('filter store drives the receipts list', () => {
  test('a store write refreshes the list, and disposing detaches it', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await seedReceipt(repository, { id: 'r-1', total: 50, status: 'parsed' });
    await seedReceipt(repository, { id: 'r-2', total: 500, status: 'parsed' });

    const store = createReceiptFilterStore();
    const controller = new ReceiptsFeatureController(repository, 50, store);
    await controller.refresh();
    expect(controller.getSnapshot().list.rows).toHaveLength(2);

    store.setFilter({ minTotal: 100 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.getSnapshot().list.rows.map((row) => row.id)).toEqual(['r-2']);

    controller.dispose();
    store.setFilter({ minTotal: undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Still filtered: a disposed controller must not keep following the store.
    expect(controller.getSnapshot().list.rows.map((row) => row.id)).toEqual(['r-2']);
    db.close();
  });

  test('setFilter on a store-backed controller routes through the store', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const store = createReceiptFilterStore();
    const controller = new ReceiptsFeatureController(repository, 50, store);

    await controller.setFilter({ needsReview: true });
    expect(store.getFilter()).toEqual({ needsReview: true });

    controller.dispose();
    db.close();
  });
});

describe('filters screen', () => {
  async function render(node: React.ReactElement): Promise<ReactTestRenderer> {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(node);
    });
    await flush();
    await flush();
    return renderer!;
  }

  test('opens showing the filters already applied, and lists categories', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    await repository.seedDefaultCategoriesOnce();

    const store = createReceiptFilterStore({ minTotal: 25, needsReview: true });
    const renderer = await render(<ReceiptFiltersScreen repository={repository} filterStore={store} />);
    const text = textOf(renderer);

    expect(text).toContain('2 filters applied.');
    expect(text).toContain('draft');
    expect(text).toContain('confirmed');
    // Seeded category names are rendered as selectable chips.
    expect(text).toContain('Livsmedel');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('an inverted amount range is reported instead of silently returning nothing', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const store = createReceiptFilterStore({ minTotal: 500, maxTotal: 10 });

    const renderer = await render(<ReceiptFiltersScreen repository={repository} filterStore={store} />);
    expect(textOf(renderer)).toContain('The minimum is greater than the maximum.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('an inverted date range is reported', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const store = createReceiptFilterStore({ from: '2026-05-01', to: '2026-01-01' });

    const renderer = await render(<ReceiptFiltersScreen repository={repository} filterStore={store} />);
    expect(textOf(renderer)).toContain('The start date is after the end date.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('no filters applied says so', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const store = createReceiptFilterStore();

    const renderer = await render(<ReceiptFiltersScreen repository={repository} filterStore={store} />);
    expect(textOf(renderer)).toContain('No filters applied.');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('the filter actions stay reachable', () => {
  test('the content scrolls, so Apply and Clear can be reached at any height', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    // The default taxonomy is nineteen categories, which is taller than a phone.
    await repository.seedDefaultCategoriesOnce();

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ReceiptFiltersScreen repository={repository} filterStore={createReceiptFilterStore()} />);
    });
    await flush();
    await flush();

    const scrollViews = renderer!.root.findAllByType(ScrollView);
    expect(scrollViews).toHaveLength(1);

    // Apply has to be inside the scroll view: without one, nineteen category
    // chips pushed it off the bottom of the screen where it could not be
    // pressed at all.
    const insideScroll = scrollViews[0]!.findAll(
      (node) => node.props?.accessibilityLabel === 'Apply filters' && typeof node.props?.onPress === 'function',
    );
    expect(insideScroll.length).toBeGreaterThan(0);

    await act(async () => renderer!.unmount());
    db.close();
  });

  test('the filters route is presented as a sheet, not a full modal', () => {
    const contract = PUSHED_MODAL_ROUTE_CONTRACTS.find((route) => route.route === 'filters');
    expect(contract?.presentation).toBe('formSheet');
  });
});
