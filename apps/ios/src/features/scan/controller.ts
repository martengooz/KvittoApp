import { scanReceiptText, type OcrInfo, type Receipt } from '@kvitto/shared';

import { advance, IDLE_WATCH, type FrameReading, type WatchState } from '../../../../web/src/scan/auto-capture';
import type { Quad } from '../../../../web/src/cv/types';
import type {
  FileBackedDescriptor,
  FrameAnalysisResult,
  NormalizedQuad,
  ProcessReceiptImageResult,
  RecognizeTextResult,
} from '../../../modules/kvitto-native/src';
import { clampQuad, rotateClockwise } from './geometry';
import type {
  ScanBatchFailure,
  ScanBatchOutcome,
  ScanControllerOptions,
  ScanOcrOutcome,
  ScanPermissionState,
  ScanStagedDescriptor,
  ScanState,
} from './types';

const DEFAULT_FRAME_CADENCE_MS = 180;
const DEFAULT_ARM_DELAY_MS = 900;
const DEFAULT_STALL_AFTER_MS = 7000;
const DEFAULT_STALLED_CADENCE_MULTIPLIER = 3;
const MIN_EVIDENCE = 0.35;

const EMPTY_OCR: ScanOcrOutcome = {
  outcome: 'empty',
  filled: [],
};

function toQuad(input: NormalizedQuad): Quad {
  return [
    { x: input.topLeft.x, y: input.topLeft.y },
    { x: input.topRight.x, y: input.topRight.y },
    { x: input.bottomRight.x, y: input.bottomRight.y },
    { x: input.bottomLeft.x, y: input.bottomLeft.y },
  ];
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toFrameReading(analysis: FrameAnalysisResult): FrameReading {
  const trusted = analysis.status === 'ready' && analysis.pluginLinked && analysis.evidenceScore >= MIN_EVIDENCE;
  const corners = analysis.normalizedQuad ? toQuad(analysis.normalizedQuad) : null;
  const ink = Math.min(0.6, Math.max(0.02, 0.1 + analysis.evidenceScore * 0.35));

  return {
    corners,
    detection: trusted ? 'paper' : 'threshold',
    coverage: analysis.coverage,
    ink,
    frameWidth: 1,
    frameHeight: 1,
  };
}

function nowClock(): number {
  return Date.now();
}

function createStageId(now: number): string {
  return `scan-stage-${now}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface ScanFeatureController {
  getState(): Readonly<ScanState>;
  syncRecoverableStages(): Promise<void>;
  /** Re-reads the platform's permission; returns the fresh value. */
  refreshPermission(): ScanPermissionState;
  requestPermission(): Promise<ScanPermissionState>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  onInterruption(reason: 'backgrounded' | 'camera-interrupted' | 'resumed'): Promise<void>;
  ingestFrame(nowMs?: number): Promise<void>;
  manualShutter(): Promise<void>;
  setCrop(quad: NormalizedQuad | null): Promise<void>;
  rotateClockwise(): Promise<void>;
  confirm(): Promise<string>;
  cancelActiveOperations(): Promise<void>;
  importFromLibrary(): Promise<ScanBatchOutcome>;
}

export function createScanFeatureController(options: ScanControllerOptions): ScanFeatureController {
  const clock = options.clock ?? { now: nowClock };
  const frameCadenceMs = options.frameCadenceMs ?? DEFAULT_FRAME_CADENCE_MS;
  const armDelayMs = options.armDelayMs ?? DEFAULT_ARM_DELAY_MS;
  const stallAfterMs = options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
  const stalledCadenceMultiplier = options.stalledCadenceMultiplier ?? DEFAULT_STALLED_CADENCE_MULTIPLIER;

  const state: ScanState = {
    /*
     * Read from the platform rather than assumed. Starting at `unknown` meant
     * an app relaunched with permission already granted showed a paused
     * preview and offered to request something the user had already given -
     * and the only way out was a button that had wrapped below the fold.
     */
    permission: options.camera.getPermission(),
    stage: 'capture',
    auto: 'off',
    manualShutterEnabled: true,
    interruption: 'none',
    frameCadenceMs,
    lastFrameAnalyzedAtMs: 0,
    activeStageId: null,
    review: null,
    processing: false,
    importProgress: null,
    stalledSinceMs: null,
    recoverableStageIds: [],
  };

  let armedAtMs = 0;
  let searchStartMs = 0;
  let watchState: WatchState = IDLE_WATCH;
  let activeProcessToken = 0;
  let activeProcessCancellationId: string | null = null;

  function resetWatcher(nowMs: number): void {
    watchState = IDLE_WATCH;
    searchStartMs = nowMs;
    state.auto = state.permission === 'granted' ? 'searching' : 'off';
    state.stalledSinceMs = null;
  }

  async function syncRecoverableStages(): Promise<void> {
    const staged = await options.staging.list();
    state.recoverableStageIds = staged.map((entry) => entry.id);
  }

  /** Re-reads the platform's answer, e.g. when the scan screen appears. */
  function refreshPermission(): ScanPermissionState {
    state.permission = options.camera.getPermission();
    if (state.permission !== 'granted') state.auto = 'off';
    return state.permission;
  }

  async function requestPermission(): Promise<ScanPermissionState> {
    state.permission = await options.camera.requestPermission();
    if (state.permission !== 'granted') {
      state.auto = 'off';
      state.stage = 'capture';
      return state.permission;
    }
    resetWatcher(clock.now());
    return state.permission;
  }

  async function startCapture(): Promise<void> {
    if (state.permission !== 'granted') {
      const permission = await requestPermission();
      if (permission !== 'granted') return;
    }

    if (state.stage === 'review' && state.activeStageId) {
      await options.staging.remove(state.activeStageId);
      state.activeStageId = null;
      state.review = null;
      await syncRecoverableStages();
    }

    state.stage = 'capture';

    await options.camera.startPreview();
    const nowMs = clock.now();
    armedAtMs = nowMs + armDelayMs;
    resetWatcher(nowMs);
    state.interruption = 'none';
  }

  async function stopCapture(): Promise<void> {
    await options.camera.stopPreview();
    state.auto = 'off';
  }

  async function onInterruption(reason: 'backgrounded' | 'camera-interrupted' | 'resumed'): Promise<void> {
    if (reason === 'resumed') {
      state.interruption = 'none';
      if (state.permission === 'granted') {
        await options.camera.startPreview();
        const nowMs = clock.now();
        armedAtMs = nowMs + armDelayMs;
        resetWatcher(nowMs);
      }
      return;
    }

    state.interruption = reason;
    state.auto = 'off';
    await options.camera.stopPreview();
  }

  async function processStagedSource(
    staged: ScanStagedDescriptor,
    forcedQuad: NormalizedQuad | null,
  ): Promise<ProcessReceiptImageResult> {
    const processToken = ++activeProcessToken;
    const cancellationId = `${staged.id}:process:${processToken}`;
    activeProcessCancellationId = cancellationId;
    state.processing = true;
    state.stage = 'processing';

    try {
      const normalized = await options.native.normalizeOrientation(
        staged.source.uri,
        options.paths.tempUri('normalized', staged.id),
        0.92,
        cancellationId,
      );

      const processed = await options.native.processReceiptImage({
        source: normalized,
        outputUri: options.paths.tempUri('processed', staged.id),
        thumbnailUri: options.paths.tempUri('thumb', staged.id),
        maxLongEdge: 1568,
        jpegQuality: 0.9,
        enhancement: 'grayscale',
        cancellationId,
        forcedQuad,
      });

      if (processToken !== activeProcessToken) {
        throw new Error('stale-process-result');
      }

      state.review = {
        source: staged.source,
        processed: processed.output,
        thumbnail: processed.thumbnail,
        fallbackUsed: processed.fallbackUsed,
        detectionSource: processed.detectionSource,
        autoDetectedQuad: processed.rectangle ? clampQuad(processed.rectangle) : null,
        cropQuad: forcedQuad ? clampQuad(forcedQuad) : processed.rectangle ? clampQuad(processed.rectangle) : null,
        rotation: state.review?.rotation ?? 0,
      };
      state.stage = 'review';
      return processed;
    } catch (error) {
      if (describeError(error) === 'stale-process-result') {
        throw error;
      }

      const fallback: ProcessReceiptImageResult = {
        output: staged.source,
        thumbnail: staged.source,
        rectangle: null,
        detectionSource: 'fallback-full-frame',
        fallbackUsed: true,
        timing: {
          startedAtMs: clock.now(),
          endedAtMs: clock.now(),
          durationMs: 0,
        },
      };
      state.review = {
        source: staged.source,
        processed: fallback.output,
        thumbnail: fallback.thumbnail,
        fallbackUsed: true,
        detectionSource: fallback.detectionSource,
        autoDetectedQuad: null,
        cropQuad: forcedQuad ? clampQuad(forcedQuad) : null,
        rotation: state.review?.rotation ?? 0,
      };
      state.stage = 'review';
      return fallback;
    } finally {
      if (activeProcessCancellationId === cancellationId) activeProcessCancellationId = null;
      state.processing = false;
    }
  }

  async function captureAndProcess(trigger: 'manual' | 'auto'): Promise<void> {
    if (state.permission !== 'granted') return;
    if (state.processing) return;

    state.auto = trigger === 'auto' ? 'capturing' : state.auto;
    const source = await options.camera.captureStill();
    const stage: ScanStagedDescriptor = {
      id: createStageId(clock.now()),
      sourceType: 'camera',
      source,
      createdAtMs: clock.now(),
    };

    await options.staging.put(stage);
    state.activeStageId = stage.id;
    await syncRecoverableStages();
    await processStagedSource(stage, null);
    if (trigger === 'auto') options.haptics.impact('success');
  }

  async function ingestFrame(nowMs = clock.now()): Promise<void> {
    if (state.permission !== 'granted') {
      state.auto = 'off';
      return;
    }
    if (state.stage !== 'capture' || state.interruption !== 'none') {
      state.auto = 'off';
      return;
    }

    const cadence = state.auto === 'stalled' ? frameCadenceMs * stalledCadenceMultiplier : frameCadenceMs;
    if (nowMs - state.lastFrameAnalyzedAtMs < cadence) return;
    state.lastFrameAnalyzedAtMs = nowMs;

    const analysis = await options.camera.analyzeFrameCompact(nowMs);
    const reading = toFrameReading(analysis);

    if (nowMs < armedAtMs) {
      state.auto = 'searching';
      return;
    }

    const verdict = advance(watchState, reading);
    watchState = verdict.state;

    if (state.auto !== 'stalled') {
      const since = nowMs - searchStartMs;
      if (since >= stallAfterMs) {
        state.auto = 'stalled';
        state.stalledSinceMs = nowMs;
      }
    }

    if (!verdict.capture) {
      state.auto = verdict.state.status === 'holding' ? 'holding' : state.auto === 'stalled' ? 'stalled' : 'searching';
      return;
    }

    state.auto = 'capturing';
    await captureAndProcess('auto');
    resetWatcher(clock.now());
  }

  async function manualShutter(): Promise<void> {
    await captureAndProcess('manual');
  }

  async function loadActiveStage(): Promise<ScanStagedDescriptor> {
    if (!state.activeStageId) throw new Error('No active stage to process');
    const staged = await options.staging.list();
    const current = staged.find((entry) => entry.id === state.activeStageId);
    if (!current) throw new Error('Staged source no longer exists');
    return current;
  }

  async function setCrop(quad: NormalizedQuad | null): Promise<void> {
    if (!state.review) throw new Error('No review image to crop');
    state.review.cropQuad = quad ? clampQuad(quad) : null;
    const staged = await loadActiveStage();
    await processStagedSource(staged, state.review.cropQuad);
  }

  async function rotateReview(): Promise<void> {
    if (!state.review) throw new Error('No review image to rotate');
    state.review.rotation = rotateClockwise(state.review.rotation);
    const staged = await loadActiveStage();
    await processStagedSource(staged, state.review.cropQuad);
  }

  async function confirm(): Promise<string> {
    if (!state.review || !state.activeStageId) throw new Error('No scan to confirm');
    const stage = await loadActiveStage();

    const sourceStored = await options.native.storeContentAddressedFile({
      sourceUri: state.review.source.uri,
      mimeType: state.review.source.mimeType,
      width: state.review.source.width,
      height: state.review.source.height,
      byteSize: state.review.source.byteSize,
      role: 'original',
      knownSha256Id: state.review.source.sha256Id ?? undefined,
    });

    const processedDescriptor = state.review.processed ?? state.review.source;
    const processedStored = await options.native.storeContentAddressedFile({
      sourceUri: processedDescriptor.uri,
      mimeType: processedDescriptor.mimeType,
      width: processedDescriptor.width,
      height: processedDescriptor.height,
      byteSize: processedDescriptor.byteSize,
      role: 'processed',
      knownSha256Id: processedDescriptor.sha256Id ?? undefined,
    });

    let thumbId: string | null = null;
    const thumbDescriptor = state.review.thumbnail;
    if (thumbDescriptor) {
      const thumbStored = await options.native.storeContentAddressedFile({
        sourceUri: thumbDescriptor.uri,
        mimeType: thumbDescriptor.mimeType,
        width: thumbDescriptor.width,
        height: thumbDescriptor.height,
        byteSize: thumbDescriptor.byteSize,
        role: 'thumb',
        knownSha256Id: thumbDescriptor.sha256Id ?? undefined,
      });
      thumbId = thumbStored.sha256Id;
    }

    const receipt = await options.repo.createReceipt({
      source: stage.sourceType,
      originalImageId: sourceStored.sha256Id,
      imageId: processedStored.sha256Id,
      thumbId,
      status: 'draft',
    });

    await options.jobs.enqueue({
      kind: 'image-processing',
      receiptId: receipt.id,
      sourceVersion: receipt.updatedAt,
      sourceImageId: sourceStored.sha256Id,
    });
    await options.jobs.enqueue({
      kind: 'ocr',
      receiptId: receipt.id,
      sourceVersion: receipt.updatedAt,
      sourceImageId: sourceStored.sha256Id,
    });
    // Enqueued unconditionally. Whether it does anything is decided when it
    // runs, from the settings as they are then - queueing it conditionally here
    // would mean a receipt scanned before AI was configured never gets read.
    await options.jobs.enqueue({
      kind: 'extraction',
      receiptId: receipt.id,
      sourceVersion: receipt.updatedAt,
      sourceImageId: sourceStored.sha256Id,
    });

    await options.staging.remove(state.activeStageId);
    await syncRecoverableStages();

    state.activeStageId = null;
    state.review = null;
    state.stage = 'capture';
    state.auto = state.permission === 'granted' ? 'searching' : 'off';
    return receipt.id;
  }

  async function cancelActiveOperations(): Promise<void> {
    if (activeProcessCancellationId) {
      await options.native.cancelOperation(activeProcessCancellationId);
      activeProcessCancellationId = null;
    }
  }

  async function importFromLibrary(): Promise<ScanBatchOutcome> {
    const files = await options.library.pickImages();
    state.stage = 'importing';

    const failures: ScanBatchFailure[] = [];
    let imported = 0;
    let fallbackCount = 0;

    for (const [index, source] of files.entries()) {
      state.importProgress = {
        total: files.length,
        index: index + 1,
        imported,
      };

      const stage: ScanStagedDescriptor = {
        id: createStageId(clock.now()),
        sourceType: 'upload',
        source,
        createdAtMs: clock.now(),
      };

      state.activeStageId = stage.id;
      await options.staging.put(stage);
      await syncRecoverableStages();

      try {
        const processed = await processStagedSource(stage, null);
        if (processed.fallbackUsed) fallbackCount += 1;
        await confirm();
        imported += 1;
      } catch (error) {
        failures.push({
          stageId: stage.id,
          uri: source.uri,
          message: describeError(error),
        });
        options.haptics.impact('warning');
      }
    }

    state.stage = 'capture';
    state.importProgress = null;

    return {
      total: files.length,
      imported,
      failed: failures.length,
      fallbackCount,
      failures,
    };
  }

  return {
    getState() {
      return state;
    },
    syncRecoverableStages,
    refreshPermission,
    requestPermission,
    startCapture,
    stopCapture,
    onInterruption,
    ingestFrame,
    manualShutter,
    setCrop,
    rotateClockwise: rotateReview,
    confirm,
    cancelActiveOperations,
    importFromLibrary,
  };
}

export interface SourceFirstOcrInput {
  nativeRecognize(input: {
    source: FileBackedDescriptor;
    preferredLanguages: string[];
    cancellationId?: string;
  }): Promise<RecognizeTextResult>;
  repo: {
    getReceipt(id: string): Promise<Awaited<ReturnType<ScanControllerOptions['repo']['getReceipt']>>>;
    updateReceipt(id: string, patch: Record<string, unknown>): Promise<unknown>;
  };
  receiptId: string;
  source: FileBackedDescriptor;
  sourceVersion: number;
  now: () => number;
  cancellationId?: string;
  /**
   * Links the receipt to a company in the registry. Absent when company
   * lookup is not configured, in which case OCR files what it read and stops -
   * which is the whole behaviour this feature had before.
   */
  enrichCompany?: CompanyEnricher;
}

/**
 * The registry step, as this function needs it.
 *
 * Injected rather than imported so the OCR path keeps working with nothing
 * configured, and so its own tests never touch a network client.
 */
export type CompanyEnricher = (input: {
  receipt: Receipt;
  receiptText: string;
  orgNumber: { digits: string; formatted: string } | null;
}) => Promise<{
  patch: Partial<Pick<Receipt, 'companyId' | 'merchant'>>;
  filled: Array<'orgNumber' | 'companyName'>;
  lookup: 'cached' | 'fetched' | null;
}>;

function buildOcrInfo(result: RecognizeTextResult, now: number): OcrInfo {
  const confidenceMean = result.observations.length === 0
    ? 0
    : result.observations.reduce((sum, entry) => sum + entry.confidence, 0) / result.observations.length;
  const findings = scanReceiptText(result.text, { today: new Date(now) });

  return {
    text: result.text,
    confidence: Math.round(confidenceMean * 100),
    engine: 'vision',
    at: now,
    durationMs: result.timing.durationMs,
    orgNumbers: findings.orgNumbers.map((candidate) => ({
      value: candidate.formatted,
      confidence: candidate.confidence,
      repaired: candidate.repaired,
    })),
    dates: findings.dates.map((candidate) => ({
      value: candidate.value,
      confidence: candidate.confidence,
    })),
  };
}

export async function runSourceFirstOcrEnrichment(input: SourceFirstOcrInput): Promise<ScanOcrOutcome> {
  const recognized = await input.nativeRecognize({
    source: input.source,
    preferredLanguages: ['sv-SE', 'en-US'],
    cancellationId: input.cancellationId,
  });

  if (recognized.cancelled) return { outcome: 'cancelled', filled: [] };
  if (!recognized.text.trim()) return EMPTY_OCR;

  const now = input.now();
  const findings = scanReceiptText(recognized.text, { today: new Date(now) });
  const receipt = await input.repo.getReceipt(input.receiptId);
  if (!receipt || receipt.updatedAt !== input.sourceVersion) {
    return { outcome: 'stale', filled: [] };
  }

  const patch: Record<string, unknown> = {
    ocr: buildOcrInfo(recognized, now),
  };
  const filled: Array<'purchasedAt' | 'orgNumber' | 'companyName'> = [];

  if (!receipt.purchasedAt && findings.purchasedAt) {
    patch.purchasedAt = findings.purchasedAt.value;
    filled.push('purchasedAt');
  }

  if (!receipt.merchant.orgNumber && findings.orgNumber) {
    patch.merchant = {
      ...receipt.merchant,
      orgNumber: findings.orgNumber.formatted,
    };
    filled.push('orgNumber');
  }

  let companyLookup: 'cached' | 'fetched' | null = null;
  if (input.enrichCompany) {
    /*
     * Applied into the same patch rather than a second write. A receipt whose
     * merchant and company arrive separately is briefly inconsistent, and the
     * detail screen is subscribed to both.
     *
     * A failing lookup must not lose the OCR findings, which are the part that
     * cost the user a scan - so this cannot throw past here.
     */
    try {
      const company = await input.enrichCompany({
        receipt,
        receiptText: recognized.text,
        orgNumber: findings.orgNumber
          ? { digits: findings.orgNumber.digits, formatted: findings.orgNumber.formatted }
          : null,
      });
      companyLookup = company.lookup;
      if (company.patch.companyId) patch.companyId = company.patch.companyId;
      if (company.patch.merchant) {
        patch.merchant = { ...(patch.merchant as Receipt['merchant'] | undefined ?? receipt.merchant), ...company.patch.merchant };
      }
      for (const field of company.filled) {
        if (!filled.includes(field)) filled.push(field);
      }
    } catch {
      // Left null. The lookup is an enhancement; OCR is the result.
    }
  }

  await input.repo.updateReceipt(input.receiptId, patch);
  return {
    outcome: 'applied',
    filled,
    companyLookup,
  };
}
