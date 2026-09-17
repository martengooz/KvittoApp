/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';

import { TaxonomyScreen, type TaxonomyKind } from '../src/features/taxonomy/taxonomy-view';
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

/** The one node that both carries this label and can actually be pressed. */
function pressable(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const matches = renderer.root.findAll(
    (node) =>
      node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
    { deep: true },
  );
  if (matches.length === 0) throw new Error(`No pressable labelled “${label}”. Rendered: ${textOf(renderer)}`);
  return matches[matches.length - 1]!;
}

/** Whether the control the screen renders under this label refuses a press. */
function isDisabled(renderer: ReactTestRenderer, label: string): boolean {
  const state = pressable(renderer, label).props as { accessibilityState?: { disabled?: boolean } };
  return state.accessibilityState?.disabled === true;
}

async function press(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    pressable(renderer, label).props.onPress();
  });
  await flush();
  await flush();
}

async function type(renderer: ReactTestRenderer, label: string, value: string): Promise<void> {
  const field = renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onChangeText === 'function',
  );
  if (field.length === 0) throw new Error(`No text field labelled “${label}”.`);
  await act(async () => {
    field[field.length - 1]!.props.onChangeText(value);
  });
}

async function render(repository: IosDataRepository, kind: TaxonomyKind): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<TaxonomyScreen repository={repository} kind={kind} />);
  });
  await flush();
  await flush();
  return renderer!;
}

function makeRepository(): { db: SqliteTestAdapter; repository: IosDataRepository } {
  const db = new SqliteTestAdapter();
  return { db, repository: new IosDataRepository(db, () => 1000) };
}

async function seedReceipt(repository: IosDataRepository, overrides: Partial<Receipt>): Promise<void> {
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

describe('categories screen', () => {
  test('lists the seeded categories with how much each is used', async () => {
    const { db, repository } = makeRepository();
    await repository.seedDefaultCategoriesOnce();
    const [first] = await repository.listCategories();
    await seedReceipt(repository, { id: 'r-1', categoryId: first!.id });

    const renderer = await render(repository, 'categories');
    const text = textOf(renderer);

    expect(text).toContain('Livsmedel');
    expect(text).toContain('Used by 1 receipt and 0 items');
    expect(text).toContain('Not used yet');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('an empty taxonomy says so rather than rendering a blank list', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository, 'categories');

    expect(textOf(renderer)).toContain('No categories yet.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('adding a category writes it and it appears in the list', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository, 'categories');

    await press(renderer, 'Add category');
    await type(renderer, 'Categories name', 'Fika');
    await press(renderer, 'Save');

    expect((await repository.listCategories()).map((row) => row.name)).toEqual(['Fika']);
    expect(textOf(renderer)).toContain('Fika');
    // The editor closes once the write succeeds.
    expect(textOf(renderer)).toContain('Add category');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a duplicate name is refused before it reaches the database', async () => {
    const { db, repository } = makeRepository();
    await repository.saveCategory({ name: 'Fika', color: '#4f7cff' });
    const renderer = await render(repository, 'categories');

    await press(renderer, 'Add category');
    // Case and surrounding space must not sneak a duplicate past the check.
    await type(renderer, 'Categories name', '  fika ');

    expect(textOf(renderer)).toContain('already exists');
    expect(isDisabled(renderer, 'Save')).toBe(true);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('a malformed colour is reported and blocks saving', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository, 'categories');

    await press(renderer, 'Add category');
    await type(renderer, 'Categories name', 'Fika');
    await type(renderer, 'Categories colour', 'blue');

    expect(textOf(renderer)).toContain('A colour looks like #4f7cff.');
    expect(isDisabled(renderer, 'Save')).toBe(true);
    expect(await repository.listCategories()).toEqual([]);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('editing renames the existing row instead of adding another', async () => {
    const { db, repository } = makeRepository();
    const created = await repository.saveCategory({ name: 'Fika', color: '#4f7cff' });
    const renderer = await render(repository, 'categories');

    await press(renderer, 'Edit Fika');
    await type(renderer, 'Categories name', 'Kaffe');
    await press(renderer, 'Save');

    const rows = await repository.listCategories();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(created.id);
    expect(rows[0]!.name).toBe('Kaffe');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('deleting takes two steps and says what it costs', () => {
  test('the first press asks, and nothing is deleted yet', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Fika', color: '#4f7cff' });
    await seedReceipt(repository, { id: 'r-1', categoryId: category.id });

    const renderer = await render(repository, 'categories');
    await press(renderer, 'Remove Fika');

    const text = textOf(renderer);
    expect(text).toContain('Delete “Fika”?');
    expect(text).toContain('Used by 1 receipt and 0 items');
    expect(text).toContain('the receipts themselves are kept');
    expect(await repository.listCategories()).toHaveLength(1);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('backing out leaves the category alone', async () => {
    const { db, repository } = makeRepository();
    await repository.saveCategory({ name: 'Fika', color: '#4f7cff' });
    const renderer = await render(repository, 'categories');

    await press(renderer, 'Remove Fika');
    await press(renderer, 'Keep it');

    expect(textOf(renderer)).not.toContain('Delete “Fika”?');
    expect(await repository.listCategories()).toHaveLength(1);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('confirming deletes it and clears it from the receipt', async () => {
    const { db, repository } = makeRepository();
    const category = await repository.saveCategory({ name: 'Fika', color: '#4f7cff' });
    await seedReceipt(repository, { id: 'r-1', categoryId: category.id });

    const renderer = await render(repository, 'categories');
    await press(renderer, 'Remove Fika');
    await press(renderer, 'Delete Fika');

    expect(await repository.listCategories()).toEqual([]);
    expect((await repository.get('receipts', 'r-1'))?.categoryId).toBeNull();
    expect(textOf(renderer)).toContain('No categories yet.');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('tags screen', () => {
  test('shares the screen but has no icon field', async () => {
    const { db, repository } = makeRepository();
    const renderer = await render(repository, 'tags');

    await press(renderer, 'Add tag');
    expect(textOf(renderer)).toContain('New tag');
    expect(
      renderer.root.findAll((node) => node.props?.accessibilityLabel === 'Category icon'),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('deleting a tag reports its receipts and removes the links', async () => {
    const { db, repository } = makeRepository();
    const tag = await repository.saveTag({ name: 'Resa', color: '#4f7cff' });
    await repository.upsert('receiptTags', {
      updatedAt: 1000, deletedAt: 0, rev: 0, dirty: 1 as const,
      id: 'l-1', receiptId: 'r-1', tagId: tag.id,
    });

    const renderer = await render(repository, 'tags');
    expect(textOf(renderer)).toContain('Used by 1 receipt');

    await press(renderer, 'Remove Resa');
    await press(renderer, 'Delete Resa');

    expect(await repository.listTags()).toEqual([]);
    expect((await repository.get('receiptTags', 'l-1'))?.deletedAt).toBe(1000);

    await act(async () => renderer.unmount());
    db.close();
  });
});
