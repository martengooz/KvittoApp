/** @jest-environment node */

import { describe, expect, test } from '@jest/globals';
import { useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useReceiptsFeatureController } from '../src/features/receipts/controller';
import { usePurchasesFeatureController } from '../src/features/purchases/controller';
import { useCollectionsFeatureController } from '../src/features/collections/controller';
import { IosDataRepository } from '../src/data/repository';
import { SqliteTestAdapter } from './support/sqlite-test-adapter';

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The receipts screen used to hold a `useEffect(..., [actions, needsReviewOnly])`
 * that pushed a filter into the controller. Because the hook rebuilt `actions`
 * on every render, that effect re-ran on every render, each run refreshed, each
 * refresh re-rendered - thousands of queries queued against the one SQLite
 * connection and nothing in the app could load. This renders the same shape and
 * pins the identity contract that stops it.
 */
describe('feature hook identity', () => {
  test('receipts actions stay identical across renders, so dependent effects settle', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);

    const seen: unknown[] = [];
    let effectRuns = 0;

    function Screen() {
      const { actions } = useReceiptsFeatureController(repository);
      const [needsReviewOnly] = useState(false);
      seen.push(actions);

      useEffect(() => {
        effectRuns += 1;
        actions.setNeedsReviewOnly(needsReviewOnly);
      }, [actions, needsReviewOnly]);

      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Screen />);
    });
    await flush();
    await flush();

    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(1);
    // One run on mount. An unstable `actions` produced hundreds within a tick.
    expect(effectRuns).toBe(1);

    await act(async () => {
      renderer?.unmount();
    });
    db.close();
  });

  test('purchases actions stay identical across renders', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const seen: unknown[] = [];

    function Screen() {
      const { actions } = usePurchasesFeatureController(repository);
      seen.push(actions);
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Screen />);
    });
    await flush();

    expect(new Set(seen).size).toBe(1);

    await act(async () => {
      renderer?.unmount();
    });
    db.close();
  });

  test('collections refresh stays identical across renders', async () => {
    const db = new SqliteTestAdapter();
    const repository = new IosDataRepository(db, () => 1000);
    const seen: unknown[] = [];

    function Screen() {
      const { refresh } = useCollectionsFeatureController(repository);
      seen.push(refresh);
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<Screen />);
    });
    await flush();

    expect(new Set(seen).size).toBe(1);

    await act(async () => {
      renderer?.unmount();
    });
    db.close();
  });
});
