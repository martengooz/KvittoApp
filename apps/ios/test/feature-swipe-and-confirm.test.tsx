/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { emptyMerchant, type Receipt } from '@kvitto/shared/domain';

import { ReceiptsFeatureScreen } from '../src/features/receipts/view';
import { ReceiptDetailScreen } from '../src/features/receipts/detail-view';
import { SwipeRow } from '../src/ui/swipe-row';
import { alwaysConfirm, neverConfirm, type ConfirmPort } from '../src/ui/confirm';
import { haptic } from '../src/ui/haptics';
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

function pressables(renderer: ReactTestRenderer, label: string): ReactTestInstance[] {
  return renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
  );
}

async function press(renderer: ReactTestRenderer, label: string): Promise<void> {
  const matches = pressables(renderer, label);
  if (matches.length === 0) throw new Error(`No pressable labelled “${label}”. Rendered: ${textOf(renderer)}`);
  await act(async () => {
    (matches[matches.length - 1]!.props as { onPress: () => void }).onPress();
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

async function renderList(repository: IosDataRepository, confirm: ConfirmPort): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ReceiptsFeatureScreen repository={repository} confirm={confirm} />);
  });
  await flush();
  await flush();
  return renderer!;
}

describe('swipe row', () => {
  test('actions are real buttons, so VoiceOver can reach what a swipe reveals', async () => {
    let pressed = 0;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <SwipeRow actions={[{ label: 'Delete ICA Maxi', destructive: true, onPress: () => (pressed += 1) }]}>
          {null}
        </SwipeRow>,
      );
    });

    // Reachable without performing a gesture, which VoiceOver cannot do.
    await press(renderer!, 'Delete ICA Maxi');
    expect(pressed).toBe(1);

    await act(async () => renderer!.unmount());
  });

  test('a row with no actions renders its content and adds no gesture', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<SwipeRow actions={[]}>{null}</SwipeRow>);
    });

    expect(renderer!.root.findAll((node) => typeof node.props?.onPress === 'function')).toHaveLength(0);
    await act(async () => renderer!.unmount());
  });
});

describe('swipe to delete asks first', () => {
  test('declining leaves the receipt alone', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);

    const renderer = await renderList(repository, neverConfirm);
    await press(renderer, 'Delete ICA Maxi');

    const receipt = await repository.getReceipt('r-1');
    expect(receipt?.deletedAt).toBe(0);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('confirming deletes it', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);

    const renderer = await renderList(repository, alwaysConfirm);
    await press(renderer, 'Delete ICA Maxi');

    const receipt = await repository.getReceipt('r-1');
    expect(receipt?.deletedAt).not.toBe(0);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('the prompt names the receipt and says the delete can be undone', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);

    const seen: string[] = [];
    const recording: ConfirmPort = (request) => {
      seen.push(`${request.title} ${request.message}`);
      return Promise.resolve(false);
    };

    const renderer = await renderList(repository, recording);
    await press(renderer, 'Delete ICA Maxi');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('ICA Maxi');
    expect(seen[0]).toContain('undo');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('swipe actions only appear when they would do something', () => {
  test('a receipt needing review offers Mark reviewed', async () => {
    const { db, repository } = makeRepository();
    // Needs review means a failed receipt, or extraction warnings on one that
    // is not yet confirmed - see `receiptNeedsReview`.
    await seedReceipt(repository, { status: 'failed' });

    const renderer = await renderList(repository, neverConfirm);
    expect(pressables(renderer, 'Mark ICA Maxi reviewed').length).toBeGreaterThan(0);

    await press(renderer, 'Mark ICA Maxi reviewed');
    expect((await repository.getReceipt('r-1'))?.status).toBe('confirmed');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('an already confirmed receipt does not offer it', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository, { status: 'confirmed' });

    const renderer = await renderList(repository, neverConfirm);

    expect(pressables(renderer, 'Mark ICA Maxi reviewed')).toHaveLength(0);
    // Delete is always offered.
    expect(pressables(renderer, 'Delete ICA Maxi').length).toBeGreaterThan(0);

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('detail screen delete asks first', () => {
  async function renderDetail(repository: IosDataRepository, confirm: ConfirmPort, onDeleted?: () => void) {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ReceiptDetailScreen
          repository={repository}
          receiptId="r-1"
          confirm={confirm}
          onDeleted={onDeleted}
        />,
      );
    });
    await flush();
    await flush();
    return renderer!;
  }

  test('declining keeps the receipt and does not claim it was deleted', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);

    let dismissed = false;
    const renderer = await renderDetail(repository, neverConfirm, () => (dismissed = true));
    await press(renderer, 'Delete receipt');

    expect((await repository.getReceipt('r-1'))?.deletedAt).toBe(0);
    expect(dismissed).toBe(false);
    // The status line must not report a deletion that did not happen.
    expect(textOf(renderer)).not.toContain('Deleted.');

    await act(async () => renderer.unmount());
    db.close();
  });

  test('confirming deletes it and hands navigation back', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);

    let dismissed = false;
    const renderer = await renderDetail(repository, alwaysConfirm, () => (dismissed = true));
    await press(renderer, 'Delete receipt');

    expect((await repository.getReceipt('r-1'))?.deletedAt).not.toBe(0);
    expect(dismissed).toBe(true);

    await act(async () => renderer.unmount());
    db.close();
  });

  test('the prompt counts the line items that go with it', async () => {
    const { db, repository } = makeRepository();
    await seedReceipt(repository);
    await repository.addItem('r-1', { name: 'Mjölk' });

    const seen: string[] = [];
    const renderer = await renderDetail(repository, (request) => {
      seen.push(request.message);
      return Promise.resolve(false);
    });
    await press(renderer, 'Delete receipt');

    expect(seen[0]).toContain('1 line item');
    expect(seen[0]).not.toContain('1 line items');

    await act(async () => renderer.unmount());
    db.close();
  });
});

describe('haptics', () => {
  test('every signal is safe to fire where there is no Taptic Engine', () => {
    // Feedback is decoration; a rejection here must never become a failed save.
    for (const signal of ['success', 'warning', 'error', 'selection', 'impact'] as const) {
      expect(() => haptic(signal)).not.toThrow();
    }
  });
});
