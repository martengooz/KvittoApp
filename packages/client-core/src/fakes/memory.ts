import {
  ENTITY_KINDS,
  mergeIncomingReceipt,
  resolveConflict,
  type AnyEntity,
  type EntityKind,
  type EntityMap,
  type ID,
  type Receipt,
} from '@kvitto/shared/domain';

import type {
  CanonicalRecord,
  CanonicalRepositoryPort,
  DirtySnapshot,
  PageOptions,
  PageResult,
  RevisionCursor,
  SyncApplyResult,
} from '../ports/index.js';

import type { JobClaim, JobRecord, JobState, JobStorePort } from '../ports/jobs.js';
import type { BlobDescriptor, BlobStorePort, CredentialState, CredentialsPort } from '../ports/types.js';
import type { SyncTransportPort } from '../ports/sync.js';
import type {
  ChangeSet,
  PairRequest,
  PairResponse,
  PullQuery,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncStatusResponse,
  WhoAmIResponse,
} from '@kvitto/shared/domain';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareEntity(a: CanonicalRecord, b: CanonicalRecord): number {
  if (a.rev !== b.rev) return a.rev - b.rev;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  return (a as { id: string }).id.localeCompare((b as { id: string }).id);
}

export class InMemoryCanonicalRepository implements CanonicalRepositoryPort {
  private readonly data: { [K in EntityKind]: Map<ID, AnyEntity> };

  private syncState: RevisionCursor = { cursor: 0, epoch: 'epoch-1' };

  constructor(initial: Partial<Record<EntityKind, AnyEntity[]>> = {}) {
    this.data = {
      companies: new Map(),
      receipts: new Map(),
      items: new Map(),
      categories: new Map(),
      tags: new Map(),
      receiptTags: new Map(),
      secrets: new Map(),
    };

    for (const kind of ENTITY_KINDS) {
      const rows = initial[kind] ?? [];
      for (const row of rows) {
        this.data[kind].set((row as { id: ID }).id, clone(row));
      }
    }
  }

  async get<K extends EntityKind>(kind: K, id: ID): Promise<CanonicalRecord<K> | null> {
    const row = this.data[kind].get(id);
    return row ? clone(row as CanonicalRecord<K>) : null;
  }

  async upsert<K extends EntityKind>(kind: K, entity: CanonicalRecord<K>): Promise<CanonicalRecord<K>> {
    this.data[kind].set(entity.id, clone(entity as AnyEntity));
    return clone(entity);
  }

  async tombstone<K extends EntityKind>(kind: K, id: ID, now: number): Promise<CanonicalRecord<K> | null> {
    const current = this.data[kind].get(id) as CanonicalRecord<K> | undefined;
    if (!current) return null;
    const next = {
      ...current,
      deletedAt: now,
      updatedAt: now,
      dirty: 1,
    } as CanonicalRecord<K>;
    this.data[kind].set(id, clone(next));
    return clone(next);
  }

  async list<K extends EntityKind>(kind: K, options: PageOptions): Promise<PageResult<CanonicalRecord<K>>> {
    const cursor = options.cursor ?? 0;
    const rows = [...this.data[kind].values()].map((row) => row as CanonicalRecord<K>).sort(compareEntity);
    const items = rows.filter((row) => row.rev > cursor).slice(0, options.limit).map((row) => clone(row as CanonicalRecord<K>));
    const nextCursor = items.reduce((max, row) => Math.max(max, row.rev), cursor);
    const hasMore = rows.some((row) => row.rev > nextCursor);
    return { items, nextCursor, hasMore };
  }

  async listDirty(limit: number): Promise<DirtySnapshot[]> {
    const dirty: DirtySnapshot[] = [];
    for (const kind of ENTITY_KINDS) {
      for (const row of this.data[kind].values()) {
        const typed = row as CanonicalRecord<typeof kind>;
        if (typed.dirty !== 1) continue;
        dirty.push({
          kind,
          id: typed.id,
          updatedAt: typed.updatedAt,
          entity: clone(typed),
        });
      }
    }

    dirty.sort((a, b) => {
      if (a.entity.updatedAt !== b.entity.updatedAt) return a.entity.updatedAt - b.entity.updatedAt;
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
      return a.id.localeCompare(b.id);
    });

    return dirty.slice(0, limit).map((entry) => ({ ...entry, entity: clone(entry.entity) }));
  }

  async markCleanIfUpdatedAtMatches(snapshot: DirtySnapshot, rev: number): Promise<boolean> {
    const current = this.data[snapshot.kind].get(snapshot.id) as CanonicalRecord<typeof snapshot.kind> | undefined;
    if (!current) return false;
    if (current.updatedAt !== snapshot.updatedAt) return false;
    this.data[snapshot.kind].set(snapshot.id, {
      ...current,
      dirty: 0,
      rev,
    });
    return true;
  }

  async dirtyAllAndResetRev(): Promise<void> {
    for (const kind of ENTITY_KINDS) {
      for (const [id, row] of this.data[kind]) {
        const typed = row as CanonicalRecord<typeof kind>;
        this.data[kind].set(id, {
          ...typed,
          dirty: 1,
          rev: 0,
        });
      }
    }
  }

  async getSyncState(): Promise<RevisionCursor> {
    return { ...this.syncState };
  }

  async setSyncState(state: RevisionCursor): Promise<void> {
    this.syncState = { ...state };
  }

  async applyIncoming(changes: Partial<Record<EntityKind, AnyEntity[]>>): Promise<SyncApplyResult> {
    let applied = 0;
    let merged = 0;
    let skippedStale = 0;

    for (const kind of ENTITY_KINDS) {
      const rows = changes[kind] ?? [];
      for (const incoming of rows) {
        const id = (incoming as { id: ID }).id;
        const current = this.data[kind].get(id) as CanonicalRecord<typeof kind> | undefined;
        if (!current) {
          this.data[kind].set(id, clone(incoming));
          applied += 1;
          continue;
        }

        if (kind === 'receipts') {
          const enriched = mergeIncomingReceipt(current as Receipt, incoming as Receipt);
          if (enriched) {
            this.data[kind].set(id, clone(enriched));
            merged += 1;
            continue;
          }
        }

        const winner = resolveConflict(current as EntityMap[typeof kind], incoming as EntityMap[typeof kind]);
        if ((winner as CanonicalRecord<typeof kind>).id === current.id && winner.updatedAt === current.updatedAt && winner.rev === current.rev) {
          skippedStale += 1;
        } else {
          applied += 1;
        }
        this.data[kind].set(id, clone(winner));
      }
    }

    return { applied, merged, skippedStale };
  }

  async countByKind(): Promise<Record<EntityKind, number>> {
    return {
      companies: this.data.companies.size,
      receipts: this.data.receipts.size,
      items: this.data.items.size,
      categories: this.data.categories.size,
      tags: this.data.tags.size,
      receiptTags: this.data.receiptTags.size,
      secrets: this.data.secrets.size,
    };
  }

  async countDirty(): Promise<number> {
    let count = 0;
    for (const kind of ENTITY_KINDS) {
      for (const row of this.data[kind].values()) {
        const typed = row as CanonicalRecord<typeof kind>;
        if (typed.dirty === 1) count += 1;
      }
    }
    return count;
  }

  async getReceipt(id: ID): Promise<Receipt | null> {
    const row = this.data.receipts.get(id);
    return row ? clone(row as Receipt) : null;
  }
}

export class InMemoryBlobStore implements BlobStorePort {
  private readonly blobs = new Map<string, BlobDescriptor & { uploaded: boolean }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(descriptor: Omit<BlobDescriptor, 'createdAt'>): Promise<BlobDescriptor> {
    const createdAt = this.now();
    const row = { ...descriptor, createdAt, uploaded: false };
    this.blobs.set(descriptor.id, row);
    return clone({ ...row, uploaded: undefined } as unknown as BlobDescriptor);
  }

  async get(id: string): Promise<BlobDescriptor | null> {
    const row = this.blobs.get(id);
    if (!row) return null;
    const { uploaded: _uploaded, ...out } = row;
    return clone(out);
  }

  async markUploaded(id: string): Promise<void> {
    const row = this.blobs.get(id);
    if (!row) return;
    this.blobs.set(id, { ...row, uploaded: true });
  }

  async listPendingUpload(limit: number): Promise<BlobDescriptor[]> {
    return [...this.blobs.values()]
      .filter((row) => !row.uploaded)
      .slice(0, limit)
      .map((row) => {
        const { uploaded: _uploaded, ...out } = row;
        return clone(out);
      });
  }
}

export class InMemoryJobStore implements JobStorePort {
  private readonly jobs = new Map<string, JobRecord & { leaseUntil: number }>();

  async enqueue(job: Omit<JobRecord, 'state' | 'attempts' | 'progress' | 'cancelRequested' | 'lastError' | 'createdAt' | 'updatedAt'>): Promise<JobRecord> {
    const now = Date.now();
    const row: JobRecord & { leaseUntil: number } = {
      ...job,
      state: 'pending',
      attempts: 0,
      progress: 0,
      cancelRequested: false,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
    };
    this.jobs.set(job.id, row);
    return clone(stripLease(row));
  }

  async get(id: string): Promise<JobRecord | null> {
    const row = this.jobs.get(id);
    return row ? clone(stripLease(row)) : null;
  }

  async claimNext(now: number, leaseMs: number): Promise<JobClaim | null> {
    const claimable = [...this.jobs.values()]
      .filter((job) =>
        (job.state === 'pending' || (job.state === 'running' && job.leaseUntil <= now) || job.state === 'failed')
        && !job.cancelRequested
        && job.nextAttemptAt <= now,
      )
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.nextAttemptAt !== b.nextAttemptAt) return a.nextAttemptAt - b.nextAttemptAt;
        return a.id.localeCompare(b.id);
      })[0];

    if (!claimable) return null;

    const next = {
      ...claimable,
      state: 'running' as JobState,
      attempts: claimable.attempts + 1,
      leaseUntil: now + leaseMs,
      updatedAt: now,
    };
    this.jobs.set(next.id, next);
    return { id: next.id, leaseMs, claimedAt: now };
  }

  async markDone(id: string, now: number): Promise<void> {
    const row = this.jobs.get(id);
    if (!row) return;
    this.jobs.set(id, {
      ...row,
      state: 'done',
      progress: 1,
      updatedAt: now,
      leaseUntil: 0,
    });
  }

  async markProgress(id: string, progress: number, now: number): Promise<void> {
    const row = this.jobs.get(id);
    if (!row) return;
    this.jobs.set(id, {
      ...row,
      progress,
      updatedAt: now,
    });
  }

  async markRetry(id: string, now: number, delayMs: number, error: string): Promise<void> {
    const row = this.jobs.get(id);
    if (!row) return;
    this.jobs.set(id, {
      ...row,
      state: 'failed',
      nextAttemptAt: now + delayMs,
      lastError: error,
      updatedAt: now,
      leaseUntil: 0,
    });
  }

  async markCancelled(id: string, now: number): Promise<void> {
    const row = this.jobs.get(id);
    if (!row) return;
    this.jobs.set(id, {
      ...row,
      state: 'cancelled',
      updatedAt: now,
      leaseUntil: 0,
    });
  }

  async requestCancel(id: string, now: number): Promise<void> {
    const row = this.jobs.get(id);
    if (!row) return;
    this.jobs.set(id, {
      ...row,
      cancelRequested: true,
      updatedAt: now,
    });
  }

  async list(state?: JobState): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => (state ? job.state === state : true))
      .map((job) => clone(stripLease(job)));
  }
}

function stripLease(row: JobRecord & { leaseUntil: number }): JobRecord {
  const { leaseUntil: _leaseUntil, ...rest } = row;
  return rest;
}

export class InMemoryCredentials implements CredentialsPort {
  private state: CredentialState = {
    deviceId: null,
    token: null,
    accountId: null,
  };

  async get(): Promise<CredentialState> {
    return { ...this.state };
  }

  async set(next: CredentialState): Promise<void> {
    this.state = { ...next };
  }

  async clear(): Promise<void> {
    this.state = { deviceId: null, token: null, accountId: null };
  }
}

export class InMemorySyncTransport implements SyncTransportPort {
  private cursor = 0;

  private epoch = 'epoch-1';

  private readonly stagedPullPages: PullResponse[] = [];

  private readonly pushes: PushRequest[] = [];

  public uploadedBlobIds: string[] = [];

  public downloadedBlobIds: string[] = [];

  constructor(options: { epoch?: string; pullPages?: PullResponse[] } = {}) {
    if (options.epoch) this.epoch = options.epoch;
    if (options.pullPages) this.stagedPullPages.push(...options.pullPages.map((page) => clone(page)));
  }

  getPushes(): PushRequest[] {
    return this.pushes.map((row) => clone(row));
  }

  setPullPages(pages: PullResponse[]): void {
    this.stagedPullPages.length = 0;
    this.stagedPullPages.push(...pages.map((page) => clone(page)));
  }

  setEpoch(epoch: string): void {
    this.epoch = epoch;
  }

  async pair(request: PairRequest): Promise<PairResponse> {
    return {
      token: `token-${request.deviceId}`,
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      accountId: 'acc-1',
      serverTime: Date.now(),
      protocolVersion: 2,
    };
  }

  async whoAmI(): Promise<WhoAmIResponse> {
    return {
      deviceId: 'dev-1',
      deviceName: 'Fake device',
      accountId: 'acc-1',
      serverTime: Date.now(),
      protocolVersion: 2,
      aiProxyEnabled: false,
      aiProxyModels: [],
    };
  }

  async status(since: number): Promise<SyncStatusResponse> {
    return {
      cursor: this.cursor,
      epoch: this.epoch,
      hasChanges: this.cursor > since || this.stagedPullPages.length > 0,
      diverged: since > this.cursor,
      serverTime: Date.now(),
    };
  }

  async push(request: PushRequest): Promise<PushResponse> {
    this.pushes.push(clone(request));
    const results: PushResponse['results'] = [];
    for (const kind of ENTITY_KINDS) {
      const rows = request.changes[kind] ?? [];
      for (const row of rows) {
        this.cursor += 1;
        results.push({
          kind,
          id: row.id,
          rev: this.cursor,
          outcome: 'applied',
        });
      }
    }

    return {
      results,
      cursor: this.cursor,
      serverTime: Date.now(),
    };
  }

  async pull(_query: PullQuery): Promise<PullResponse> {
    const page = this.stagedPullPages.shift();
    if (!page) {
      return {
        changes: {},
        cursor: this.cursor,
        hasMore: false,
        serverTime: Date.now(),
        epoch: this.epoch,
      };
    }

    this.cursor = Math.max(this.cursor, page.cursor);
    return clone(page);
  }

  async uploadBlobs(ids: string[]): Promise<void> {
    this.uploadedBlobIds.push(...ids);
  }

  async downloadBlobs(ids: string[]): Promise<void> {
    this.downloadedBlobIds.push(...ids);
  }
}

export function makeChangeSetFromDirty(dirty: DirtySnapshot[]): ChangeSet {
  const out: Partial<Record<EntityKind, AnyEntity[]>> = {};
  for (const snapshot of dirty) {
    const key = snapshot.kind;
    const list = out[key] ?? [];
    list.push(clone(snapshot.entity as AnyEntity));
    out[key] = list;
  }
  return out as ChangeSet;
}
