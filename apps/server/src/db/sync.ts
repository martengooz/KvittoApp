/**
 * Server-side sync storage: revision assignment, conflict resolution, paging.
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import {
  ENTITY_KINDS,
  SECRET_NAMES,
  resolveConflict,
  type AnyEntity,
  type ChangeSet,
  type EntityKind,
  type EntityMap,
  type PushResult,
} from '@kvitto/shared';

import { getConnection, getDb, schema } from './index.ts';
import { decryptSecretPayload, encryptSecretPayload } from './secret-crypto.ts';

/** Fields the server keeps in dedicated columns; the rest live in `payload`. */
interface StoredRow {
  id: string;
  accountId: string;
  rev: number;
  updatedAt: number;
  deletedAt: number;
  payload: string;
  lastDeviceId: string | null;
}

function tableFor(kind: EntityKind) {
  return schema.ENTITY_TABLES[kind];
}

/**
 * Writes one entity row, inserting it or overwriting the existing one —
 * the shape both {@link applyPush} and {@link writeServerRecords} give a
 * record before storing it, the two differing only in whose id goes in
 * `lastDeviceId`.
 */
function upsertEntityRow(
  kind: EntityKind,
  row: { id: string; accountId: string; rev: number; updatedAt: number; deletedAt: number; payload: string; lastDeviceId: string },
): void {
  const table = tableFor(kind);
  getDb().insert(table).values(row).onConflictDoUpdate({ target: table.id, set: row }).run();
}

/**
 * Allocates the next revision for an account.
 *
 * Called inside the push transaction so revisions are gap-free and strictly
 * increasing, which is what makes `rev > cursor` a complete and correct pull.
 */
function nextRev(accountId: string): number {
  const db = getDb();
  db.update(schema.accounts)
    .set({ revCounter: sql`${schema.accounts.revCounter} + 1` })
    .where(eq(schema.accounts.id, accountId))
    .run();

  const row = db
    .select({ rev: schema.accounts.revCounter })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1)
    .all()[0];

  if (!row) throw new Error(`Unknown account ${accountId}`);
  return row.rev;
}

export function currentRev(accountId: string): number {
  const row = getDb()
    .select({ rev: schema.accounts.revCounter })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1)
    .all()[0];
  return row?.rev ?? 0;
}

/**
 * Applies a pushed change set.
 *
 * Each record is compared against what the server holds using the *same*
 * `resolveConflict` the client runs, so both sides independently agree on the
 * winner. A record the server already has a newer version of comes back as
 * `stale`, and the client picks it up on the next pull rather than having it
 * force-written here.
 */
export function applyPush(
  accountId: string,
  deviceId: string,
  changes: ChangeSet,
): { results: PushResult[]; cursor: number } {
  const db = getDb();
  const results: PushResult[] = [];
  let cursor = currentRev(accountId);

  // One transaction for the whole batch: a partially-applied push would leave
  // the client believing records synced that did not.
  getConnection().transaction(() => {
    for (const kind of ENTITY_KINDS) {
      const rows = changes[kind] as AnyEntity[] | undefined;
      if (!rows?.length) continue;
      const table = tableFor(kind);

      for (const incoming of rows) {
        const validation = validate(kind, incoming);
        if (validation) {
          results.push({ kind, id: String(incoming?.id ?? ''), rev: 0, outcome: 'rejected', reason: validation });
          continue;
        }

        const existing = db
          .select()
          .from(table)
          .where(and(eq(table.id, incoming.id), eq(table.accountId, accountId)))
          .limit(1)
          .all()[0] as StoredRow | undefined;

        if (existing) {
          const stored = parsePayload(kind, existing.payload);
          const winner = resolveConflict(stored, incoming);
          if (winner !== incoming) {
            results.push({ kind, id: incoming.id, rev: existing.rev, outcome: 'stale' });
            continue;
          }
        }

        const rev = nextRev(accountId);
        cursor = rev;
        const payload = serializePayload(kind, { ...incoming, rev, dirty: 0 } as AnyEntity);

        upsertEntityRow(kind, {
          id: incoming.id,
          accountId,
          rev,
          updatedAt: incoming.updatedAt,
          deletedAt: incoming.deletedAt,
          payload,
          lastDeviceId: deviceId,
        });

        results.push({ kind, id: incoming.id, rev, outcome: 'applied' });
      }
    }
  })();

  return { results, cursor };
}

/**
 * Returns records with `rev > since`, oldest revision first, across all kinds.
 *
 * Paging is by revision rather than offset, so a record written mid-pull cannot
 * cause another to be skipped.
 */
export function pull(
  accountId: string,
  since: number,
  limit: number,
): { changes: ChangeSet; cursor: number; hasMore: boolean } {
  const db = getDb();
  const changes: ChangeSet = {};
  const candidates: { kind: EntityKind; row: StoredRow }[] = [];

  for (const kind of ENTITY_KINDS) {
    const table = tableFor(kind);
    const rows = db
      .select()
      .from(table)
      .where(and(eq(table.accountId, accountId), gt(table.rev, since)))
      .orderBy(asc(table.rev))
      .limit(limit + 1)
      .all() as StoredRow[];
    candidates.push(...rows.map((row) => ({ kind, row })));
  }

  candidates.sort((left, right) => left.row.rev - right.row.rev);
  const page = candidates.slice(0, limit);
  for (const { kind, row } of page) {
    const records = ((changes as Record<string, unknown[]>)[kind] ??= []);
    records.push({ ...parsePayload(kind, row.payload), rev: row.rev, dirty: 0 });
  }

  const hasMore = candidates.length > limit;
  const highest = page.at(-1)?.row.rev ?? since;
  // When a page was cut short, resume from the highest revision actually sent,
  // never from the account's current counter, or the gap would be lost.
  return { changes, cursor: hasMore ? highest : currentRev(accountId), hasMore };
}

/** Returns an error string when the record is unusable, or `null` when it is fine. */
function validate(kind: EntityKind, record: unknown): string | null {
  if (!record || typeof record !== 'object') return 'Record is not an object.';
  const row = record as Partial<AnyEntity>;
  if (typeof row.id !== 'string' || row.id.length === 0) return 'Missing id.';
  if (row.id.length > 128) return 'Id is too long.';
  if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) return 'Missing updatedAt.';
  if (typeof row.deletedAt !== 'number' || !Number.isFinite(row.deletedAt)) return 'Missing deletedAt.';

  if (kind === 'secrets') {
    if (!(SECRET_NAMES as readonly string[]).includes(row.id)) return 'Unknown secret name.';
    const value = (record as { value?: unknown }).value;
    if (typeof value !== 'string') return 'Secret value must be a string.';
    if (value.length > 16_384) return 'Secret value is too long.';
  }

  // A payload far larger than any real receipt is either a bug or an attempt to
  // fill the disk; either way it should not be stored.
  const size = JSON.stringify(record).length;
  if (size > 512 * 1024) return `Record is too large (${size} bytes).`;
  return null;
}

// --- writes the server makes on its own behalf ----------------------------

/**
 * Reads one stored record.
 *
 * The server is normally a relay and has no business interpreting payloads;
 * the local extractor is the one component that does, so it gets a way in.
 */
export function readRecord<K extends EntityKind>(
  accountId: string,
  kind: K,
  id: string,
): EntityMap[K] | null {
  const table = tableFor(kind);
  const row = getDb()
    .select()
    .from(table)
    .where(and(eq(table.id, id), eq(table.accountId, accountId)))
    .limit(1)
    .all()[0] as StoredRow | undefined;
  if (!row) return null;
  return { ...(parsePayload(kind, row.payload) as EntityMap[K]), rev: row.rev, dirty: 0 };
}

/**
 * Writes records the *server* produced, allocating revisions as it goes.
 *
 * Deliberately the same table, the same counter and the same `rev` sequence a
 * device write uses. That is the whole design: an extraction the server made is
 * not a separate channel a client has to poll — it is an ordinary change with
 * an ordinary revision, and it reaches every device through the pull they were
 * already doing.
 *
 * The one difference from {@link applyPush} is that there is no conflict check,
 * because the caller has already merged against the stored copy inside this
 * same transaction.
 */
export function writeServerRecords(
  accountId: string,
  records: { kind: EntityKind; record: AnyEntity }[],
): number {
  if (records.length === 0) return currentRev(accountId);
  let cursor = currentRev(accountId);

  getConnection().transaction(() => {
    for (const { kind, record } of records) {
      const rev = nextRev(accountId);
      cursor = rev;

      upsertEntityRow(kind, {
        id: record.id,
        accountId,
        rev,
        updatedAt: record.updatedAt,
        deletedAt: record.deletedAt,
        payload: serializePayload(kind, { ...record, rev, dirty: 0 } as AnyEntity),
        // Named rather than left null so a device syncing its own change back
        // can see the write did not come from another phone.
        lastDeviceId: SERVER_DEVICE_ID,
      });
    }
  })();

  return cursor;
}

/** `lastDeviceId` on rows the server wrote itself. */
export const SERVER_DEVICE_ID = 'server';

function serializePayload(kind: EntityKind, record: AnyEntity): string {
  const payload = JSON.stringify(record);
  return kind === 'secrets' ? encryptSecretPayload(payload) : payload;
}

function parsePayload(kind: EntityKind, payload: string): AnyEntity {
  const plaintext = kind === 'secrets' ? decryptSecretPayload(payload) : payload;
  return JSON.parse(plaintext) as AnyEntity;
}

/** Live (non-tombstoned) line items belonging to a receipt. */
export function countLiveItems(accountId: string, receiptId: string): number {
  const table = tableFor('items');
  // `receiptId` lives inside the JSON payload, not its own column, but SQLite's
  // `json_extract` still lets the predicate run in the query rather than
  // pulling every item row for the account into JS to filter one at a time.
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(
      and(
        eq(table.accountId, accountId),
        eq(table.deletedAt, 0),
        sql`json_extract(${table.payload}, '$.receiptId') = ${receiptId}`,
      ),
    )
    .all()[0];
  return row?.count ?? 0;
}

/** The account's non-deleted categories. */
export function listLiveCategories(accountId: string): EntityMap['categories'][] {
  const table = tableFor('categories');
  const rows = getDb()
    .select({ payload: table.payload })
    .from(table)
    .where(and(eq(table.accountId, accountId), eq(table.deletedAt, 0)))
    .all() as { payload: string }[];

  const categories: EntityMap['categories'][] = [];
  for (const row of rows) {
    try {
      categories.push(JSON.parse(row.payload) as EntityMap['categories']);
    } catch {
      // Skip a payload that will not parse rather than failing the extraction.
    }
  }
  return categories;
}

/**
 * How many records are waiting for a client at `since`, per kind.
 *
 * Counts only — no payloads. This is what makes the idle heartbeat nearly free:
 * a device that has nothing to collect learns so in one small response instead
 * of a page of records it already has.
 */
export function pendingCounts(
  accountId: string,
  since: number,
): { perKind: Partial<Record<EntityKind, number>>; total: number } {
  const db = getDb();
  const perKind: Partial<Record<EntityKind, number>> = {};
  let total = 0;

  for (const kind of ENTITY_KINDS) {
    const table = tableFor(kind);
    const row = db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(and(eq(table.accountId, accountId), gt(table.rev, since)))
      .all()[0];
    const count = row?.count ?? 0;
    if (count > 0) {
      perKind[kind] = count;
      total += count;
    }
  }
  return { perKind, total };
}

/** Row counts per kind, for the health endpoint. */
export function stats(accountId: string): Record<string, number> {
  const db = getDb();
  const counts: Record<string, number> = {};
  for (const kind of ENTITY_KINDS) {
    const table = tableFor(kind);
    const row = db
      .select({ count: sql<number>`count(*)` })
      .from(table)
      .where(eq(table.accountId, accountId))
      .all()[0];
    counts[kind] = row?.count ?? 0;
  }
  return counts;
}
