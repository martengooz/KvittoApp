import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ID } from '@kvitto/shared/domain';

import type { IosDataRepository, PurchaseFilter, PurchaseListCursor, PurchaseRow } from '../../data/repository';

export interface PurchaseRowViewModel {
  id: ID;
  name: string;
  searchName: string;
  merchantName: string;
  purchasedAtLabel: string;
  priceLabel: string;
  key: string;
}

export interface PriceHistoryPoint {
  purchasedAt: string | null;
  price: number;
  merchantName: string;
}

export interface PurchasesControllerState {
  queryInput: string;
  loading: boolean;
  rows: PurchaseRowViewModel[];
  hasMore: boolean;
  selectedSearchName: string | null;
  priceHistory: PriceHistoryPoint[];
  error: string | null;
}

function toPriceLabel(value: number, currency: string): string {
  return `${value.toFixed(2)} ${currency}`;
}

function toDateLabel(value: string | null): string {
  if (!value) return 'Unknown date';
  return value.slice(0, 10);
}

export class PurchasesFeatureController {
  private readonly listeners = new Set<() => void>();
  private readonly pageSize: number;

  private rows: PurchaseRow[] = [];
  private nextCursor: PurchaseListCursor | null = null;
  private hasMore = false;
  private loading = false;
  private error: string | null = null;
  private queryInput = '';
  private filter: PurchaseFilter = {};
  private selectedSearchName: string | null = null;

  constructor(private readonly repository: IosDataRepository, pageSize = 80) {
    this.pageSize = pageSize;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  private buildFilter(): PurchaseFilter {
    if (this.queryInput.trim().length === 0) return { ...this.filter };
    return { ...this.filter, query: this.queryInput.trim() };
  }

  private snapshot: PurchasesControllerState | null = null;

  /**
   * `useSyncExternalStore` compares snapshots with `Object.is` on every
   * render, so a freshly built object each call re-renders forever. The
   * snapshot is therefore built once per change and invalidated by `emit`.
   */
  getSnapshot(): PurchasesControllerState {
    this.snapshot ??= this.buildSnapshot();
    return this.snapshot;
  }

  private buildSnapshot(): PurchasesControllerState {
    const vms = this.rows.map((row) => ({
      id: row.item.id,
      name: row.item.name,
      searchName: row.item.searchName,
      merchantName: row.merchantName ?? 'Unknown merchant',
      purchasedAtLabel: toDateLabel(row.purchasedAt),
      priceLabel: toPriceLabel(row.item.totalPrice, row.currency),
      key: `${row.item.id}:${row.item.updatedAt}`,
    }));

    return {
      queryInput: this.queryInput,
      loading: this.loading,
      rows: vms,
      hasMore: this.hasMore,
      selectedSearchName: this.selectedSearchName,
      priceHistory: this.buildPriceHistory(),
      error: this.error,
    };
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.emit();
    try {
      const page = await this.repository.queryPurchases(this.buildFilter(), this.pageSize);
      this.rows = page.items;
      this.nextCursor = page.nextCursor;
      this.hasMore = page.hasMore;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Failed to load purchases.';
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  async loadNextPage(): Promise<void> {
    if (!this.hasMore || !this.nextCursor || this.loading) return;
    this.loading = true;
    this.emit();
    try {
      const page = await this.repository.queryPurchases(this.buildFilter(), this.pageSize, this.nextCursor);
      this.rows = [...this.rows, ...page.items];
      this.nextCursor = page.nextCursor;
      this.hasMore = page.hasMore;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Failed to load purchase page.';
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  async setSearchQuery(query: string): Promise<void> {
    this.queryInput = query;
    await this.refresh();
  }

  async setFilter(partial: Partial<PurchaseFilter>): Promise<void> {
    this.filter = { ...this.filter, ...partial };
    await this.refresh();
  }

  selectSearchName(searchName: string | null): void {
    this.selectedSearchName = searchName;
    this.emit();
  }

  private buildPriceHistory(): PriceHistoryPoint[] {
    if (!this.selectedSearchName) return [];
    return this.rows
      .filter((row) => row.item.searchName === this.selectedSearchName)
      .sort((a, b) => {
        if (!a.purchasedAt && !b.purchasedAt) return a.item.id.localeCompare(b.item.id);
        if (!a.purchasedAt) return 1;
        if (!b.purchasedAt) return -1;
        const byDate = b.purchasedAt.localeCompare(a.purchasedAt);
        if (byDate !== 0) return byDate;
        return a.item.id.localeCompare(b.item.id);
      })
      .slice(0, 20)
      .map((row) => ({
        purchasedAt: row.purchasedAt,
        price: row.item.totalPrice,
        merchantName: row.merchantName ?? 'Unknown merchant',
      }));
  }
}

export function usePurchasesFeatureController(repository: IosDataRepository, pageSize = 80) {
  const [inputQuery, setInputQuery] = useState('');
  const deferredQuery = useDeferredValue(inputQuery);
  const controller = useMemo(() => new PurchasesFeatureController(repository, pageSize), [repository, pageSize]);

  const state = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  );

  useEffect(() => {
    void controller.refresh();
    const unsubscribe = repository.subscribe((event) => {
      if (!event.kinds.some((kind) => kind === 'items' || kind === 'receipts')) return;
      startTransition(() => {
        void controller.refresh();
      });
    });

    return () => {
      unsubscribe();
    };
  }, [controller, repository]);

  useEffect(() => {
    void controller.setSearchQuery(deferredQuery);
  }, [controller, deferredQuery]);

  // Memoized for the same reason as the receipts hook: a fresh object re-runs
  // any effect that depends on it, on every render.
  const actions = useMemo(
    () => ({
      setQuery: (query: string) => {
        startTransition(() => {
          setInputQuery(query);
        });
      },
      selectSearchName: (searchName: string | null) => controller.selectSearchName(searchName),
      setIncludeDiscounts: (includeDiscounts: boolean) => controller.setFilter({ includeDiscounts }),
      loadNextPage: () => controller.loadNextPage(),
    }),
    [controller],
  );

  return {
    state,
    actions,
  };
}
