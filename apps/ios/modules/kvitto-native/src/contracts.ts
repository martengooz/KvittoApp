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

export interface ArchiveWriteEntry {
  path: string;
  sourceFileUri: string;
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

/** One OS-granted background window, as the native coordinator reports it. */
export interface NativeBackgroundLaunch {
  /** Opaque token identifying this window; every other call takes it. */
  handle: string;
  identifier: string;
  startedAt: number;
  /**
   * Always null on iOS. `BGTaskScheduler` never tells the app how much time it
   * has - the expiration handler firing is the only signal, and by then the
   * window is over. Kept in the shape because the runner's contract allows a
   * real deadline and a future platform may supply one.
   */
  deadlineAt: number | null;
}

export type BackgroundScheduleOutcome =
  | 'scheduled'
  | 'already-scheduled'
  /** Background App Refresh is off, by the user or by Low Power Mode. */
  | 'not-permitted'
  | 'unavailable';

export interface EventSubscription {
  remove(): void;
}

export interface KvittoNativeFacade {
  hashFileSha256(fileUri: string): Promise<string>;
  computeShardPath(sha256Id: string): Promise<string>;
  storeContentAddressedFile(request: StoreBlobRequest): Promise<BlobMetadataRecord>;
  getBlobMetadata(sha256Id: string): Promise<BlobMetadataRecord | null>;
  putBlobMetadata(record: BlobMetadataRecord): Promise<BlobMetadataRecord>;
  markBlobUploaded(sha256Id: string): Promise<void>;
  listBlobMetadataPendingUpload(limit: number): Promise<BlobMetadataRecord[]>;
  /** Every blob on the device. Export needs the whole set. */
  listAllBlobMetadata(limit: number): Promise<BlobMetadataRecord[]>;
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
  /** Reads `length` bytes from `offset` as base64; `''` at end of file. */
  readFileChunkBase64(fileUri: string, offset: number, length: number): Promise<string>;
  /** Appends (or creates with) base64 content. Returns bytes written. */
  writeFileChunkBase64(fileUri: string, base64: string, append: boolean): Promise<number>;
  /**
   * Writes a `.kvitto` archive from files already on disk. Paths are validated
   * with the same rules the reader enforces, so an archive this app writes is
   * one it would accept. Returns the entry count.
   */
  writeArchive(destinationUri: string, entries: ArchiveWriteEntry[]): Promise<number>;
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

  /** The single `BGTaskScheduler` identifier this app registers. */
  /**
   * Routes the app should drive itself through at launch, from the process
   * environment. Empty in every normal launch.
   *
   * This exists because a physical device has no `simctl openurl`: `devicectl`
   * can launch and screenshot but cannot open a URL or tap, so without a
   * channel like this, no screen past the first is reachable on hardware.
   */
  launchRoutes(): string[];
  /** Milliseconds to hold each driven route, from the environment. */
  launchRouteDwellMs(): number;
  /**
   * One action the scan screen should perform at launch, from the environment.
   * Empty in every normal launch; only `capture` is recognised.
   */
  launchScanAction(): string;
  backgroundTaskIdentifier(): string;
  /**
   * Windows that opened before JS was listening. iOS can launch the app
   * straight into the background to run a task, so the first window of a cold
   * background launch always arrives this way rather than as an event.
   */
  drainPendingBackgroundLaunches(): NativeBackgroundLaunch[];
  /** Synchronous: the sweep polls this between jobs, where a promise is stale. */
  isBackgroundLaunchExpired(handle: string): boolean;
  /** Completes the window. False means it was already finished. */
  finishBackgroundLaunch(handle: string, success: boolean): boolean;
  scheduleBackgroundProcessing(
    earliestDelaySeconds: number,
    requiresNetwork: boolean,
    requiresPower: boolean,
  ): Promise<BackgroundScheduleOutcome>;
  cancelBackgroundProcessing(): Promise<void>;
  pendingBackgroundTaskIdentifiers(): Promise<string[]>;
  onBackgroundLaunch(listener: (launch: NativeBackgroundLaunch) => void): EventSubscription;
}
