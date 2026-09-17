export type ImageRole = 'original' | 'processed' | 'thumb';
export type EnhancementMode = 'none' | 'color' | 'grayscale' | 'binarize';

export interface FileBackedDescriptor {
  uri: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  sha256Id: string | null;
  role: ImageRole;
}

export interface BlobMetadataRecord extends FileBackedDescriptor {
  createdAt: number;
  uploadedAt: number | null;
  pendingUpload: boolean;
  shardPath: string;
}

export interface NormalizedQuad {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
}

export interface ProcessingTiming {
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
}

export interface ProcessReceiptImageRequest {
  source: FileBackedDescriptor;
  outputUri: string;
  thumbnailUri: string;
  maxLongEdge: number;
  jpegQuality: number;
  enhancement: EnhancementMode;
  cancellationId?: string;
  forcedQuad?: NormalizedQuad | null;
}

export interface ProcessReceiptImageResult {
  output: FileBackedDescriptor;
  thumbnail: FileBackedDescriptor;
  rectangle: NormalizedQuad | null;
  detectionSource: 'vision-rectangle' | 'fallback-full-frame' | 'forced-quad';
  fallbackUsed: boolean;
  timing: ProcessingTiming;
}

export interface OcrTextObservation {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface RecognizeTextRequest {
  source: FileBackedDescriptor;
  preferredLanguages: string[];
  cancellationId?: string;
}

export interface RecognizeTextResult {
  text: string;
  observations: OcrTextObservation[];
  usedLanguages: string[];
  supportedLanguages: string[];
  cancelled: boolean;
  timing: ProcessingTiming;
}

export interface FrameAnalysisResult {
  status: 'ready' | 'no-document' | 'unsupported' | 'cancelled';
  pluginLinked: boolean;
  evidenceScore: number;
  coverage: number;
  normalizedQuad: NormalizedQuad | null;
  source: 'vision-frame-plugin' | 'stub';
  timing: ProcessingTiming;
}

export interface FrameAnalysisCompactResult {
  status: FrameAnalysisResult['status'];
  pluginLinked: boolean;
  evidenceScore: number;
  coverage: number;
  source: FrameAnalysisResult['source'];
  durationMs: number;
}

/** One entry in a `.kvitto` archive, read from its central directory. */
export interface ArchiveEntryIndex {
  path: string;
  uncompressedSize: number;
  compressedSize: number;
  /** ZIP method: 0 stored, 8 deflate. Nothing else can be extracted. */
  method: number;
}

export interface StoreBlobRequest {
  sourceUri: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  role: ImageRole;
  knownSha256Id?: string;
}

export interface StoreDownloadedBlobRequest {
  base64: string;
  mimeType: string;
  sha256Id: string;
  role: ImageRole;
}

export interface KvittoNativeFacade {
  hashFileSha256(fileUri: string): Promise<string>;
  computeShardPath(sha256Id: string): Promise<string>;
  storeContentAddressedFile(request: StoreBlobRequest): Promise<BlobMetadataRecord>;
  getBlobMetadata(sha256Id: string): Promise<BlobMetadataRecord | null>;
  putBlobMetadata(record: BlobMetadataRecord): Promise<BlobMetadataRecord>;
  markBlobUploaded(sha256Id: string): Promise<void>;
  listBlobMetadataPendingUpload(limit: number): Promise<BlobMetadataRecord[]>;
  deleteBlobMetadata(sha256Id: string): Promise<boolean>;
  resetBlobUploadState(): Promise<number>;
  /** Writes a milestone to the unified log, which survives a Release build. */
  /** True only on a simulator; gates debug-only sample-data actions. */
  /**
   * Lists an archive's entries. Paths are validated against traversal and
   * absolute paths before they are returned, so a hostile archive is rejected
   * before any caller sees a path it might join onto a directory.
   */
  readArchiveIndex(fileUri: string): Promise<ArchiveEntryIndex[]>;
  /**
   * Extracts one entry, verifying its CRC-32 and declared size. On mismatch the
   * partial output is deleted rather than left behind. Returns bytes written.
   */
  extractArchiveEntry(fileUri: string, path: string, destinationUri: string): Promise<number>;
  isSimulator(): boolean;
  logDiagnostic(category: string, message: string): void;
  /** A writable scratch path inside the app sandbox; `/tmp` is not writable on iOS. */
  makeScratchFileUri(prefix: string, fileExtension: string): string;
  deleteScratchFile(fileUri: string): Promise<boolean>;
  storeDownloadedBlob(request: StoreDownloadedBlobRequest): Promise<BlobMetadataRecord>;
  normalizeOrientation(sourceUri: string, outputUri: string, jpegQuality: number, cancellationId?: string): Promise<FileBackedDescriptor>;
  detectRectangle(sourceUri: string, cancellationId?: string): Promise<NormalizedQuad | null>;
  processReceiptImage(request: ProcessReceiptImageRequest): Promise<ProcessReceiptImageResult>;
  recognizeText(request: RecognizeTextRequest): Promise<RecognizeTextResult>;
  cancelOperation(cancellationId: string): Promise<boolean>;
  analyzeFrameCompact(frameTimestampMs: number, cancellationId?: string): Promise<FrameAnalysisResult>;
}
