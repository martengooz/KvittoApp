/**
 * The scan screen's state machine: capture → process → review → save, plus
 * the unattended import path that skips review entirely.
 *
 * This owns the ~11 fields that describe one capture attempt, the camera's
 * lifecycle (`getUserMedia` start/stop, the file-picker fallback) and every
 * call into the CV pipeline. `views/scan.ts` only reads `session.state` to
 * render and calls back into these methods — it never mutates state itself,
 * and never has to reason about whether the screen has been torn down mid-await.
 */

import type { ReceiptSource } from '@kvitto/shared';

import { el, nextFrame } from '../core/dom.js';
import { haptic } from '../core/platform.js';
import { router } from '../core/router.js';
import { getSettings } from '../core/settings.js';
import { toast } from '../core/toast.js';
import { cvClient, decodeImage } from '../cv/client.js';
import type { PipelineResult, Quad } from '../cv/types.js';
import { parseReceipt } from '../ai/index.js';
import { enrichFromImage } from '../ocr/enrich.js';
import { ocrClient } from '../ocr/client.js';
import {
  advance,
  coverageOf,
  IDLE_WATCH,
  inkRatio,
  PROBE_SIZE,
  type FrameReading,
  type WatchState,
} from './auto-capture.js';
import { describeImportOutcome, importImages, saveScan, type ImportProgress } from './import.js';

export type Stage = 'capture' | 'processing' | 'review' | 'importing';

/**
 * What the live preview is doing.
 *
 * `unavailable` covers both halves of one outcome — no `getUserMedia` at all,
 * and a `getUserMedia` that was refused — because the screen does the same
 * thing about either: the shutter hands over to the native file picker, which
 * every mobile browser answers with a camera of its own.
 */
export type CameraState = 'starting' | 'live' | 'stopped' | 'unavailable';

/**
 * What the shutter is waiting for, when it is waiting by itself.
 *
 * `off` is both halves of "nobody is watching": the setting is off, or the
 * detector never loaded. `stalled` is a search that has gone on long enough to
 * stop promising — a receipt this camera cannot make out, and a user who should
 * be told to press the button. Either way the screen says so rather than
 * promising a picture that is never going to be taken.
 */
export type AutoCaptureStatus = 'off' | 'searching' | 'stalled' | 'holding' | 'capturing';

export interface ScanState {
  stage: Stage;
  /** Whether the viewfinder is showing a live picture, and why not when it is not. */
  camera: CameraState;
  /** What the automatic shutter is doing. */
  auto: AutoCaptureStatus;
  /** The untouched capture. */
  source: Blob | null;
  sourceUrl: string | null;
  sourceWidth: number;
  sourceHeight: number;
  result: PipelineResult | null;
  resultUrl: string | null;
  corners: Quad | null;
  rotation: 0 | 90 | 180 | 270;
  showOriginal: boolean;
  /** Progress of an unattended upload, while one is running. */
  importing: ImportProgress | null;
}

export interface ScanSession {
  readonly state: ScanState;
  /** The live camera stream, for the capture screen to bind to its `<video>`. */
  readonly stream: MediaStream | null;
  /**
   * Starts the live preview; one already running or already coming up is left
   * as it is.
   *
   * The capture screen calls this as it mounts, so that the permission prompt
   * lands when the user opened the camera rather than in the way of the picture
   * they meant to take. Nothing waits for the answer: a refusal lands in
   * `unavailable`, where the shutter falls back to the file picker.
   */
  startCamera(): Promise<void>;
  stopCamera(): void;
  openFilePicker(source: 'camera' | 'library'): void;
  /** Takes the picture from the live preview — the shutter, pressed or automatic. */
  captureFrame(): Promise<void>;
  runImport(files: File[]): Promise<void>;
  /** Re-runs the CV pipeline from the original capture — after a rotation or a manual crop. */
  reprocess(): Promise<void>;
  rotate(): Promise<void>;
  setCorners(corners: Quad | null): void;
  setShowOriginal(value: boolean): void;
  /** Discards the capture and returns to the viewfinder — the review screen's "Ta om". */
  retake(): void;
  save(andParse: boolean): Promise<void>;
}

/**
 * How long after one reading of the preview before the next is taken.
 *
 * Measured from the end of the last reading rather than on a fixed interval, so
 * a phone that needs 150 ms to look at a frame simply looks less often instead
 * of queueing work it cannot keep up with. The detector costs ~30 ms per 420 px
 * frame on a laptop, and three readings at this spacing is the roughly one
 * second of holding still that the screen asks for.
 */
const PROBE_INTERVAL_MS = 180;

/**
 * Quiet time after the preview starts before the shutter may fire by itself.
 *
 * A camera coming up already pointed at the last receipt would otherwise take a
 * picture out of a frame the user has not looked at yet.
 */
const ARM_DELAY_MS = 900;

/**
 * The multiplier applied to that spacing once a search has given up.
 *
 * A screen left open on a table would otherwise keep a detector running flat
 * out at nothing. Still watching — a receipt held up is picked up within a
 * second — for a third of the work.
 */
const STALLED_SLOWDOWN = 3;

/**
 * How long a fruitless search goes on before the screen stops promising.
 *
 * Long enough not to give up on someone still lining the shot up, short enough
 * that a receipt the detector simply cannot make out — glossy, crumpled, dark —
 * hands the user back to the button rather than leaving them waiting on it.
 */
const GIVE_UP_MS = 7000;

export interface ScanSessionOptions {
  /**
   * Called whenever state has changed in a way the screen should re-render for.
   * A no-op once the session is disposed, so nothing here needs to re-check
   * that by hand the way the view used to.
   */
  onChange: () => void;
  /**
   * Called with every look the watcher takes at the preview, several times a
   * second — far too often to re-render for. The screen moves its outline in
   * place from this and leaves the rest of the DOM alone; `onChange` still
   * fires for the state changes worth a render.
   */
  onReading?: (reading: FrameReading | null) => void;
  /** The preview. The watcher reads frames from it and the shutter captures from it. */
  video: HTMLVideoElement;
}

/**
 * Builds a scan session and wires its own teardown into the current route.
 */
export function createScanSession(options: ScanSessionOptions): ScanSession {
  const { onChange, video } = options;
  const state: ScanState = {
    stage: 'capture',
    camera: 'stopped',
    auto: 'off',
    source: null,
    sourceUrl: null,
    sourceWidth: 0,
    sourceHeight: 0,
    result: null,
    resultUrl: null,
    corners: null,
    rotation: 0,
    showOriginal: false,
    importing: null,
  };

  let stream: MediaStream | null = null;
  let disposed = false;
  /**
   * Which attempt at starting the camera is the current one.
   *
   * `getUserMedia` can sit on a permission prompt for as long as the user likes,
   * and by the time it answers the screen may have stopped the camera or asked
   * again. Stamping each attempt — and bumping the stamp whenever the camera is
   * stopped — is how a stream nobody is waiting for any more gets closed rather
   * than adopted.
   */
  let cameraRequest = 0;

  let watch: WatchState = IDLE_WATCH;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the preview started, for {@link ARM_DELAY_MS}. */
  let armedAt = 0;
  /** When the current fruitless stretch began, for {@link GIVE_UP_MS}. */
  let searchingSince = 0;
  /** Reused between readings: one canvas, however long the screen stays open. */
  let probe: HTMLCanvasElement | null = null;

  function notify(): void {
    if (!disposed) onChange();
  }

  function releaseUrls(): void {
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.sourceUrl = null;
    state.resultUrl = null;
  }

  function setCamera(next: CameraState): void {
    if (state.camera === next) return;
    state.camera = next;
    // The watcher exists exactly as long as there is a picture to watch.
    if (next === 'live') startWatching();
    else stopWatching();
    notify();
  }

  function stopCamera(): void {
    cameraRequest += 1;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (state.camera === 'live' || state.camera === 'starting') setCamera('stopped');
  }

  router.onTeardown(() => {
    disposed = true;
    stopCamera();
    stopWatching();
    releaseUrls();
  });

  // Downloading OpenCV takes a moment; start it now so it overlaps with the
  // user lining up the shot rather than adding to the wait after the shutter.
  void cvClient.warmup().then(() => {
    // The runtime routinely lands after the camera has: without this the first
    // visit of a session would watch nothing, having been ready a moment late.
    startWatching();
    if (state.stage === 'capture') notify();
    // The OCR runtime is a separate download. Start it only once OpenCV is in:
    // the two compete for the same connection, and a scan cannot begin without
    // OpenCV whereas it merely finishes later without Tesseract.
    void ocrClient.warmup();
  });

  // --- capture --------------------------------------------------------------

  async function startCamera(): Promise<void> {
    if (state.camera === 'starting' || state.camera === 'live') return;
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setCamera('unavailable');
      return;
    }

    setCamera('starting');
    const request = (cameraRequest += 1);
    try {
      const opened = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Ask for a high-resolution frame: small print needs the pixels, and
          // the pipeline downscales afterwards anyway.
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });

      // The prompt can outlast the screen, or the camera being stopped while it
      // was still up. Either way the stream is nobody's now.
      if (disposed || request !== cameraRequest) {
        opened.getTracks().forEach((track) => track.stop());
        return;
      }

      stream = opened;
      // A track ends by itself when another app takes the camera or iOS
      // reclaims it from a backgrounded tab. Say so, rather than leaving a
      // frozen frame that still looks live. (`track.stop()`, which is how this
      // screen ends one, deliberately does not fire it.)
      for (const track of opened.getTracks()) {
        track.addEventListener('ended', () => {
          if (stream !== opened) return;
          stream = null;
          setCamera('stopped');
        });
      }
      setCamera('live');
    } catch (error) {
      // Not this screen's answer to report any more.
      if (request !== cameraRequest) return;
      // A refusal is a decision, not a failure: the shutter still takes a
      // photograph, it just goes through the native picker to get one.
      console.warn('Camera unavailable, the shutter will use the file picker', error);
      setCamera('unavailable');
    }
  }

  // --- the automatic shutter -------------------------------------------------

  function setAuto(status: AutoCaptureStatus): void {
    if (state.auto === status) return;
    // Both ends of a hold are worth a tap: one to say the receipt has been
    // found, one to say the picture is being taken.
    if (status === 'holding') haptic('selection');
    if (status === 'searching') searchingSince = Date.now();
    state.auto = status;
    notify();
  }

  /** Whether the shutter is allowed to fire by itself at all. */
  function autoCaptureEnabled(): boolean {
    return getSettings().image.autoCapture && cvClient.status.ready;
  }

  function startWatching(): void {
    if (watchTimer !== null || state.camera !== 'live' || !autoCaptureEnabled()) return;
    watch = IDLE_WATCH;
    armedAt = Date.now();
    setAuto('searching');
    scheduleReading(nextDelay());
  }

  function stopWatching(): void {
    if (watchTimer !== null) clearTimeout(watchTimer);
    watchTimer = null;
    watch = IDLE_WATCH;
    options.onReading?.(null);
    setAuto('off');
  }

  /** How long to wait before looking again, given what the last look found. */
  function nextDelay(): number {
    return state.auto === 'stalled' ? PROBE_INTERVAL_MS * STALLED_SLOWDOWN : PROBE_INTERVAL_MS;
  }

  function scheduleReading(delay: number): void {
    if (watchTimer !== null) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      void takeReading().catch((error: unknown) => {
        // One bad frame must not end the watch: a loop that stops silently
        // looks exactly like a feature that was never there.
        console.warn('Auto-capture could not read the preview', error);
        scheduleReading(nextDelay());
      });
    }, delay);
  }

  /**
   * One look at the preview: a small copy of the current frame to the detector,
   * its answer to {@link advance}, and the shutter if that is what it says.
   */
  async function takeReading(): Promise<void> {
    if (disposed || state.stage !== 'capture' || state.camera !== 'live') return;
    // A hidden tab has nothing worth looking at, and its timers are throttled
    // to the point where "still" would mean nothing anyway.
    if (document.hidden || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      scheduleReading(nextDelay());
      return;
    }

    const reading = await readFrame();
    if (disposed || state.stage !== 'capture' || state.camera !== 'live') return;
    if (!reading) {
      scheduleReading(nextDelay());
      return;
    }

    options.onReading?.(reading);
    const verdict = advance(watch, reading);
    watch = verdict.state;
    // A receipt that is being found, even one that will not sit still, is not a
    // fruitless search: the outline on screen is already saying as much.
    if (watch.steady > 0) searchingSince = Date.now();
    setAuto(statusFor(watch));

    if (!verdict.capture || Date.now() - armedAt < ARM_DELAY_MS) {
      scheduleReading(nextDelay());
      return;
    }

    setAuto('capturing');
    haptic('impact');
    await captureFrame();
  }

  /**
   * The watch state, as the screen should describe it.
   *
   * A search that has found *nothing* for {@link GIVE_UP_MS} stops saying "point
   * at the receipt" and starts saying "press the button" — and stays there
   * until something is actually found, rather than working its way back round
   * to giving up every few seconds. A receipt the watcher can see but cannot
   * catch still is not that: it keeps searching, however long it takes.
   */
  function statusFor(watch: WatchState): AutoCaptureStatus {
    if (watch.status === 'holding') return 'holding';
    if (watch.steady > 0) return 'searching';
    if (state.auto === 'stalled') return 'stalled';
    return Date.now() - searchingSince >= GIVE_UP_MS ? 'stalled' : 'searching';
  }

  /** Measures the current frame: what the detector found, and what is inside it. */
  async function readFrame(): Promise<FrameReading | null> {
    const scale = PROBE_SIZE / Math.max(video.videoWidth, video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (width < 2 || height < 2) return null;

    probe ??= document.createElement('canvas');
    probe.width = width;
    probe.height = height;
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(video, 0, 0, width, height);
    // Read the pixels before the bitmap goes to the worker: the ink test needs
    // the frame itself, which only this side of the message has.
    const pixels = context.getImageData(0, 0, width, height).data;
    const found = await cvClient.detect(await createImageBitmap(probe));
    if (!found) return null;

    const corners = found.corners;
    return {
      corners,
      detection: found.detection,
      coverage: corners ? coverageOf(corners, width, height) : 0,
      ink: corners ? inkRatio(pixels, width, height, corners) : 0,
      frameWidth: width,
      frameHeight: height,
    };
  }

  /**
   * Back to the capture screen with the preview running again.
   *
   * Only a preview this screen stopped itself is restarted. A camera that was
   * refused stays refused rather than asking again every time a capture is
   * discarded.
   */
  function resumeCapture(): void {
    state.stage = 'capture';
    notify();
    if (state.camera === 'stopped') void startCamera();
  }

  /**
   * Opens the native file picker.
   *
   * `source` is not cosmetic on iOS. The `capture` attribute does not *suggest*
   * the camera there, it replaces the picker with it: the sheet loses "Photo
   * Library" and "Choose File" altogether. So it is set only where the camera
   * genuinely is the intent — the fallback when `getUserMedia` is unavailable
   * or refused — and never for the gallery button, which exists precisely to
   * reach photos already taken.
   */
  function openFilePicker(source: 'camera' | 'library'): void {
    const input = el('input', {
      type: 'file',
      accept: 'image/*',
      // Only the gallery takes several: `capture` hands the camera one frame.
      ...(source === 'camera' ? { capture: 'environment' } : { multiple: true }),
      class: 'visually-hidden',
    });
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length === 0) return;
      // A camera frame is one deliberate shot, so it keeps the review screen.
      // Photographs already taken go straight in, however many there are.
      if (source === 'camera') void handleCapture(files[0]!);
      else void runImport(files);
    });
    document.body.appendChild(input);
    input.click();
  }

  async function captureFrame(): Promise<void> {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      toast('Kunde inte läsa av kameran.', { kind: 'error' });
      return;
    }
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.95),
    );
    stopCamera();
    if (!blob) {
      toast('Kunde inte spara bilden från kameran.', { kind: 'error' });
      return;
    }
    await handleCapture(blob);
  }

  // --- unattended import ------------------------------------------------------

  /**
   * Files a batch of photographs without asking anything.
   *
   * The import itself lives in `scan/import.ts` and outlives this screen: the
   * user is sent to the list as soon as the images are saved, and the reading
   * and the extraction carry on from there.
   */
  async function runImport(files: File[]): Promise<void> {
    // Nothing to preview while the batch runs, and it can take a while.
    stopCamera();
    state.stage = 'importing';
    state.importing = { total: files.length, index: 1, name: files[0]?.name ?? '', imported: 0 };
    notify();
    await nextFrame();

    const outcome = await importImages(files, {
      source: 'upload',
      onProgress: (progress) => {
        if (disposed) return;
        state.importing = progress;
        notify();
      },
    });

    for (const t of describeImportOutcome(outcome)) toast(t.message, { kind: t.kind });

    if (outcome.receiptIds.length === 0) {
      if (!disposed) {
        state.importing = null;
        resumeCapture();
      }
      return;
    }

    // Only when the user is still watching this screen. The import outlives it
    // on purpose, and a batch finishing while they are reading their settings
    // must not drag them somewhere they did not ask to go — the toasts above
    // are the whole notification in that case.
    if (!disposed) router.navigate('/receipts');
  }

  // --- processing -------------------------------------------------------------

  async function handleCapture(source: Blob): Promise<void> {
    // The frame is taken; the preview has nothing left to show behind the
    // review screen. `captureFrame` has already done this for its own path.
    stopCamera();
    releaseUrls();
    state.source = source;
    state.corners = null;
    state.rotation = 0;
    state.showOriginal = false;
    state.stage = 'processing';
    notify();
    // Let the spinner paint before the main thread gets busy decoding.
    await nextFrame();

    try {
      const bitmap = await decodeImage(source);
      state.sourceWidth = bitmap.width;
      state.sourceHeight = bitmap.height;
      state.sourceUrl = URL.createObjectURL(source);
      await runPipeline(bitmap);
    } catch (error) {
      console.error('Capture failed', error);
      toast(error instanceof Error ? error.message : 'Bilden kunde inte läsas.', { kind: 'error' });
      resumeCapture();
    }
  }

  /** Runs the CV pipeline over a fresh decode of the original capture. */
  async function runPipeline(bitmap?: ImageBitmap): Promise<void> {
    if (!state.source) return;
    const settings = getSettings().image;
    // Always re-decode from the original: re-processing an already-processed
    // image would compound the enhancement every time a corner is nudged.
    const input = bitmap ?? (await decodeImage(state.source));

    const result = await cvClient.process(input, {
      detectEdges: settings.detectEdges,
      corners: state.corners,
      enhance: settings.enhance,
      maxDimension: settings.maxDimension,
      quality: settings.quality,
      rotate: state.rotation,
    });

    if (disposed) return;
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.result = result;
    state.resultUrl = URL.createObjectURL(result.blob);
    state.corners = result.corners;
    state.stage = 'review';
    notify();
  }

  async function reprocess(): Promise<void> {
    state.stage = 'processing';
    notify();
    await nextFrame();
    try {
      await runPipeline();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Bildbehandlingen misslyckades.', { kind: 'error' });
      state.stage = 'review';
      notify();
    }
  }

  async function rotate(): Promise<void> {
    state.rotation = ((state.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    await reprocess();
  }

  function setCorners(corners: Quad | null): void {
    state.corners = corners;
  }

  function setShowOriginal(value: boolean): void {
    state.showOriginal = value;
    notify();
  }

  function retake(): void {
    releaseUrls();
    state.source = null;
    state.result = null;
    resumeCapture();
  }

  // --- saving -------------------------------------------------------------

  async function save(andParse: boolean): Promise<void> {
    const result = state.result;
    if (!result) return;

    const receipt = await saveScan({
      source: 'camera' satisfies ReceiptSource,
      processed: result,
      original: state.source
        ? { blob: state.source, width: state.sourceWidth, height: state.sourceHeight }
        : null,
    });

    // Reads the organisation number and the date off the receipt itself, and
    // links its company. Deliberately not awaited: it takes a few seconds, and
    // the detail view picks the result up when it lands.
    //
    // It reads `state.source`, the untouched capture, rather than the processed
    // scan — measured against the fixtures, the enhancement that makes a good
    // scan makes a materially worse OCR input. See `ocr/prepare.ts`.
    const reading = state.source
      ? enrichFromImage(receipt.id, state.source).catch((error: unknown) => {
          console.warn('OCR enrichment failed', error);
          return null;
        })
      : Promise.resolve(null);

    if (!andParse) {
      toast('Kvittot sparades.', { kind: 'success' });
      router.navigate(`/receipt/${receipt.id}`);
      void reading.then((outcome) => {
        if (outcome?.company) toast(`Företag: ${outcome.company.name}`, { kind: 'success' });
      });
      return;
    }

    // Navigate straight to the receipt: parsing takes seconds, and the detail
    // view shows its progress. Blocking the scan screen would stop the user
    // from photographing the next receipt in the pile.
    router.navigate(`/receipt/${receipt.id}`);
    void parseReceipt(receipt.id).then((outcome) => {
      if (outcome.ok) {
        toast('Kvittot tolkades.', { kind: 'success' });
      } else if (outcome.error) {
        toast(outcome.error, { kind: 'error' });
      }
    });
  }

  return {
    state,
    get stream() {
      return stream;
    },
    startCamera,
    stopCamera,
    openFilePicker,
    captureFrame,
    runImport,
    reprocess,
    rotate,
    setCorners,
    setShowOriginal,
    retake,
    save,
  };
}
