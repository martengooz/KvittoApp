/**
 * Wire contracts between the PWA and the companion sync server.
 *
 * The model is deliberately simple: every record carries a client `updatedAt`
 * and a server-assigned `rev`. Clients push everything dirty, then pull
 * everything with `rev > cursor`. Conflicts resolve last-write-wins on
 * `updatedAt`, with the server's id as the tie-breaker so both sides converge
 * on the same answer.
 */

import type { AnyEntity, EntityKind, EntityMap, ID } from './types.js';

export const SYNC_PROTOCOL_VERSION = 1;

/** A batch of records grouped by entity kind. Missing keys mean "no changes". */
export type ChangeSet = {
  [K in EntityKind]?: EntityMap[K][];
};

export interface PairRequest {
  /** One-time code minted by the server operator. */
  code: string;
  /** Human-readable device label, shown in the server's device list. */
  deviceName: string;
  /** Stable client-generated device id (uuid). Re-pairing with the same id rotates the token. */
  deviceId: ID;
}

export interface PairResponse {
  /** Bearer token for all subsequent requests. Store it on-device only. */
  token: string;
  deviceId: ID;
  deviceName: string;
  /** The account this device now belongs to. */
  accountId: ID;
  serverTime: number;
  protocolVersion: number;
}

export interface WhoAmIResponse {
  deviceId: ID;
  deviceName: string;
  accountId: ID;
  serverTime: number;
  protocolVersion: number;
  /** Whether the server is configured to proxy AI extraction requests. */
  aiProxyEnabled: boolean;
  /** Model ids the proxy will accept, empty when the proxy is disabled. */
  aiProxyModels: string[];
}

export interface PushRequest {
  deviceId: ID;
  protocolVersion: number;
  changes: ChangeSet;
}

/** Outcome for a single pushed record. */
export interface PushResult {
  kind: EntityKind;
  id: ID;
  /** Revision the record now has on the server. */
  rev: number;
  /**
   * `applied`   — the server took this version.
   * `stale`     — the server already had a newer `updatedAt`; pull to get it.
   * `rejected`  — the record failed validation. See `reason`.
   */
  outcome: 'applied' | 'stale' | 'rejected';
  reason?: string;
}

export interface PushResponse {
  results: PushResult[];
  /** Highest revision assigned during this push. */
  cursor: number;
  serverTime: number;
}

export interface PullQuery {
  /** Return records with `rev > since`. Start at 0 for a full download. */
  since: number;
  /** Maximum records across all kinds in one page. Server clamps this. */
  limit?: number;
}

export interface PullResponse {
  changes: ChangeSet;
  /** Feed this back as `since` on the next call. */
  cursor: number;
  /** True when more pages are waiting at `cursor`. */
  hasMore: boolean;
  serverTime: number;
  /** See {@link SyncStatusResponse.epoch}. */
  epoch?: string;
}

/**
 * The cheap "is there anything for me?" call.
 *
 * A sync pass costs a round trip whether or not anything changed, and the
 * client runs one every five minutes plus whenever it reconnects. This answers
 * the same question with no payload at all, so an idle device that has been
 * left open overnight transfers a few hundred bytes rather than re-fetching a
 * page of records to discover it already had them.
 */
export interface SyncStatusResponse {
  /** The account's current revision. */
  cursor: number;
  /**
   * Identifies this server's revision history.
   *
   * Revision numbers are only meaningful within one history. If the server's
   * database is restored from a backup, rebuilt, or replaced, its counter
   * restarts while clients still hold cursors from the old one — and every one
   * of those clients would then silently skip everything below its stale
   * cursor. A changed epoch tells them to reset to zero and reconcile from
   * scratch instead.
   */
  epoch: string;
  /** True when the caller's `since` is behind {@link cursor}. */
  hasChanges: boolean;
  /** Records waiting per kind, when `since` was supplied. */
  pending?: Partial<Record<EntityKind, number>>;
  /** Total records waiting, when `since` was supplied. */
  pendingTotal?: number;
  /**
   * Set when the caller's cursor is ahead of the server's, which means their
   * histories have diverged and the client must resynchronise from zero.
   */
  diverged?: boolean;
  counts?: Record<string, number>;
  serverTime: number;
}

/** Reports which content-addressed blobs the server already holds. */
export interface BlobStatusRequest {
  /** SHA-256 hex digests to check. */
  ids: string[];
}

export interface BlobStatusResponse {
  /** Digests the server already has; do not re-upload these. */
  present: string[];
  /** Digests the server wants. */
  missing: string[];
}

export interface ApiError {
  error: string;
  message: string;
  /** Present on 409s caused by a protocol version mismatch. */
  protocolVersion?: number;
}

/**
 * Decides which of two versions of the same record wins.
 *
 * Last-write-wins on `updatedAt`. When the timestamps tie (common when two
 * devices edit within the same millisecond, or when clocks are coarse), the
 * lexicographically larger serialisation wins. Both sides run this same
 * function, so they always agree without another round-trip.
 */
export function resolveConflict<T extends AnyEntity>(local: T, remote: T): T {
  if (local.updatedAt !== remote.updatedAt) {
    return local.updatedAt > remote.updatedAt ? local : remote;
  }
  // A delete beats a concurrent edit: it is the safer of the two to converge on,
  // and it is recoverable because tombstones keep the row.
  const localDeleted = local.deletedAt !== 0;
  const remoteDeleted = remote.deletedAt !== 0;
  if (localDeleted !== remoteDeleted) return localDeleted ? local : remote;

  return stableStringify(local) >= stableStringify(remote) ? local : remote;
}

/** JSON with object keys sorted, so equal records always serialise identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const source = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = source[key];
      return sorted;
    }
    return val;
  });
}

/** Total number of records in a change set. */
export function changeSetSize(changes: ChangeSet): number {
  let total = 0;
  for (const list of Object.values(changes)) total += list?.length ?? 0;
  return total;
}

/** True when the change set carries nothing at all. */
export function isEmptyChangeSet(changes: ChangeSet): boolean {
  return changeSetSize(changes) === 0;
}
