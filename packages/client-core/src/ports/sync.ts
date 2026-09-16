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

export interface SyncTransportPort {
  pair(request: PairRequest): Promise<PairResponse>;
  whoAmI(): Promise<WhoAmIResponse>;
  status(since: number): Promise<SyncStatusResponse>;
  push(request: PushRequest): Promise<PushResponse>;
  pull(query: PullQuery): Promise<PullResponse>;
  uploadBlobs(ids: string[]): Promise<void>;
  downloadBlobs(ids: string[]): Promise<void>;
}

export interface PushPage {
  changes: ChangeSet;
  snapshots: {
    kind: keyof ChangeSet;
    id: string;
    updatedAt: number;
  }[];
}
