export const DATABASE_NAME = 'kvitto-ios.db';

// Canonical JSON payload table with projected sync metadata for fast filters.
export const TABLE_CANONICAL_ENTITIES = 'canonical_entities';
export const TABLE_RECEIPT_PROJECTIONS = 'receipt_projections';
export const TABLE_ITEM_PROJECTIONS = 'item_projections';
export const TABLE_RECEIPT_FTS = 'receipt_fts';
export const TABLE_ITEM_FTS = 'item_fts';
export const TABLE_KV = 'kv';
export const TABLE_SYNC_STATE = 'sync_state';
export const TABLE_DURABLE_JOBS = 'durable_jobs';

export interface CanonicalEntityRow {
  kind: string;
  id: string;
  updatedAt: number;
  deletedAt: number;
  rev: number;
  dirty: 0 | 1;
  payload: string;
}

export interface ReceiptProjectionRow {
  id: string;
  updatedAt: number;
  deletedAt: number;
  rev: number;
  dirty: 0 | 1;
  purchasedAt: string | null;
  total: number | null;
  merchantName: string | null;
  categoryId: string | null;
  status: string;
  itemCount: number;
  currency: string;
  searchText: string;
  needsReview: 0 | 1;
}

export interface ItemProjectionRow {
  id: string;
  receiptId: string;
  updatedAt: number;
  deletedAt: number;
  rev: number;
  dirty: 0 | 1;
  lineNo: number;
  searchName: string;
  categoryId: string | null;
  totalPrice: number;
  unitPrice: number | null;
  isDiscount: 0 | 1;
  isDeposit: 0 | 1;
}

export interface SyncStateRow {
  singleton: 1;
  cursor: number;
  epoch: string;
  updatedAt: number;
}

export interface DurableJobRow {
  id: string;
  queueName: string;
  type: string;
  payload: string;
  status: string;
  runAfter: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
