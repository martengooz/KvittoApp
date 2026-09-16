import type { Receipt } from '@kvitto/shared/domain';

import type {
  FileBackedDescriptor,
  FrameAnalysisResult,
  KvittoNativeFacade,
  NormalizedQuad,
  ProcessReceiptImageResult,
} from '../../../modules/kvitto-native/src';

export type ScanPermissionState = 'unknown' | 'granted' | 'denied' | 'unavailable';

export type ScanAutoCaptureState = 'off' | 'searching' | 'holding' | 'stalled' | 'capturing';

export type ScanStage = 'capture' | 'processing' | 'review' | 'importing';

export type ScanInterruptionState = 'none' | 'backgrounded' | 'camera-interrupted';

export interface ScanReviewModel {
  source: FileBackedDescriptor;
  processed: FileBackedDescriptor | null;
  thumbnail: FileBackedDescriptor | null;
  fallbackUsed: boolean;
  detectionSource: ProcessReceiptImageResult['detectionSource'];
  autoDetectedQuad: NormalizedQuad | null;
  cropQuad: NormalizedQuad | null;
  rotation: 0 | 90 | 180 | 270;
}

export interface ScanBatchFailure {
  stageId: string;
  uri: string;
  message: string;
}

export interface ScanBatchOutcome {
  total: number;
  imported: number;
  failed: number;
  fallbackCount: number;
  failures: ScanBatchFailure[];
}

export interface ScanState {
  permission: ScanPermissionState;
  stage: ScanStage;
  auto: ScanAutoCaptureState;
  manualShutterEnabled: boolean;
  interruption: ScanInterruptionState;
  frameCadenceMs: number;
  lastFrameAnalyzedAtMs: number;
  activeStageId: string | null;
  review: ScanReviewModel | null;
  processing: boolean;
  importProgress: { total: number; index: number; imported: number } | null;
  stalledSinceMs: number | null;
  recoverableStageIds: string[];
}

export interface ScanStagedDescriptor {
  id: string;
  sourceType: 'camera' | 'upload';
  source: FileBackedDescriptor;
  createdAtMs: number;
}

export interface ScanCameraPort {
  requestPermission(): Promise<ScanPermissionState>;
  startPreview(): Promise<void>;
  stopPreview(): Promise<void>;
  captureStill(): Promise<FileBackedDescriptor>;
  analyzeFrameCompact(frameTimestampMs: number, cancellationId?: string): Promise<FrameAnalysisResult>;
}

export interface ScanLibraryPort {
  pickImages(): Promise<FileBackedDescriptor[]>;
}

export interface ScanHapticsPort {
  impact(kind: 'success' | 'warning' | 'error'): void;
}

export interface ScanStagingPort {
  put(descriptor: ScanStagedDescriptor): Promise<void>;
  remove(stageId: string): Promise<void>;
  list(): Promise<ScanStagedDescriptor[]>;
}

export interface ScanJobQueuePort {
  enqueue(job: { kind: 'image-processing' | 'ocr'; receiptId: string; sourceVersion: number; sourceImageId: string | null }): Promise<void>;
}

export interface ScanReceiptRepositoryPort {
  createReceipt(overrides: Partial<Receipt>): Promise<Receipt>;
  getReceipt(id: string): Promise<Receipt | null>;
  updateReceipt(id: string, patch: Partial<Receipt>): Promise<Receipt | null>;
}

export interface ScanControllerClock {
  now(): number;
}

export interface ScanPathBuilder {
  tempUri(kind: 'normalized' | 'processed' | 'thumb', stageId: string): string;
}

export interface ScanControllerOptions {
  native: KvittoNativeFacade;
  camera: ScanCameraPort;
  library: ScanLibraryPort;
  haptics: ScanHapticsPort;
  staging: ScanStagingPort;
  jobs: ScanJobQueuePort;
  repo: ScanReceiptRepositoryPort;
  paths: ScanPathBuilder;
  clock?: ScanControllerClock;
  frameCadenceMs?: number;
  armDelayMs?: number;
  stallAfterMs?: number;
  stalledCadenceMultiplier?: number;
}

export interface ScanOcrOutcome {
  outcome: 'applied' | 'cancelled' | 'stale' | 'empty';
  filled: Array<'purchasedAt' | 'orgNumber'>;
}
