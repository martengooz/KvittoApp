import { requireNativeModule } from 'expo-modules-core';

import type {
  BlobMetadataRecord,
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
  deleteBlobMetadata(sha256Id: string): Promise<boolean>;
  resetBlobUploadState(): Promise<number>;
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
}

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
    deleteBlobMetadata(sha256Id) {
      return binding.deleteBlobMetadata(sha256Id);
    },
    resetBlobUploadState() {
      return binding.resetBlobUploadState();
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
    compactFrameMetadata,
  };
}

export type { KvittoNativeBinding };
export * from './contracts';
