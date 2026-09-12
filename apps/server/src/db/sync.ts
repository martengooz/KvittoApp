/**
 * Server-side sync storage: revision assignment, conflict resolution, paging.
 */

import { and, asc, eq, gt, sql } from 'drizzle-orm';

import {
  ENTITY_KINDS,
  resolveConflict,
  type AnyEntity,
  type ChangeSet,
  type EntityKind,
  type PushResult,
} from '@kvitto/shared';

import { getConnection, getDb, schema } from './index.ts';

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
        const validation = validate(incoming);
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
          const stored = JSON.parse(existing.payload) as AnyEntity;
          const winner = resolveConflict(stored, incoming);
          if (winner !== incoming) {
            results.push({ kind, id: incoming.id, rev: existing.rev, outcome: 'stale' });
            continue;
          }
        }

        const rev = nextRev(accountId);
        cursor = rev;
        const payload = JSON.stringify({ ...incoming, rev, dirty: 0 });

        const values = {
          id: incoming.id,
          accountId,
          rev,
          updatedAt: incoming.updatedAt,
          deletedAt: incoming.deletedAt,
          payload,
          lastDeviceId: deviceId,
        };

        db.insert(table)
          .values(values)
          .onConflictDoUpdate({ target: table.id, set: values })
          .run();

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
  let highest = since;
  let remaining = limit;
  let hasMore = false;

  for (const kind of ENTITY_KINDS) {
    if (remaining <= 0) {
      // Something is still waiting in a later kind.
      hasMore = hasMore || hasRowsAfter(accountId, kind, since);
      continue;
    }

    const table = tableFor(kind);
    const rows = db
      .select()
      .from(table)
      .where(and(eq(table.accountId, accountId), gt(table.rev, since)))
      .orderBy(asc(table.rev))
      // One extra row tells us whether another page exists without a count query.
      .limit(remaining + 1)
      .all() as StoredRow[];

    const page = rows.slice(0, remaining);
    if (rows.length > remaining) hasMore = true;
    if (page.length === 0) continue;

    (changes as Record<string, unknown[]>)[kind] = page.map((row) => ({
      ...(JSON.parse(row.payload) as AnyEntity),
      rev: row.rev,
      dirty: 0,
    }));

    for (const row of page) highest = Math.max(highest, row.rev);
    remaining -= page.length;
  }

  // When a page was cut short, resume from the highest revision actually sent,
  // never from the account's current counter, or the gap would be lost.
  return { changes, cursor: hasMore ? highest : currentRev(accountId), hasMore };
}

function hasRowsAfter(accountId: string, kind: EntityKind, since: number): boolean {
  const table = tableFor(kind);
  const row = getDb()
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.accountId, accountId), gt(table.rev, since)))
    .limit(1)
    .all()[0];
  return row !== undefined;
}

/** Returns an error string when the record is unusable, or `null` when it is fine. */
function validate(record: unknown): string | null {
  if (!record || typeof record !== 'object') return 'Record is not an object.';
  const row = record as Partial<AnyEntity>;
  if (typeof row.id !== 'string' || row.id.length === 0) return 'Missing id.';
  if (row.id.length > 128) return 'Id is too long.';
  if (typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt)) return 'Missing updatedAt.';
  if (typeof row.deletedAt !== 'number' || !Number.isFinite(row.deletedAt)) return 'Missing deletedAt.';

  // A payload far larger than any real receipt is either a bug or an attempt to
  // fill the disk; either way it should not be stored.
  const size = JSON.stringify(record).length;
  if (size > 512 * 1024) return `Record is too large (${size} bytes).`;
  return null;
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
