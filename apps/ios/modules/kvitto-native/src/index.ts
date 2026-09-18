import { requireNativeModule } from 'expo-modules-core';

import type {
  ArchiveEntryIndex,
  ArchiveWriteEntry,
  BackgroundScheduleOutcome,
  BlobMetadataRecord,
  EventSubscription,
  NativeBackgroundLaunch,
  FileBackedDescriptor,
  FrameAnalysisCompactResult,
  FrameAnalysisResult,
  KvittoNativeFacade,
  NormalizedQuad,
  ProcessReceiptImageRequest,
  ProcessReceiptImageResult,
  RecognizeTextRequest,
  RecognizeTextResult,
  StoreBlobRequest,
  StoreDownloadedBlobRequest,
} from './contracts';

interface KvittoNativeBinding {
  hashFileSha256(fileUri: string): Promise<string>;
  computeBlobShardPath(sha256Id: string): Promise<string>;
  storeContentAddressedFile(input: StoreBlobRequest): Promise<BlobMetadataRecord>;
  getBlobMetadata(sha256Id: string): Promise<BlobMetadataRecord | null>;
  putBlobMetadata(record: BlobMetadataRecord): Promise<BlobMetadataRecord>;
  markBlobUploaded(sha256Id: string): Promise<void>;
  listBlobMetadataPendingUpload(limit: number): Promise<BlobMetadataRecord[]>;
  listAllBlobMetadata(limit: number): Promise<BlobMetadataRecord[]>;
  deleteBlobMetadata(sha256Id: string): Promise<boolean>;
  resetBlobUploadState(): Promise<number>;
  readArchiveIndex(fileUri: string): Promise<ArchiveEntryIndex[]>;
  extractArchiveEntry(fileUri: string, path: string, destinationUri: string): Promise<number>;
  readFileChunkBase64(fileUri: string, offset: number, length: number): Promise<string>;
  writeFileChunkBase64(fileUri: string, base64: string, append: boolean): Promise<number>;
  writeArchive(destinationUri: string, entries: ArchiveWriteEntry[]): Promise<number>;
  /** True only on a simulator; gates debug-only sample-data actions. */
  isSimulator(): boolean;
  logDiagnostic(category: string, message: string): void;
  makeScratchFileUri(prefix: string, fileExtension: string): string;
  deleteScratchFile(fileUri: string): Promise<boolean>;
  shareFile(fileUri: string): Promise<boolean>;
  filterExistingFiles(fileUris: string[]): Promise<string[]>;
  storeDownloadedBlob(input: StoreDownloadedBlobRequest): Promise<BlobMetadataRecord>;
  normalizeOrientation(sourceUri: string, outputUri: string, jpegQuality: number, cancellationId?: string): Promise<FileBackedDescriptor>;
  detectRectangle(sourceUri: string, cancellationId?: string): Promise<NormalizedQuad | null>;
  processReceiptImage(input: {
    source: FileBackedDescriptor;
    outputUri: string;
    thumbnailUri: string;
    maxLongEdge: number;
    jpegQuality: number;
    enhancement: ProcessReceiptImageRequest['enhancement'];
    cancellationId?: string;
    forcedQuad?: NormalizedQuad | null;
  }): Promise<ProcessReceiptImageResult>;
  recognizeText(input: {
    source: FileBackedDescriptor;
    preferredLanguages: string[];
    cancellationId?: string;
  }): Promise<RecognizeTextResult>;
  cancelOperation(cancellationId: string): Promise<boolean>;
  analyzeFrameCompact(frameTimestampMs: number, cancellationId?: string): Promise<FrameAnalysisResult>;
  launchRoutes(): string[];
  launchRouteDwellMs(): number;
  launchScanAction(): string;
  launchArchiveAction(): string;
  backgroundTaskIdentifier(): string;
  drainPendingBackgroundLaunches(): NativeBackgroundLaunch[];
  isBackgroundLaunchExpired(handle: string): boolean;
  finishBackgroundLaunch(handle: string, success: boolean): boolean;
  scheduleBackgroundProcessing(
    earliestDelaySeconds: number,
    requiresNetwork: boolean,
    requiresPower: boolean,
  ): Promise<BackgroundScheduleOutcome>;
  cancelBackgroundProcessing(): Promise<void>;
  pendingBackgroundTaskIdentifiers(): Promise<string[]>;
  /** Inherited from Expo's `NativeModule`; the background window arrives here. */
  addListener(event: string, listener: (payload: NativeBackgroundLaunch) => void): EventSubscription;
}

/** Event name the native coordinator publishes a background window under. */
export const BACKGROUND_LAUNCH_EVENT = 'onKvittoBackgroundLaunch';

function compactFrameMetadata(input: FrameAnalysisResult): FrameAnalysisCompactResult {
  return {
    status: input.status,
    pluginLinked: input.pluginLinked,
    evidenceScore: input.evidenceScore,
    coverage: input.coverage,
    source: input.source,
    durationMs: input.timing.durationMs,
  };
}

function defaultBinding(): KvittoNativeBinding {
  return requireNativeModule<KvittoNativeBinding>('KvittoNative');
}

export function createKvittoNativeFacade(binding: KvittoNativeBinding = defaultBinding()): KvittoNativeFacade & { compactFrameMetadata: (input: FrameAnalysisResult) => FrameAnalysisCompactResult } {
  return {
    hashFileSha256(fileUri) {
      return binding.hashFileSha256(fileUri);
    },
    computeShardPath(sha256Id) {
      return binding.computeBlobShardPath(sha256Id);
    },
    storeContentAddressedFile(request) {
      return binding.storeContentAddressedFile(request);
    },
    getBlobMetadata(sha256Id) {
      return binding.getBlobMetadata(sha256Id);
    },
    putBlobMetadata(record) {
      return binding.putBlobMetadata(record);
    },
    markBlobUploaded(sha256Id) {
      return binding.markBlobUploaded(sha256Id);
    },
    listBlobMetadataPendingUpload(limit) {
      return binding.listBlobMetadataPendingUpload(limit);
    },
    listAllBlobMetadata(limit) {
      return binding.listAllBlobMetadata(limit);
    },
    deleteBlobMetadata(sha256Id) {
      return binding.deleteBlobMetadata(sha256Id);
    },
    resetBlobUploadState() {
      return binding.resetBlobUploadState();
    },
    readArchiveIndex(fileUri) {
      return binding.readArchiveIndex(fileUri);
    },
    extractArchiveEntry(fileUri, path, destinationUri) {
      return binding.extractArchiveEntry(fileUri, path, destinationUri);
    },
    readFileChunkBase64(fileUri, offset, length) {
      return binding.readFileChunkBase64(fileUri, offset, length);
    },
    writeFileChunkBase64(fileUri, base64, append) {
      return binding.writeFileChunkBase64(fileUri, base64, append);
    },
    writeArchive(destinationUri, entries) {
      return binding.writeArchive(destinationUri, entries);
    },
    isSimulator() {
      return binding.isSimulator();
    },
    logDiagnostic(category, message) {
      binding.logDiagnostic(category, message);
    },
    makeScratchFileUri(prefix, fileExtension) {
      return binding.makeScratchFileUri(prefix, fileExtension);
    },
    deleteScratchFile(fileUri) {
      return binding.deleteScratchFile(fileUri);
    },
    shareFile(fileUri) {
      return binding.shareFile(fileUri);
    },
    filterExistingFiles(fileUris) {
      return binding.filterExistingFiles(fileUris);
    },
    storeDownloadedBlob(request) {
      return binding.storeDownloadedBlob(request);
    },
    normalizeOrientation(sourceUri, outputUri, jpegQuality, cancellationId) {
      return binding.normalizeOrientation(sourceUri, outputUri, jpegQuality, cancellationId);
    },
    detectRectangle(sourceUri, cancellationId) {
      return binding.detectRectangle(sourceUri, cancellationId);
    },
    processReceiptImage(request) {
      return binding.processReceiptImage({
        source: request.source,
        outputUri: request.outputUri,
        thumbnailUri: request.thumbnailUri,
        maxLongEdge: request.maxLongEdge,
        jpegQuality: request.jpegQuality,
        enhancement: request.enhancement,
        cancellationId: request.cancellationId,
        forcedQuad: request.forcedQuad,
      });
    },
    recognizeText(request: RecognizeTextRequest) {
      return binding.recognizeText({
        source: request.source,
        preferredLanguages: request.preferredLanguages,
        cancellationId: request.cancellationId,
      });
    },
    cancelOperation(cancellationId) {
      return binding.cancelOperation(cancellationId);
    },
    async analyzeFrameCompact(frameTimestampMs, cancellationId) {
      const result = await binding.analyzeFrameCompact(frameTimestampMs, cancellationId);
      const compact = compactFrameMetadata(result);
      if (!compact.pluginLinked) {
        return {
          ...result,
          source: 'stub',
          status: result.status === 'unsupported' ? result.status : 'unsupported',
        };
      }
      return result;
    },
    launchRoutes() {
      return binding.launchRoutes();
    },
    launchRouteDwellMs() {
      return binding.launchRouteDwellMs();
    },
    launchScanAction() {
      return binding.launchScanAction();
    },
    launchArchiveAction() {
      return binding.launchArchiveAction();
    },
    backgroundTaskIdentifier() {
      return binding.backgroundTaskIdentifier();
    },
    drainPendingBackgroundLaunches() {
      return binding.drainPendingBackgroundLaunches();
    },
    isBackgroundLaunchExpired(handle) {
      return binding.isBackgroundLaunchExpired(handle);
    },
    finishBackgroundLaunch(handle, success) {
      return binding.finishBackgroundLaunch(handle, success);
    },
    scheduleBackgroundProcessing(earliestDelaySeconds, requiresNetwork, requiresPower) {
      return binding.scheduleBackgroundProcessing(earliestDelaySeconds, requiresNetwork, requiresPower);
    },
    cancelBackgroundProcessing() {
      return binding.cancelBackgroundProcessing();
    },
    pendingBackgroundTaskIdentifiers() {
      return binding.pendingBackgroundTaskIdentifiers();
    },
    onBackgroundLaunch(listener) {
      return binding.addListener(BACKGROUND_LAUNCH_EVENT, listener);
    },
    compactFrameMetadata,
  };
}

export type { KvittoNativeBinding };
export * from './contracts';
export * from './file-uri';
