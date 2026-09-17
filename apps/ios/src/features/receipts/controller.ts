import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Category, ID, Receipt, ReceiptItem, ReceiptStatus, Tag } from '@kvitto/shared/domain';
import { emptyMerchant } from '@kvitto/shared/domain';

import { receiptNeedsReview, type IosDataRepository, type ReceiptFilter, type ReceiptListCursor } from '../../data/repository';
import type { ReceiptFilterStore } from './filter-store';

export interface ReceiptListRowViewModel {
  id: ID;
  merchantName: string;
  purchasedAtLabel: string;
  totalLabel: string;
  status: ReceiptStatus;
  needsReview: boolean;
  tagNames: string[];
  categoryName: string | null;
  hasThumbnail: boolean;
  accessibilityLabel: string;
}

export interface ReceiptEditorState {
  id: ID;
  merchantName: string;
  purchasedAt: string;
  notes: string;
  status: ReceiptStatus;
  categoryId: ID | null;
  tagIds: ID[];
}

export interface ReceiptProvenanceViewModel {
  source: Receipt['source'];
  status: ReceiptStatus;
  reviewState: 'needs-review' | 'confirmed';
  extractionProvider: string | null;
  extractionModel: string | null;
  extractionWarningCount: number;
  hasOcrEvidence: boolean;
}

export interface ReceiptDetailsViewModel {
  receiptId: ID;
  editor: ReceiptEditorState;
  items: Array<{ id: ID; name: string; totalPrice: number }>;
  categories: Category[];
  tags: Tag[];
  provenance: ReceiptProvenanceViewModel;
  canUndoDelete: boolean;
  error: string | null;
}

export interface ReceiptListViewModel {
  rows: ReceiptListRowViewModel[];
  totalRows: number;
  hasMore: boolean;
  loading: boolean;
  query: string;
  activeFilters: ReceiptFilter;
  emptyMessage: string;
  error: string | null;
}

export interface ReceiptsControllerState {
  list: ReceiptListViewModel;
  selectedReceiptId: ID | null;
  details: ReceiptDetailsViewModel | null;
}

async function listAllLive<K extends 'categories' | 'tags' | 'receiptTags' | 'items'>(
  repository: IosDataRepository,
  kind: K,
): Promise<Array<K extends 'categories' ? Category : K extends 'tags' ? Tag : K extends 'receiptTags' ? { id: ID; receiptId: ID; tagId: ID; deletedAt: number } : ReceiptItem>> {
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

  return out as Array<K extends 'categories' ? Category : K extends 'tags' ? Tag : K extends 'receiptTags' ? { id: ID; receiptId: ID; tagId: ID; deletedAt: number } : ReceiptItem>;
}

function asDateLabel(value: string | null): string {
  if (!value) return 'Unknown date';
  return value.slice(0, 10);
}

function asCurrencyLabel(total: number | null, currency: string): string {
  if (total === null) return '-';
  return `${total.toFixed(2)} ${currency}`;
}

export class ReceiptsFeatureController {
  private readonly listeners = new Set<() => void>();
  private readonly pageSize: number;

  private query = '';
  private filter: ReceiptFilter = {};
  private rows: Receipt[] = [];
  private nextCursor: ReceiptListCursor | null = null;
  private hasMore = false;
  private loading = false;
  private error: string | null = null;
  private selectedReceiptId: ID | null = null;
  private details: ReceiptDetailsViewModel | null = null;
  private lastDeletedReceiptId: ID | null = null;

  private readonly filterStore: ReceiptFilterStore | null;

  private detachFilterStore: (() => void) | null = null;

  constructor(
    private readonly repository: IosDataRepository,
    pageSize = 50,
    filterStore: ReceiptFilterStore | null = null,
  ) {
    this.pageSize = pageSize;
    this.filterStore = filterStore;
    if (filterStore) {
      this.filter = filterStore.getFilter();
      this.detachFilterStore = filterStore.subscribe((next) => {
        this.filter = next;
        void this.refresh();
      });
    }
  }

  /** Detaches from the shared filter store; safe to call more than once. */
  dispose(): void {
    this.detachFilterStore?.();
    this.detachFilterStore = null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private snapshot: ReceiptsControllerState | null = null;

  /**
   * `useSyncExternalStore` compares snapshots with `Object.is` on every
   * render, so a freshly built object each call re-renders forever. The
   * snapshot is therefore built once per change and invalidated by `emit`.
   */
  getSnapshot(): ReceiptsControllerState {
    this.snapshot ??= this.buildSnapshot();
    return this.snapshot;
  }

  private buildSnapshot(): ReceiptsControllerState {
    return {
      list: {
        rows: this.rows.map((receipt) => this.toRowVm(receipt, this.details?.tags ?? [], this.details?.categories ?? [])),
        totalRows: this.rows.length,
        hasMore: this.hasMore,
        loading: this.loading,
        query: this.query,
        activeFilters: this.filter,
        emptyMessage: this.query.length > 0 ? 'No receipts match this search.' : 'No receipts yet.',
        error: this.error,
      },
      selectedReceiptId: this.selectedReceiptId,
      details: this.details,
    };
  }

  private emit(): void {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  private buildFilter(): ReceiptFilter {
    if (this.query.trim().length === 0) return { ...this.filter };
    return { ...this.filter, query: this.query.trim() };
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.emit();

    try {
      const page = await this.repository.queryReceipts(this.buildFilter(), this.pageSize);
      this.rows = page.items;
      this.nextCursor = page.nextCursor;
      this.hasMore = page.hasMore;
      if (this.selectedReceiptId) {
        await this.loadDetails(this.selectedReceiptId);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Failed to load receipts.';
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
      const page = await this.repository.queryReceipts(this.buildFilter(), this.pageSize, this.nextCursor);
      this.rows = [...this.rows, ...page.items];
      this.nextCursor = page.nextCursor;
      this.hasMore = page.hasMore;
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Failed to load more receipts.';
    } finally {
      this.loading = false;
      this.emit();
    }
  }

  async setSearchQuery(query: string): Promise<void> {
    this.query = query;
    await this.refresh();
  }

  async setFilter(partial: Partial<ReceiptFilter>): Promise<void> {
    // With a shared store the write goes there, and its notification is what
    // updates this controller, so the modal and the list cannot disagree.
    if (this.filterStore) {
      this.filterStore.setFilter(partial);
      return;
    }
    this.filter = { ...this.filter, ...partial };
    await this.refresh();
  }

  async selectReceipt(receiptId: ID | null): Promise<void> {
    this.selectedReceiptId = receiptId;
    if (!receiptId) {
      this.details = null;
      this.emit();
      return;
    }
    await this.loadDetails(receiptId);
    this.emit();
  }

  private async loadDetails(receiptId: ID): Promise<void> {
    const receipt = await this.repository.getReceipt(receiptId);
    if (!receipt || receipt.deletedAt !== 0) {
      this.details = null;
      return;
    }

    const [categories, tags, receiptTags, items] = await Promise.all([
      listAllLive(this.repository, 'categories'),
      listAllLive(this.repository, 'tags'),
      listAllLive(this.repository, 'receiptTags'),
      this.repository.listReceiptItems(receipt.id),
    ]);

    const tagIds = receiptTags.filter((row) => row.receiptId === receipt.id).map((row) => row.tagId);

    this.details = {
      receiptId: receipt.id,
      editor: {
        id: receipt.id,
        merchantName: receipt.merchant.name ?? '',
        purchasedAt: receipt.purchasedAt ?? '',
        notes: receipt.notes ?? '',
        status: receipt.status,
        categoryId: receipt.categoryId,
        tagIds,
      },
      items: items.map((item) => ({ id: item.id, name: item.name, totalPrice: item.totalPrice })),
      categories,
      tags,
      provenance: {
        source: receipt.source,
        status: receipt.status,
        reviewState: receiptNeedsReview(receipt) ? 'needs-review' : 'confirmed',
        extractionProvider: receipt.extraction?.provider ?? null,
        extractionModel: receipt.extraction?.model ?? null,
        extractionWarningCount: receipt.extraction?.warnings.length ?? 0,
        hasOcrEvidence: Boolean(receipt.ocr?.text),
      },
      canUndoDelete: this.lastDeletedReceiptId === receipt.id,
      error: null,
    };
  }

  async saveReceiptEdits(editor: ReceiptEditorState): Promise<void> {
    const existing = await this.repository.getReceipt(editor.id);
    const updated = await this.repository.updateReceipt(editor.id, {
      merchant: {
        ...(existing?.merchant ?? emptyMerchant()),
        name: editor.merchantName.length > 0 ? editor.merchantName : null,
      },
      purchasedAt: editor.purchasedAt.length > 0 ? editor.purchasedAt : null,
      notes: editor.notes.length > 0 ? editor.notes : null,
      status: editor.status,
      categoryId: editor.categoryId,
    });

    if (!updated) {
      this.error = 'Receipt could not be saved.';
      this.emit();
      return;
    }

    await this.repository.setReceiptTags(editor.id, editor.tagIds);
    await this.refresh();
    await this.selectReceipt(editor.id);
  }

  async markReviewed(receiptId: ID): Promise<void> {
    await this.repository.updateReceipt(receiptId, { status: 'confirmed' });
    await this.refresh();
    await this.selectReceipt(receiptId);
  }

  async deleteReceipt(receiptId: ID): Promise<void> {
    await this.repository.deleteReceipt(receiptId);
    this.lastDeletedReceiptId = receiptId;
    if (this.selectedReceiptId === receiptId) {
      this.selectedReceiptId = null;
      this.details = null;
    }
    await this.refresh();
  }

  async undoDelete(): Promise<void> {
    if (!this.lastDeletedReceiptId) return;
    await this.repository.restoreReceipt(this.lastDeletedReceiptId);
    const restoredId = this.lastDeletedReceiptId;
    this.lastDeletedReceiptId = null;
    await this.refresh();
    await this.selectReceipt(restoredId);
  }

  private toRowVm(receipt: Receipt, tags: Tag[], categories: Category[]): ReceiptListRowViewModel {
    const categoryName = categories.find((row) => row.id === receipt.categoryId)?.name ?? null;
    const tagNames = this.details?.editor.id === receipt.id
      ? tags.filter((tag) => this.details?.editor.tagIds.includes(tag.id)).map((tag) => tag.name)
      : [];

    return {
      id: receipt.id,
      merchantName: receipt.merchant.name ?? 'Unknown merchant',
      purchasedAtLabel: asDateLabel(receipt.purchasedAt),
      totalLabel: asCurrencyLabel(receipt.total, receipt.currency),
      status: receipt.status,
      needsReview: receiptNeedsReview(receipt),
      tagNames,
      categoryName,
      hasThumbnail: Boolean(receipt.thumbId),
      accessibilityLabel: `${receipt.merchant.name ?? 'Unknown merchant'}, ${asDateLabel(receipt.purchasedAt)}, total ${asCurrencyLabel(receipt.total, receipt.currency)}`,
    };
  }
}

export function useReceiptsFeatureController(
  repository: IosDataRepository,
  pageSize = 50,
  filterStore: ReceiptFilterStore | null = null,
) {
  const [inputQuery, setInputQuery] = useState('');
  const deferredQuery = useDeferredValue(inputQuery);

  const controller = useMemo(
    () => new ReceiptsFeatureController(repository, pageSize, filterStore),
    [repository, pageSize, filterStore],
  );

  useEffect(() => () => controller.dispose(), [controller]);

  const state = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  );

  useEffect(() => {
    void controller.refresh();
    const unsubscribe = repository.subscribe((event) => {
      if (!event.kinds.some((kind) => ['receipts', 'items', 'categories', 'tags', 'receiptTags'].includes(kind))) {
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

  useEffect(() => {
    void controller.setSearchQuery(deferredQuery);
  }, [controller, deferredQuery]);

  const setQuery = useCallback((next: string) => {
    startTransition(() => {
      setInputQuery(next);
    });
  }, []);

  const setNeedsReviewOnly = useCallback(
    (value: boolean) => {
      startTransition(() => {
        void controller.setFilter({ needsReview: value || undefined });
      });
    },
    [controller],
  );

  /**
   * Memoized so callers can safely list `actions` in an effect's dependencies.
   * A fresh object here re-runs those effects on every render, and any effect
   * that then touches the controller drives an unbounded refresh loop.
   */
  const actions = useMemo(
    () => ({
      setQuery,
      setNeedsReviewOnly,
      loadNextPage: () => controller.loadNextPage(),
      selectReceipt: (id: ID | null) => controller.selectReceipt(id),
      saveReceiptEdits: (editor: ReceiptEditorState) => controller.saveReceiptEdits(editor),
      markReviewed: (receiptId: ID) => controller.markReviewed(receiptId),
      deleteReceipt: (receiptId: ID) => controller.deleteReceipt(receiptId),
      undoDelete: () => controller.undoDelete(),
    }),
    [controller, setQuery, setNeedsReviewOnly],
  );

  return {
    controller,
    state,
    queryInput: inputQuery,
    actions,
  };
}
