import type { JobClaim, JobRecord, JobState, JobStorePort } from '@kvitto/client-core/ports';

interface JobStoreRepositoryPort {
  runInTransaction<T>(work: () => Promise<T>): Promise<T>;
  getKeyValue(key: string): Promise<string | null>;
  setKeyValue(key: string, value: string): Promise<void>;
}

interface StoredJobRecord extends JobRecord {
  leaseUntil: number;
}

interface QueueSnapshotV1 {
  version: 1;
  jobs: StoredJobRecord[];
}

export interface JobStoreClock {
  now(): number;
}

export interface RepositoryBackedJobStoreOptions {
  repository: JobStoreRepositoryPort;
  clock?: JobStoreClock;
  key?: string;
}

const DEFAULT_QUEUE_KEY = 'jobs:queue:v1';
const EMPTY_QUEUE: QueueSnapshotV1 = {
  version: 1,
  jobs: [],
};

const JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]);

function toNumber(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

function toStringValue(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') return fallback;
  return value;
}

function normalizeState(value: unknown): JobState {
  if (typeof value === 'string' && JOB_STATES.has(value as JobState)) {
    return value as JobState;
  }
  return 'pending';
}

function normalizeStoredJob(input: unknown): StoredJobRecord | null {
  if (!input || typeof input !== 'object') return null;
  const row = input as Partial<StoredJobRecord>;

  const id = toStringValue(row.id, '').trim();
  const kind = toStringValue(row.kind, '').trim();
  if (!id || !kind) return null;

  const sourceKind = row.sourceKind === 'blob' ? 'blob' : 'receipt';
  const sourceId = toStringValue(row.sourceId, '').trim();
  if (!sourceId) return null;

  const sourceUpdatedAt = Math.max(0, Math.trunc(toNumber(row.sourceUpdatedAt, 0)));
  const priority = Math.trunc(toNumber(row.priority, 0));
  const attempts = Math.max(0, Math.trunc(toNumber(row.attempts, 0)));
  const nextAttemptAt = Math.max(0, Math.trunc(toNumber(row.nextAttemptAt, 0)));
  const maxAttempts = Math.max(1, Math.trunc(toNumber(row.maxAttempts, 1)));
  const progress = Math.min(1, Math.max(0, toNumber(row.progress, 0)));
  const cancelRequested = toBoolean(row.cancelRequested, false);
  const lastError = typeof row.lastError === 'string' ? row.lastError : null;
  const createdAt = Math.max(0, Math.trunc(toNumber(row.createdAt, 0)));
  const updatedAt = Math.max(createdAt, Math.trunc(toNumber(row.updatedAt, createdAt)));
  const leaseUntil = Math.max(0, Math.trunc(toNumber(row.leaseUntil, 0)));

  return {
    id,
    kind,
    sourceKind,
    sourceId,
    sourceUpdatedAt,
    state: normalizeState(row.state),
    priority,
    attempts,
    nextAttemptAt,
    maxAttempts,
    progress,
    cancelRequested,
    lastError,
    createdAt,
    updatedAt,
    leaseUntil,
  };
}

function parseSnapshot(raw: string | null): QueueSnapshotV1 {
  if (!raw) return EMPTY_QUEUE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_QUEUE;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY_QUEUE;
  const container = parsed as { version?: unknown; jobs?: unknown };
  if (container.version !== 1 || !Array.isArray(container.jobs)) return EMPTY_QUEUE;

  const byId = new Map<string, StoredJobRecord>();
  for (const entry of container.jobs) {
    const normalized = normalizeStoredJob(entry);
    if (!normalized) continue;

    const existing = byId.get(normalized.id);
    if (!existing || normalized.updatedAt >= existing.updatedAt) {
      byId.set(normalized.id, normalized);
    }
  }

  return {
    version: 1,
    jobs: [...byId.values()],
  };
}

function serializeSnapshot(snapshot: QueueSnapshotV1): string {
  return JSON.stringify({
    version: 1,
    jobs: snapshot.jobs,
  });
}

function stripLease(job: StoredJobRecord): JobRecord {
  const { leaseUntil: _leaseUntil, ...rest } = job;
  return {
    ...rest,
  };
}

function toMap(snapshot: QueueSnapshotV1): Map<string, StoredJobRecord> {
  return new Map(snapshot.jobs.map((row) => [row.id, row]));
}

function toSnapshot(map: Map<string, StoredJobRecord>): QueueSnapshotV1 {
  return {
    version: 1,
    jobs: [...map.values()],
  };
}

export class RepositoryBackedJobStore implements JobStorePort {
  readonly #repository: JobStoreRepositoryPort;
  readonly #clock: JobStoreClock;
  readonly #key: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: RepositoryBackedJobStoreOptions) {
    this.#repository = options.repository;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#key = options.key ?? DEFAULT_QUEUE_KEY;
  }

  async #loadSnapshot(): Promise<QueueSnapshotV1> {
    return parseSnapshot(await this.#repository.getKeyValue(this.#key));
  }

  async #runMutation<T>(work: (jobs: Map<string, StoredJobRecord>) => Promise<T>): Promise<T> {
    const mutation = this.#mutationTail.then(() => this.#repository.runInTransaction(async () => {
      const snapshot = await this.#loadSnapshot();
      const jobs = toMap(snapshot);
      const result = await work(jobs);
      await this.#repository.setKeyValue(this.#key, serializeSnapshot(toSnapshot(jobs)));
      return result;
    }));
    this.#mutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
  }

  async enqueue(job: Omit<JobRecord, 'state' | 'attempts' | 'progress' | 'cancelRequested' | 'lastError' | 'createdAt' | 'updatedAt'>): Promise<JobRecord> {
    return this.#runMutation(async (jobs) => {
      const existing = jobs.get(job.id);
      if (existing) return stripLease(existing);

      const now = Math.max(0, Math.trunc(this.#clock.now()));
      const row: StoredJobRecord = {
        id: job.id,
        kind: job.kind,
        sourceKind: job.sourceKind,
        sourceId: job.sourceId,
        sourceUpdatedAt: Math.max(0, Math.trunc(job.sourceUpdatedAt)),
        state: 'pending',
        priority: Math.trunc(job.priority),
        attempts: 0,
        nextAttemptAt: Math.max(0, Math.trunc(job.nextAttemptAt)),
        maxAttempts: Math.max(1, Math.trunc(job.maxAttempts)),
        progress: 0,
        cancelRequested: false,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        leaseUntil: 0,
      };
      jobs.set(row.id, row);
      return stripLease(row);
    });
  }

  async get(id: string): Promise<JobRecord | null> {
    const snapshot = await this.#loadSnapshot();
    const row = snapshot.jobs.find((job) => job.id === id);
    return row ? stripLease(row) : null;
  }

  async claimNext(now: number, leaseMs: number): Promise<JobClaim | null> {
    const safeNow = Math.max(0, Math.trunc(now));
    const safeLeaseMs = Math.max(1, Math.trunc(leaseMs));
    return this.#runMutation(async (jobs) => {
      const claimable = [...jobs.values()]
        .filter((job) => (
          job.state === 'pending'
          || (job.state === 'running' && job.leaseUntil <= safeNow)
          || job.state === 'failed'
        )
          && !job.cancelRequested
          && job.nextAttemptAt <= safeNow)
        .sort((a, b) => {
          if (a.priority !== b.priority) return b.priority - a.priority;
          if (a.nextAttemptAt !== b.nextAttemptAt) return a.nextAttemptAt - b.nextAttemptAt;
          return a.id.localeCompare(b.id);
        })[0];

      if (!claimable) return null;

      const next: StoredJobRecord = {
        ...claimable,
        state: 'running',
        attempts: claimable.attempts + 1,
        leaseUntil: safeNow + safeLeaseMs,
        updatedAt: safeNow,
      };
      jobs.set(next.id, next);
      return { id: next.id, leaseMs: safeLeaseMs, claimedAt: safeNow };
    });
  }

  async markDone(id: string, now: number): Promise<void> {
    const safeNow = Math.max(0, Math.trunc(now));
    await this.#runMutation(async (jobs) => {
      const row = jobs.get(id);
      if (!row) return;
      jobs.set(id, {
        ...row,
        state: 'done',
        progress: 1,
        updatedAt: safeNow,
        leaseUntil: 0,
      });
    });
  }

  async markProgress(id: string, progress: number, now: number): Promise<void> {
    const safeNow = Math.max(0, Math.trunc(now));
    await this.#runMutation(async (jobs) => {
      const row = jobs.get(id);
      if (!row) return;
      jobs.set(id, {
        ...row,
        progress: Math.min(1, Math.max(0, progress)),
        updatedAt: safeNow,
      });
    });
  }

  async markRetry(id: string, now: number, delayMs: number, error: string): Promise<void> {
    const safeNow = Math.max(0, Math.trunc(now));
    const safeDelay = Math.max(0, Math.trunc(delayMs));
    await this.#runMutation(async (jobs) => {
      const row = jobs.get(id);
      if (!row) return;
      jobs.set(id, {
        ...row,
        state: 'failed',
        nextAttemptAt: safeNow + safeDelay,
        lastError: error,
        updatedAt: safeNow,
        leaseUntil: 0,
      });
    });
  }

  async markCancelled(id: string, now: number): Promise<void> {
    const safeNow = Math.max(0, Math.trunc(now));
    await this.#runMutation(async (jobs) => {
      const row = jobs.get(id);
      if (!row) return;
      jobs.set(id, {
        ...row,
        state: 'cancelled',
        updatedAt: safeNow,
        leaseUntil: 0,
      });
    });
  }

  async requestCancel(id: string, now: number): Promise<void> {
    const safeNow = Math.max(0, Math.trunc(now));
    await this.#runMutation(async (jobs) => {
      const row = jobs.get(id);
      if (!row) return;
      jobs.set(id, {
        ...row,
        cancelRequested: true,
        updatedAt: safeNow,
      });
    });
  }

  async list(state?: JobState): Promise<JobRecord[]> {
    const snapshot = await this.#loadSnapshot();
    return snapshot.jobs
      .filter((job) => (state ? job.state === state : true))
      .map((job) => stripLease(job));
  }
}

export function createRepositoryBackedJobStore(options: RepositoryBackedJobStoreOptions): JobStorePort {
  return new RepositoryBackedJobStore(options);
}