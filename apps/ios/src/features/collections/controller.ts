import { startTransition, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Category, ID, Tag } from '@kvitto/shared/domain';

import type { IosDataRepository, ReceiptListCursor, SpendSummary } from '../../data/repository';

interface ReceiptTagRow {
  id: ID;
  receiptId: ID;
  tagId: ID;
  deletedAt: number;
}

export interface CollectionSummaryRow {
  key: string;
  label: string;
  total: number;
  count: number;
}

export interface CollectionsControllerState {
  loading: boolean;
  byMonth: CollectionSummaryRow[];
  byCategory: CollectionSummaryRow[];
  byMerchant: CollectionSummaryRow[];
  byTag: CollectionSummaryRow[];
  error: string | null;
}

async function listAllLive<K extends 'categories' | 'tags' | 'receiptTags'>(
  repository: IosDataRepository,
  kind: K,
): Promise<Array<K extends 'categories' ? Category : K extends 'tags' ? Tag : ReceiptTagRow>> {
  let cursor = -1;
  const out: unknown[] = [];

  while (true) {
    const page = await repository.list(kind, { cursor, limit: 300 });
    for (const row of page.items) {
      if (row.deletedAt === 0) out.push(row);
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }

  return out as Array<K extends 'categories' ? Category : K extends 'tags' ? Tag : ReceiptTagRow>;
}

async function listReceiptsPaginated(repository: IosDataRepository): Promise<Array<{ id: ID; merchantName: string; total: number }>> {
  const limit = 250;
  let cursor: ReceiptListCursor | undefined;
  const rows: Array<{ id: ID; merchantName: string; total: number }> = [];

  while (true) {
    const page = await repository.queryReceipts({}, limit, cursor);
    rows.push(
      ...page.items.map((receipt) => ({
        id: receipt.id,
        merchantName: receipt.merchant.name ?? 'Unknown merchant',
        total: receipt.total ?? 0,
      })),
    );
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return rows;
}

function mapMonth(summary: SpendSummary): CollectionSummaryRow[] {
  return summary.byMonth
    .slice()
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((row) => ({
      key: row.month,
      label: row.month,
      total: row.total,
      count: row.receipts,
    }));
}

function mapCategory(summary: SpendSummary, categories: Category[]): CollectionSummaryRow[] {
  const categoryNames = new Map(categories.map((row) => [row.id, row.name]));
  return summary.byCategory.map((row) => ({
    key: row.categoryId ?? 'uncategorized',
    label: row.categoryId ? (categoryNames.get(row.categoryId) ?? row.categoryId) : 'Uncategorized',
    total: row.total,
    count: row.count,
  }));
}

function toSummaryRows(values: Map<string, { total: number; count: number }>, limit = 40): CollectionSummaryRow[] {
  return [...values.entries()]
    .map(([label, metrics]) => ({
      key: label,
      label,
      total: metrics.total,
      count: metrics.count,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export class CollectionsFeatureController {
  private readonly listeners = new Set<() => void>();
  private loading = false;
  private byMonth: CollectionSummaryRow[] = [];
  private byCategory: CollectionSummaryRow[] = [];
  private byMerchant: CollectionSummaryRow[] = [];
  private byTag: CollectionSummaryRow[] = [];
  private error: string | null = null;

  constructor(private readonly repository: IosDataRepository) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  getSnapshot(): CollectionsControllerState {
    return {
      loading: this.loading,
      byMonth: this.byMonth,
      byCategory: this.byCategory,
      byMerchant: this.byMerchant,
      byTag: this.byTag,
      error: this.error,
    };
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.emit();

    try {
      const [summary, categories, tags, receiptTags, receipts] = await Promise.all([
        Promise.resolve(this.repository.getSpendSummary()),
        listAllLive(this.repository, 'categories'),
        listAllLive(this.repository, 'tags'),
        listAllLive(this.repository, 'receiptTags'),
        listReceiptsPaginated(this.repository),
      ]);

      this.byMonth = mapMonth(summary);
      this.byCategory = mapCategory(summary, categories);

      const merchantMap = new Map<string, { total: number; count: number }>();
      for (const receipt of receipts) {
        const current = merchantMap.get(receipt.merchantName) ?? { total: 0, count: 0 };
        current.total += receipt.total;
        current.count += 1;
        merchantMap.set(receipt.merchantName, current);
      }
      this.byMerchant = toSummaryRows(merchantMap);

      const receiptTotalById = new Map(receipts.map((row) => [row.id, row.total]));
      const tagNameById = new Map(tags.map((row) => [row.id, row.name]));
      const tagMap = new Map<string, { total: number; count: number }>();

      for (const link of receiptTags) {
        const total = receiptTotalById.get(link.receiptId);
        if (total === undefined) continue;
        const tagName = tagNameById.get(link.tagId) ?? 'Unknown tag';
        const current = tagMap.get(tagName) ?? { total: 0, count: 0 };
        current.total += total;
        current.count += 1;
        tagMap.set(tagName, current);
      }
      this.byTag = toSummaryRows(tagMap);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Failed to load collection summaries.';
    } finally {
      this.loading = false;
      this.emit();
    }
  }
}

export function useCollectionsFeatureController(repository: IosDataRepository) {
  const controller = useMemo(() => new CollectionsFeatureController(repository), [repository]);

  const state = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  );

  useEffect(() => {
    void controller.refresh();
    const unsubscribe = repository.subscribe((event) => {
      if (
        !event.kinds.some((kind) => ['receipts', 'items', 'categories', 'tags', 'receiptTags'].includes(kind))
      ) {
        return;
      }
      startTransition(() => {
        void controller.refresh();
      });
    });

    return () => {
      unsubscribe();
    };
  }, [controller, repository]);

  return {
    state,
    refresh: () => controller.refresh(),
  };
}
