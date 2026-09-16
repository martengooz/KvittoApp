import type { ID } from '@kvitto/shared/domain';

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  kind: string;
  sourceKind: 'receipt' | 'blob';
  sourceId: ID;
  sourceUpdatedAt: number;
  state: JobState;
  priority: number;
  attempts: number;
  nextAttemptAt: number;
  maxAttempts: number;
  progress: number;
  cancelRequested: boolean;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobClaim {
  id: string;
  leaseMs: number;
  claimedAt: number;
}

export interface JobStorePort {
  enqueue(job: Omit<JobRecord, 'state' | 'attempts' | 'progress' | 'cancelRequested' | 'lastError' | 'createdAt' | 'updatedAt'>): Promise<JobRecord>;
  get(id: string): Promise<JobRecord | null>;
  claimNext(now: number, leaseMs: number): Promise<JobClaim | null>;
  markDone(id: string, now: number): Promise<void>;
  markProgress(id: string, progress: number, now: number): Promise<void>;
  markRetry(id: string, now: number, delayMs: number, error: string): Promise<void>;
  markCancelled(id: string, now: number): Promise<void>;
  requestCancel(id: string, now: number): Promise<void>;
  list(state?: JobState): Promise<JobRecord[]>;
}
