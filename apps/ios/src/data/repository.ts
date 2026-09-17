import {
  DEFAULT_CATEGORIES,
  EMPTY_SYNC_META,
  ENTITY_KINDS,
  emptyMerchant,
  mergeIncomingReceipt,
  newId,
  normalizeSearchName,
  resolveConflict,
  seedCategoryId,
  tokenizeQuery,
  type AnyEntity,
  type Category,
  type EntityKind,
  type EntityMap,
  type ID,
  type Receipt,
  type ReceiptItem,
  type SyncMeta,
  type Tag,
} from '@kvitto/shared/domain';
import type {
  CanonicalRecord,
  CanonicalRepositoryPort,
  DirtySnapshot,
  PageOptions,
  PageResult,
  RevisionCursor,
  SyncApplyResult,
} from '@kvitto/client-core/ports';

import {
  TABLE_CANONICAL_ENTITIES,
  TABLE_ITEM_FTS,
  TABLE_ITEM_PROJECTIONS,
  TABLE_KV,
  TABLE_RECEIPT_FTS,
  TABLE_RECEIPT_PROJECTIONS,
} from '../../drizzle/schema';
import type { SqlParam, SqliteLikeAdapter } from './sqlite-like';

export interface RepositoryEvent {
  kinds: EntityKind[];
  reason:
    | 'upsert'
    | 'mutation'
    | 'tombstone'
    | 'restore'
    | 'markClean'
    | 'incoming'
    | 'reset-rev'
    | 'startup';
}

export interface ReceiptListCursor {
  purchasedAt: string | null;
  id: ID;
}

export interface PurchaseListCursor {
  updatedAt: number;
  id: ID;
}

export interface ReceiptFilter {
  query?: string;
  from?: string;
  to?: string;
  categoryIds?: ID[];
  statuses?: Receipt['status'][];
  minTotal?: number;
  maxTotal?: number;
  needsReview?: boolean;
}

export interface PurchaseFilter {
  query?: string;
  from?: string;
  to?: string;
  categoryIds?: ID[];
  minPrice?: number;
  maxPrice?: number;
  includeDiscounts?: boolean;
  includeDeposits?: boolean;
}

export interface SpendSummary {
  receiptCount: number;
  itemCount: number;
  total: number;
  byMonth: { month: string; total: number; receipts: number }[];
  byCategory: { categoryId: string | null; total: number; count: number }[];
}

export interface PurchaseRow {
  item: ReceiptItem;
  receiptId: ID;
  merchantName: string | null;
  purchasedAt: string | null;
  currency: string;
}

interface PayloadRow {
  payload: string;
}

function parsePayload<K extends EntityKind>(row: PayloadRow): CanonicalRecord<K> {
  return JSON.parse(row.payload) as CanonicalRecord<K>;
}

/** Builds a placeholder list (`?, ?, ?`) for an `IN` clause. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * Escapes a search term for an FTS5 MATCH expression. Terms are wrapped as
 * phrases so a quoted multi-word query matches the phrase rather than nothing.
 */
function ftsPhrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function withinDateClause(column: string, from: string | undefined, to: string | undefined, params: SqlParam[]): string {
  const clauses: string[] = [];
  if (from) {
    clauses.push(`substr(${column}, 1, 10) >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`substr(${column}, 1, 10) <= ?`);
    params.push(to);
  }
  if (clauses.length === 0) return '';
  // A missing date can never fall inside a bounded range.
  return ` AND ${column} IS NOT NULL AND ${clauses.join(' AND ')}`;
}

export function receiptNeedsReview(receipt: Receipt): boolean {
  if (receipt.status === 'failed') return true;
  if (receipt.status === 'confirmed') return false;
  return (receipt.extraction?.warnings.length ?? 0) > 0;
}

function receiptSearchText(receipt: Receipt): string {
  return [receipt.merchant.name, receipt.notes, receipt.receiptNumber]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => normalizeSearchName(entry))
    .filter((entry) => entry.length > 0)
    .join(' ');
}

function newMeta(now: number): SyncMeta {
  return {
    ...EMPTY_SYNC_META,
    updatedAt: now,
    dirty: 1,
  };
}

const SYNC_STATE_KV_KEY = 'sync:state';

function parseSyncState(raw: string | null): RevisionCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RevisionCursor;
    if (typeof parsed.cursor !== 'number' || typeof parsed.epoch !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function blankReceipt(now: number): Receipt {
  return {
    ...newMeta(now),
    id: newId(),
    merchant: emptyMerchant(),
    purchasedAt: null,
    currency: 'SEK',
    total: null,
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
    status: 'draft',
    extraction: null,
    ocr: null,
    itemCount: 0,
  };
}

const UPSERT_CANONICAL = `
  INSERT INTO ${TABLE_CANONICAL_ENTITIES}(kind, id, updatedAt, deletedAt, rev, dirty, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(kind, id) DO UPDATE SET
    updatedAt = excluded.updatedAt,
    deletedAt = excluded.deletedAt,
    rev = excluded.rev,
    dirty = excluded.dirty,
    payload = excluded.payload`;

const UPSERT_RECEIPT_PROJECTION = `
  INSERT INTO ${TABLE_RECEIPT_PROJECTIONS}(
    id, updatedAt, deletedAt, rev, dirty, purchasedAt, total, merchantName,
    categoryId, status, itemCount, currency, searchText, needsReview)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    updatedAt = excluded.updatedAt,
    deletedAt = excluded.deletedAt,
    rev = excluded.rev,
    dirty = excluded.dirty,
    purchasedAt = excluded.purchasedAt,
    total = excluded.total,
    merchantName = excluded.merchantName,
    categoryId = excluded.categoryId,
    status = excluded.status,
    itemCount = excluded.itemCount,
    currency = excluded.currency,
    searchText = excluded.searchText,
    needsReview = excluded.needsReview`;

const UPSERT_ITEM_PROJECTION = `
  INSERT INTO ${TABLE_ITEM_PROJECTIONS}(
    id, receiptId, updatedAt, deletedAt, rev, dirty, lineNo, searchName,
    categoryId, totalPrice, unitPrice, isDiscount, isDeposit)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    receiptId = excluded.receiptId,
    updatedAt = excluded.updatedAt,
    deletedAt = excluded.deletedAt,
    rev = excluded.rev,
    dirty = excluded.dirty,
    lineNo = excluded.lineNo,
    searchName = excluded.searchName,
    categoryId = excluded.categoryId,
    totalPrice = excluded.totalPrice,
    unitPrice = excluded.unitPrice,
    isDiscount = excluded.isDiscount,
    isDeposit = excluded.isDeposit`;

export class IosDataRepository implements CanonicalRepositoryPort {
  private syncState: RevisionCursor | null = null;

  private readonly listeners = new Set<(event: RepositoryEvent) => void>();

  constructor(
    private readonly db: SqliteLikeAdapter,
    private readonly now: () => number = () => Date.now(),
  ) {}

  subscribe(listener: (event: RepositoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async runInTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  private emit(kinds: EntityKind[], reason: RepositoryEvent['reason']): void {
    const event: RepositoryEvent = { kinds, reason };
    for (const listener of this.listeners) listener(event);
  }

  private async writeEntity<K extends EntityKind>(
    kind: K,
    entity: CanonicalRecord<K>,
  ): Promise<CanonicalRecord<K>> {
    await this.db.transaction(async () => {
      await this.db.run(UPSERT_CANONICAL, [
        kind,
        entity.id,
        entity.updatedAt,
        entity.deletedAt,
        entity.rev,
        entity.dirty,
        JSON.stringify(entity),
      ]);

      if (kind === 'receipts') await this.writeReceiptProjection(entity as CanonicalRecord<'receipts'>);
      if (kind === 'items') await this.writeItemProjection(entity as CanonicalRecord<'items'>);
    });

    return entity;
  }

  private async writeReceiptProjection(receipt: Receipt): Promise<void> {
    await this.db.run(UPSERT_RECEIPT_PROJECTION, [
      receipt.id,
      receipt.updatedAt,
      receipt.deletedAt,
      receipt.rev,
      receipt.dirty,
      receipt.purchasedAt,
      receipt.total,
      receipt.merchant.name,
      receipt.categoryId,
      receipt.status,
      receipt.itemCount,
      receipt.currency,
      receiptSearchText(receipt),
      receiptNeedsReview(receipt) ? 1 : 0,
    ]);
  }

  private async writeItemProjection(item: ReceiptItem): Promise<void> {
    await this.db.run(UPSERT_ITEM_PROJECTION, [
      item.id,
      item.receiptId,
      item.updatedAt,
      item.deletedAt,
      item.rev,
      item.dirty,
      item.lineNo,
      item.searchName,
      item.categoryId,
      item.totalPrice,
      item.unitPrice,
      item.isDiscount ? 1 : 0,
      item.isDeposit ? 1 : 0,
    ]);
  }

  /** Rebuilds projections and the FTS indexes from the canonical payloads. */
  async rebuildFts(): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.execute(`DELETE FROM ${TABLE_RECEIPT_FTS}`);
      await this.db.execute(`DELETE FROM ${TABLE_ITEM_FTS}`);

      const receipts = await this.db.selectAll<PayloadRow>(
        `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = 'receipts'`,
      );
      for (const row of receipts) {
        await this.writeReceiptProjection(parsePayload<'receipts'>(row));
      }

      const items = await this.db.selectAll<PayloadRow>(
        `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = 'items'`,
      );
      for (const row of items) {
        await this.writeItemProjection(parsePayload<'items'>(row));
      }
    });
  }

  async getSpendSummary(): Promise<SpendSummary> {
    const receiptTotals = await this.db.selectFirst<{ receiptCount: number; total: number }>(
      `SELECT count(*) AS receiptCount, coalesce(sum(total), 0) AS total
       FROM ${TABLE_RECEIPT_PROJECTIONS} WHERE deletedAt = 0`,
    );

    const itemTotals = await this.db.selectFirst<{ itemCount: number }>(
      `SELECT count(*) AS itemCount FROM ${TABLE_ITEM_PROJECTIONS} WHERE deletedAt = 0`,
    );

    const byMonth = await this.db.selectAll<{ month: string; total: number; receipts: number }>(
      `SELECT coalesce(substr(purchasedAt, 1, 7), 'okant') AS month,
              sum(coalesce(total, 0)) AS total,
              count(*) AS receipts
       FROM ${TABLE_RECEIPT_PROJECTIONS}
       WHERE deletedAt = 0
       GROUP BY month
       ORDER BY month ASC`,
    );

    const byCategory = await this.db.selectAll<{ categoryId: string | null; total: number; count: number }>(
      `SELECT categoryId, sum(totalPrice) AS total, count(*) AS count
       FROM ${TABLE_ITEM_PROJECTIONS}
       WHERE deletedAt = 0 AND isDiscount = 0 AND isDeposit = 0
       GROUP BY categoryId
       ORDER BY total DESC`,
    );

    return {
      receiptCount: receiptTotals?.receiptCount ?? 0,
      itemCount: itemTotals?.itemCount ?? 0,
      total: Math.round((receiptTotals?.total ?? 0) * 100) / 100,
      byMonth,
      byCategory,
    };
  }

  async get<K extends EntityKind>(kind: K, id: ID): Promise<CanonicalRecord<K> | null> {
    const row = await this.db.selectFirst<PayloadRow>(
      `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = ? AND id = ?`,
      [kind, id],
    );
    return row ? parsePayload<K>(row) : null;
  }

  async upsert<K extends EntityKind>(kind: K, entity: CanonicalRecord<K>): Promise<CanonicalRecord<K>> {
    const out = await this.writeEntity(kind, entity);
    this.emit([kind], 'upsert');
    return out;
  }

  async tombstone<K extends EntityKind>(kind: K, id: ID, now: number): Promise<CanonicalRecord<K> | null> {
    const current = await this.get(kind, id);
    if (!current) return null;
    const next = {
      ...current,
      updatedAt: now,
      deletedAt: now,
      dirty: 1,
    } as CanonicalRecord<K>;

    await this.upsert(kind, next);
    this.emit([kind], 'tombstone');
    return next;
  }

  async list<K extends EntityKind>(kind: K, options: PageOptions): Promise<PageResult<CanonicalRecord<K>>> {
    const cursor = options.cursor ?? 0;
    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES}
       WHERE kind = ? AND rev > ?
       ORDER BY rev ASC, updatedAt ASC, id ASC
       LIMIT ?`,
      [kind, cursor, options.limit],
    );

    const items = rows.map((row) => parsePayload<K>(row));
    const nextCursor = items.reduce((max, row) => Math.max(max, row.rev), cursor);
    const more = await this.db.selectFirst<{ count: number }>(
      `SELECT count(*) AS count FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = ? AND rev > ?`,
      [kind, nextCursor],
    );

    return { items, nextCursor, hasMore: (more?.count ?? 0) > 0 };
  }

  async listDirty(limit: number): Promise<DirtySnapshot[]> {
    const rows = await this.db.selectAll<{ kind: EntityKind; payload: string }>(
      `SELECT kind, payload FROM ${TABLE_CANONICAL_ENTITIES}
       WHERE dirty = 1
       ORDER BY updatedAt ASC, kind ASC, id ASC
       LIMIT ?`,
      [limit],
    );

    return rows.map((row) => {
      const entity = parsePayload(row);
      return {
        kind: row.kind,
        id: entity.id,
        updatedAt: entity.updatedAt,
        entity,
      };
    });
  }

  async markCleanIfUpdatedAtMatches(snapshot: DirtySnapshot, rev: number): Promise<boolean> {
    const current = await this.get(snapshot.kind, snapshot.id);
    if (!current) return false;
    if (current.updatedAt !== snapshot.updatedAt) return false;
    await this.writeEntity(snapshot.kind, {
      ...current,
      dirty: 0 as const,
      rev,
    });
    this.emit([snapshot.kind], 'markClean');
    return true;
  }

  async dirtyAllAndResetRev(): Promise<void> {
    await this.db.transaction(async () => {
      const rows = await this.db.selectAll<{ kind: EntityKind; payload: string }>(
        `SELECT kind, payload FROM ${TABLE_CANONICAL_ENTITIES}`,
      );
      for (const row of rows) {
        const entity = parsePayload(row);
        entity.dirty = 1;
        entity.rev = 0;
        await this.writeEntity(row.kind, entity as CanonicalRecord<typeof row.kind>);
      }
    });
    this.emit([...ENTITY_KINDS], 'reset-rev');
  }

  async getSyncState(): Promise<RevisionCursor> {
    if (!this.syncState) {
      this.syncState = parseSyncState(await this.getKeyValue(SYNC_STATE_KV_KEY)) ?? {
        cursor: 0,
        epoch: 'epoch-1',
      };
    }
    return { ...this.syncState };
  }

  async getKeyValue(key: string): Promise<string | null> {
    const row = await this.db.selectFirst<{ value: string }>(
      `SELECT value FROM ${TABLE_KV} WHERE key = ?`,
      [key],
    );
    return row?.value ?? null;
  }

  async setKeyValue(key: string, value: string): Promise<void> {
    await this.db.run(
      `INSERT INTO ${TABLE_KV}(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  async deleteKeyValue(key: string): Promise<void> {
    await this.db.run(`DELETE FROM ${TABLE_KV} WHERE key = ?`, [key]);
  }

  async setSyncState(state: RevisionCursor): Promise<void> {
    this.syncState = { ...state };
    await this.setKeyValue(SYNC_STATE_KV_KEY, JSON.stringify(this.syncState));
  }

  async applyIncoming(changes: Partial<Record<EntityKind, AnyEntity[]>>): Promise<SyncApplyResult> {
    let applied = 0;
    let merged = 0;
    let skippedStale = 0;

    await this.db.transaction(async () => {
      for (const kind of ENTITY_KINDS) {
        const rows = changes[kind] ?? [];
        for (const incomingRow of rows) {
          const incoming = incomingRow as CanonicalRecord<typeof kind>;
          const current = await this.get(kind, incoming.id);
          if (!current) {
            await this.writeEntity(kind, incoming);
            applied += 1;
            continue;
          }

          if (kind === 'receipts') {
            const mergedReceipt = mergeIncomingReceipt(current as Receipt, incoming as Receipt);
            if (mergedReceipt) {
              await this.writeEntity(kind, mergedReceipt as CanonicalRecord<typeof kind>);
              merged += 1;
              continue;
            }
          }

          const winner = resolveConflict(
            current as EntityMap[typeof kind],
            incoming as EntityMap[typeof kind],
          ) as CanonicalRecord<typeof kind>;
          if (winner.id === current.id && winner.updatedAt === current.updatedAt && winner.rev === current.rev) {
            skippedStale += 1;
          } else {
            applied += 1;
          }
          await this.writeEntity(kind, winner);
        }
      }
    });

    this.emit([...ENTITY_KINDS], 'incoming');
    return { applied, merged, skippedStale };
  }

  async countByKind(): Promise<Record<EntityKind, number>> {
    const counts: Record<EntityKind, number> = {
      companies: 0,
      receipts: 0,
      items: 0,
      categories: 0,
      tags: 0,
      receiptTags: 0,
      secrets: 0,
    };

    const rows = await this.db.selectAll<{ kind: EntityKind; count: number }>(
      `SELECT kind, count(*) AS count FROM ${TABLE_CANONICAL_ENTITIES} GROUP BY kind`,
    );
    for (const row of rows) {
      if (row.kind in counts) counts[row.kind] = row.count;
    }

    return counts;
  }

  async countDirty(): Promise<number> {
    const row = await this.db.selectFirst<{ count: number }>(
      `SELECT count(*) AS count FROM ${TABLE_CANONICAL_ENTITIES} WHERE dirty = 1`,
    );
    return row?.count ?? 0;
  }

  async getReceipt(id: ID): Promise<Receipt | null> {
    return this.get('receipts', id);
  }

  /**
   * Live items for one receipt, in line order, read through the
   * `(receiptId, deletedAt, lineNo)` index. Rendering a receipt must not pull
   * every item in the database into JavaScript to filter it there.
   */
  async listReceiptItems(receiptId: ID): Promise<ReceiptItem[]> {
    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT c.payload AS payload
       FROM ${TABLE_ITEM_PROJECTIONS} ip
       JOIN ${TABLE_CANONICAL_ENTITIES} c ON c.kind = 'items' AND c.id = ip.id
       WHERE ip.receiptId = ? AND ip.deletedAt = 0
       ORDER BY ip.lineNo ASC, ip.id ASC`,
      [receiptId],
    );
    return rows.map((row) => parsePayload<'items'>(row));
  }

  async seedDefaultCategoriesOnce(): Promise<void> {
    const seeded = await this.getKeyValue('categories:seeded');
    if (seeded) return;
    const now = this.now();
    for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
      const id = seedCategoryId(category.slug);
      const existing = await this.get('categories', id);
      if (existing) continue;
      await this.upsert('categories', {
        ...newMeta(now),
        id,
        name: category.name,
        color: category.color,
        icon: category.icon,
        parentId: null,
        scope: category.scope,
        sortOrder: index,
      });
    }
    await this.setKeyValue('categories:seeded', String(now));
  }

  // ---------------------------------------------------------------------------
  // Taxonomy: categories and tags
  //
  // Both are small, user-editable sets, so they are read whole and sorted in
  // JavaScript rather than paged. What needs care is deletion: a receipt or an
  // item holds a `categoryId`, and a `receiptTags` row holds a `tagId`. Removing
  // the row those point at would leave a dangling reference that renders as a
  // blank category forever, so the references are cleared in the same
  // transaction as the tombstone.
  // ---------------------------------------------------------------------------

  /** Every live category, in the order they should be shown. */
  async listCategories(): Promise<Category[]> {
    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = 'categories' AND deletedAt = 0`,
    );
    return rows
      .map((row) => parsePayload<'categories'>(row))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'sv'));
  }

  /** Every live tag, alphabetically. Tags have no explicit order. */
  async listTags(): Promise<Tag[]> {
    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = 'tags' AND deletedAt = 0`,
    );
    return rows
      .map((row) => parsePayload<'tags'>(row))
      .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  }

  /** How much would break if this category were deleted. */
  async countCategoryUsage(categoryId: ID): Promise<{ receipts: number; items: number }> {
    const receipts = await this.db.selectFirst<{ count: number }>(
      `SELECT count(*) AS count FROM ${TABLE_RECEIPT_PROJECTIONS} WHERE categoryId = ? AND deletedAt = 0`,
      [categoryId],
    );
    const items = await this.db.selectFirst<{ count: number }>(
      `SELECT count(*) AS count FROM ${TABLE_ITEM_PROJECTIONS} WHERE categoryId = ? AND deletedAt = 0`,
      [categoryId],
    );
    return { receipts: receipts?.count ?? 0, items: items?.count ?? 0 };
  }

  /** Live links pointing at one tag. Links have no projection table. */
  private async listLinksForTag(tagId: ID): Promise<CanonicalRecord<'receiptTags'>[]> {
    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = 'receiptTags' AND deletedAt = 0`,
    );
    return rows.map((row) => parsePayload<'receiptTags'>(row)).filter((link) => link.tagId === tagId);
  }

  async countTagUsage(tagId: ID): Promise<{ receipts: number }> {
    const links = await this.listLinksForTag(tagId);
    return { receipts: new Set(links.map((link) => link.receiptId)).size };
  }

  /**
   * Creates or renames a category. `id` absent means create.
   *
   * A new category sorts after every existing one instead of at 0, so adding
   * one does not silently reshuffle the list the user already arranged.
   */
  async saveCategory(input: {
    id?: ID;
    name: string;
    color: string;
    icon?: string | null;
    scope?: Category['scope'];
    parentId?: ID | null;
  }): Promise<Category> {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('A category needs a name.');

    const now = this.now();
    const existing = input.id ? await this.get('categories', input.id) : null;

    const next: Category = existing
      ? {
          ...existing,
          name,
          color: input.color,
          icon: input.icon === undefined ? existing.icon : input.icon,
          scope: input.scope ?? existing.scope,
          parentId: input.parentId === undefined ? existing.parentId : input.parentId,
          updatedAt: now,
          dirty: 1,
        }
      : {
          ...newMeta(now),
          id: input.id ?? newId(),
          name,
          color: input.color,
          icon: input.icon ?? null,
          parentId: input.parentId ?? null,
          scope: input.scope ?? 'both',
          sortOrder: (await this.listCategories()).reduce((max, row) => Math.max(max, row.sortOrder + 1), 0),
        };

    await this.upsert('categories', next);
    this.emit(['categories'], 'mutation');
    return next;
  }

  async saveTag(input: { id?: ID; name: string; color: string }): Promise<Tag> {
    const name = input.name.trim();
    if (name.length === 0) throw new Error('A tag needs a name.');

    const now = this.now();
    const existing = input.id ? await this.get('tags', input.id) : null;

    const next: Tag = existing
      ? { ...existing, name, color: input.color, updatedAt: now, dirty: 1 }
      : { ...newMeta(now), id: input.id ?? newId(), name, color: input.color };

    await this.upsert('tags', next);
    this.emit(['tags'], 'mutation');
    return next;
  }

  /**
   * Tombstones a category and clears it from every receipt and item that used
   * it, so nothing is left pointing at a deleted row.
   *
   * Writes go through `writeEntity` rather than `upsert` because `upsert`
   * notifies on every call: clearing a category used by two hundred receipts
   * would otherwise wake every subscriber two hundred times mid-transaction,
   * each one reading a half-applied database. One event is emitted at the end.
   */
  async deleteCategory(id: ID): Promise<{ receipts: number; items: number } | null> {
    const current = await this.get('categories', id);
    if (!current || current.deletedAt !== 0) return null;

    const now = this.now();
    let receipts = 0;
    let items = 0;

    await this.runInTransaction(async () => {
      await this.writeEntity('categories', { ...current, deletedAt: now, updatedAt: now, dirty: 1 });

      const receiptIds = await this.db.selectAll<{ id: ID }>(
        `SELECT id FROM ${TABLE_RECEIPT_PROJECTIONS} WHERE categoryId = ?`,
        [id],
      );
      for (const row of receiptIds) {
        const receipt = await this.get('receipts', row.id);
        if (!receipt) continue;
        await this.writeEntity('receipts', { ...receipt, categoryId: null, updatedAt: now, dirty: 1 });
        receipts += 1;
      }

      const itemIds = await this.db.selectAll<{ id: ID }>(
        `SELECT id FROM ${TABLE_ITEM_PROJECTIONS} WHERE categoryId = ?`,
        [id],
      );
      for (const row of itemIds) {
        const item = await this.get('items', row.id);
        if (!item) continue;
        await this.writeEntity('items', { ...item, categoryId: null, updatedAt: now, dirty: 1 });
        items += 1;
      }
    });

    this.emit(['categories', 'receipts', 'items'], 'tombstone');
    return { receipts, items };
  }

  /** Tombstones a tag and every link that attached it to a receipt. */
  async deleteTag(id: ID): Promise<{ links: number } | null> {
    const current = await this.get('tags', id);
    if (!current || current.deletedAt !== 0) return null;

    const now = this.now();
    let links = 0;

    await this.runInTransaction(async () => {
      await this.writeEntity('tags', { ...current, deletedAt: now, updatedAt: now, dirty: 1 });
      for (const link of await this.listLinksForTag(id)) {
        await this.writeEntity('receiptTags', { ...link, deletedAt: now, updatedAt: now, dirty: 1 });
        links += 1;
      }
    });

    this.emit(['tags', 'receiptTags'], 'tombstone');
    return { links };
  }

  async createReceipt(overrides: Partial<Receipt> = {}): Promise<Receipt> {
    const base = blankReceipt(this.now());
    const next = { ...base, ...overrides, id: overrides.id ?? base.id };
    await this.upsert('receipts', next);
    this.emit(['receipts'], 'mutation');
    return next;
  }

  async updateReceipt(id: ID, patch: Partial<Receipt>): Promise<Receipt | null> {
    const current = await this.get('receipts', id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      updatedAt: this.now(),
      dirty: 1 as const,
    };
    await this.upsert('receipts', next);
    this.emit(['receipts'], 'mutation');
    return next;
  }

  async addItem(receiptId: ID, patch: Partial<ReceiptItem> = {}): Promise<ReceiptItem> {
    const nextLine = await this.db.selectFirst<{ lineNo: number }>(
      `SELECT coalesce(max(lineNo) + 1, 0) AS lineNo FROM ${TABLE_ITEM_PROJECTIONS} WHERE receiptId = ?`,
      [receiptId],
    );
    const lineNo = nextLine?.lineNo ?? 0;
    const name = patch.name ?? 'Ny rad';
    const now = this.now();

    const item: ReceiptItem = {
      ...newMeta(now),
      id: patch.id ?? newId(),
      receiptId,
      lineNo,
      name,
      rawName: null,
      searchName: normalizeSearchName(name),
      quantity: 1,
      unit: 'st',
      unitPrice: null,
      totalPrice: 0,
      discount: null,
      vatRate: null,
      categoryId: null,
      ean: null,
      deposit: null,
      isDeposit: false,
      isDiscount: false,
      notes: null,
      ...patch,
    };

    if (typeof patch.name === 'string') {
      item.searchName = normalizeSearchName(patch.name);
    }

    await this.upsert('items', item);
    await this.refreshReceiptItemCount(receiptId);
    this.emit(['items', 'receipts'], 'mutation');
    return item;
  }

  async updateItem(id: ID, patch: Partial<ReceiptItem>): Promise<ReceiptItem | null> {
    const current = await this.get('items', id);
    if (!current) return null;
    const now = this.now();
    const next: ReceiptItem = {
      ...current,
      ...patch,
      updatedAt: now,
      dirty: 1,
      searchName: typeof patch.name === 'string' ? normalizeSearchName(patch.name) : current.searchName,
    };
    await this.upsert('items', next);
    await this.refreshReceiptItemCount(current.receiptId);
    this.emit(['items', 'receipts'], 'mutation');
    return next;
  }

  private async refreshReceiptItemCount(receiptId: ID): Promise<void> {
    const current = await this.get('receipts', receiptId);
    if (!current) return;
    const row = await this.db.selectFirst<{ count: number }>(
      `SELECT count(*) AS count FROM ${TABLE_ITEM_PROJECTIONS} WHERE receiptId = ? AND deletedAt = 0`,
      [receiptId],
    );
    await this.upsert('receipts', {
      ...current,
      itemCount: row?.count ?? 0,
      updatedAt: this.now(),
      dirty: 1,
    });
  }

  async deleteItem(id: ID): Promise<void> {
    const current = await this.get('items', id);
    if (!current) return;
    const now = this.now();
    await this.upsert('items', {
      ...current,
      deletedAt: now,
      updatedAt: now,
      dirty: 1,
    });
    await this.refreshReceiptItemCount(current.receiptId);
    this.emit(['items', 'receipts'], 'tombstone');
  }

  async restoreItem(id: ID): Promise<void> {
    const current = await this.get('items', id);
    if (!current || current.deletedAt === 0) return;
    await this.upsert('items', {
      ...current,
      deletedAt: 0,
      updatedAt: this.now(),
      dirty: 1,
    });
    await this.refreshReceiptItemCount(current.receiptId);
    this.emit(['items', 'receipts'], 'restore');
  }

  /** Receipt-tag links have no projection table, so they are filtered on payload. */
  private async listReceiptTagLinks(receiptId: ID): Promise<CanonicalRecord<'receiptTags'>[]> {
    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT payload FROM ${TABLE_CANONICAL_ENTITIES} WHERE kind = 'receiptTags'`,
    );
    return rows
      .map((row) => parsePayload<'receiptTags'>(row))
      .filter((link) => link.receiptId === receiptId);
  }

  private async listItemIdsForReceipt(receiptId: ID): Promise<ID[]> {
    const rows = await this.db.selectAll<{ id: ID }>(
      `SELECT id FROM ${TABLE_ITEM_PROJECTIONS} WHERE receiptId = ?`,
      [receiptId],
    );
    return rows.map((row) => row.id);
  }

  async deleteReceipt(id: ID): Promise<void> {
    const current = await this.get('receipts', id);
    if (!current) return;
    const deletedAt = this.now();

    await this.runInTransaction(async () => {
      await this.upsert('receipts', {
        ...current,
        deletedAt,
        updatedAt: deletedAt,
        dirty: 1,
      });

      for (const itemId of await this.listItemIdsForReceipt(id)) {
        const item = await this.get('items', itemId);
        if (!item) continue;
        await this.upsert('items', {
          ...item,
          deletedAt,
          updatedAt: deletedAt,
          dirty: 1,
        });
      }

      for (const link of await this.listReceiptTagLinks(id)) {
        await this.upsert('receiptTags', {
          ...link,
          deletedAt,
          updatedAt: deletedAt,
          dirty: 1,
        });
      }
    });

    this.emit(['receipts', 'items', 'receiptTags'], 'tombstone');
  }

  async restoreReceipt(id: ID): Promise<void> {
    const current = await this.get('receipts', id);
    if (!current || current.deletedAt === 0) return;
    const deletedAt = current.deletedAt;
    const now = this.now();

    await this.runInTransaction(async () => {
      await this.upsert('receipts', {
        ...current,
        deletedAt: 0,
        updatedAt: now,
        dirty: 1,
      });

      for (const itemId of await this.listItemIdsForReceipt(id)) {
        const item = await this.get('items', itemId);
        if (!item || item.deletedAt !== deletedAt) continue;
        await this.upsert('items', {
          ...item,
          deletedAt: 0,
          updatedAt: now,
          dirty: 1,
        });
      }

      for (const link of await this.listReceiptTagLinks(id)) {
        if (link.deletedAt !== deletedAt) continue;
        await this.upsert('receiptTags', {
          ...link,
          deletedAt: 0,
          updatedAt: now,
          dirty: 1,
        });
      }
    });

    this.emit(['receipts', 'items', 'receiptTags'], 'restore');
  }

  async queryReceipts(
    filter: ReceiptFilter,
    limit: number,
    cursor?: ReceiptListCursor,
  ): Promise<{ items: Receipt[]; nextCursor: ReceiptListCursor | null; hasMore: boolean }> {
    const params: SqlParam[] = [];
    let where = 'p.deletedAt = 0';

    if (filter.statuses && filter.statuses.length > 0) {
      where += ` AND p.status IN (${placeholders(filter.statuses.length)})`;
      params.push(...filter.statuses);
    }

    if (filter.categoryIds && filter.categoryIds.length > 0) {
      where += ` AND p.categoryId IN (${placeholders(filter.categoryIds.length)})`;
      params.push(...filter.categoryIds);
    }

    where += withinDateClause('p.purchasedAt', filter.from, filter.to, params);

    if (filter.minTotal !== undefined) {
      where += ' AND coalesce(p.total, 0) >= ?';
      params.push(filter.minTotal);
    }
    if (filter.maxTotal !== undefined) {
      where += ' AND coalesce(p.total, 0) <= ?';
      params.push(filter.maxTotal);
    }

    if (filter.needsReview) {
      where += ' AND p.needsReview = 1';
    }

    const terms = filter.query ? tokenizeQuery(filter.query) : [];
    if (terms.length > 0) {
      // A receipt matches when its own text carries every term, or when any of
      // its line items matches one of them.
      where += `
        AND (
          p.id IN (SELECT id FROM ${TABLE_RECEIPT_FTS} WHERE ${TABLE_RECEIPT_FTS} MATCH ?)
          OR p.id IN (
            SELECT ip.receiptId FROM ${TABLE_ITEM_PROJECTIONS} ip
            WHERE ip.deletedAt = 0
              AND ip.id IN (SELECT id FROM ${TABLE_ITEM_FTS} WHERE ${TABLE_ITEM_FTS} MATCH ?)
          )
        )`;
      params.push(terms.map(ftsPhrase).join(' AND '));
      params.push(terms.map(ftsPhrase).join(' OR '));
    }

    if (cursor) {
      if (cursor.purchasedAt === null) {
        where += ' AND p.purchasedAt IS NULL AND p.id > ?';
        params.push(cursor.id);
      } else {
        where += ' AND (p.purchasedAt IS NULL OR p.purchasedAt < ? OR (p.purchasedAt = ? AND p.id > ?))';
        params.push(cursor.purchasedAt, cursor.purchasedAt, cursor.id);
      }
    }

    const rows = await this.db.selectAll<PayloadRow>(
      `SELECT c.payload AS payload
       FROM ${TABLE_RECEIPT_PROJECTIONS} p
       JOIN ${TABLE_CANONICAL_ENTITIES} c ON c.kind = 'receipts' AND c.id = p.id
       WHERE ${where}
       ORDER BY (p.purchasedAt IS NULL) ASC, p.purchasedAt DESC, p.id ASC
       LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => parsePayload<'receipts'>(row));
    const tail = items.at(-1) ?? null;

    return {
      items,
      hasMore,
      nextCursor: tail ? { id: tail.id, purchasedAt: tail.purchasedAt } : null,
    };
  }

  async queryPurchases(
    filter: PurchaseFilter,
    limit: number,
    cursor?: PurchaseListCursor,
  ): Promise<{ items: PurchaseRow[]; nextCursor: PurchaseListCursor | null; hasMore: boolean }> {
    const params: SqlParam[] = [];
    let where = 'ip.deletedAt = 0 AND rp.deletedAt = 0';

    if (!(filter.includeDiscounts ?? false)) where += ' AND ip.isDiscount = 0';
    if (!(filter.includeDeposits ?? false)) where += ' AND ip.isDeposit = 0';

    if (filter.categoryIds && filter.categoryIds.length > 0) {
      where += ` AND ip.categoryId IN (${placeholders(filter.categoryIds.length)})`;
      params.push(...filter.categoryIds);
    }

    if (filter.minPrice !== undefined) {
      where += ' AND ip.totalPrice >= ?';
      params.push(filter.minPrice);
    }
    if (filter.maxPrice !== undefined) {
      where += ' AND ip.totalPrice <= ?';
      params.push(filter.maxPrice);
    }

    // Item search stays substring-based so partial words keep matching.
    for (const term of filter.query ? tokenizeQuery(filter.query) : []) {
      where += " AND ip.searchName LIKE '%' || ? || '%'";
      params.push(term);
    }

    where += withinDateClause('rp.purchasedAt', filter.from, filter.to, params);

    if (cursor) {
      where += ' AND (ip.updatedAt < ? OR (ip.updatedAt = ? AND ip.id > ?))';
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }

    const rows = await this.db.selectAll<{
      payload: string;
      receiptId: ID;
      merchantName: string | null;
      purchasedAt: string | null;
      currency: string;
    }>(
      `SELECT ic.payload AS payload, rp.id AS receiptId, rp.merchantName AS merchantName,
              rp.purchasedAt AS purchasedAt, rp.currency AS currency
       FROM ${TABLE_ITEM_PROJECTIONS} ip
       JOIN ${TABLE_CANONICAL_ENTITIES} ic ON ic.kind = 'items' AND ic.id = ip.id
       JOIN ${TABLE_RECEIPT_PROJECTIONS} rp ON rp.id = ip.receiptId
       WHERE ${where}
       ORDER BY ip.updatedAt DESC, ip.id ASC
       LIMIT ?`,
      [...params, limit + 1],
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      item: parsePayload<'items'>(row),
      receiptId: row.receiptId,
      merchantName: row.merchantName,
      purchasedAt: row.purchasedAt,
      currency: row.currency,
    }));
    const tail = items.at(-1)?.item;

    return {
      items,
      hasMore,
      nextCursor: tail ? { id: tail.id, updatedAt: tail.updatedAt } : null,
    };
  }
}
