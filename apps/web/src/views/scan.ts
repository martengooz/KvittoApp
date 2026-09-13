/**
 * The scan screen: capture → review → parse.
 *
 * Camera access is attempted through `getUserMedia`, which gives a live preview
 * and a proper shutter. When that is unavailable — an insecure context, a
 * denied permission, or a browser without the API — it silently falls back to a
 * file input with `capture="environment"`, which opens the native camera app on
 * every mobile browser. The scan button therefore always does something.
 */

import { formatBytes } from '@kvitto/shared';

import { createCropEditor, type CropEditor } from '../components/crop-editor.js';
import { banner, emptyState } from '../components/ui.js';
import { el, nextFrame, replaceChildren } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { haptic } from '../core/platform.js';
import { router } from '../core/router.js';
import { getSettings, isAiConfigured } from '../core/settings.js';
import { toast } from '../core/toast.js';
import { cvClient, decodeImage } from '../cv/client.js';
import type { PipelineResult, Quad } from '../cv/types.js';
import { parseReceipt } from '../ai/index.js';
import { putBlob } from '../db/blobs.js';
import { createReceipt } from '../db/repo.js';

type Stage = 'idle' | 'camera' | 'processing' | 'review';

interface ScanState {
  stage: Stage;
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
}

export function scanView(): HTMLElement {
  const root = el('div', { class: 'scan' });
  const state: ScanState = {
    stage: 'idle',
    source: null,
    sourceUrl: null,
    sourceWidth: 0,
    sourceHeight: 0,
    result: null,
    resultUrl: null,
    corners: null,
    rotation: 0,
    showOriginal: false,
  };

  let stream: MediaStream | null = null;
  let cropEditor: CropEditor | null = null;
  let disposed = false;

  // Downloading OpenCV takes a moment; start it now so it overlaps with the
  // user lining up the shot rather than adding to the wait after the shutter.
  void cvClient.warmup().then(() => {
    if (!disposed && state.stage === 'idle') render();
  });

  function releaseUrls(): void {
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.sourceUrl = null;
    state.resultUrl = null;
  }

  function stopCamera(): void {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  router.onTeardown(() => {
    disposed = true;
    stopCamera();
    cropEditor?.destroy();
    releaseUrls();
  });

  // --- capture ------------------------------------------------------------

  async function startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      openFilePicker();
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Ask for a high-resolution frame: small print needs the pixels, and
          // the pipeline downscales afterwards anyway.
          width: { ideal: 2560 },
          height: { ideal: 1440 },
        },
        audio: false,
      });
      state.stage = 'camera';
      render();
    } catch (error) {
      // A denied permission is a decision, not a failure — fall back quietly.
      console.warn('Camera unavailable, using the file picker instead', error);
      openFilePicker();
    }
  }

  function openFilePicker(): void {
    const input = el('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      class: 'visually-hidden',
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void handleCapture(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  async function captureFrame(video: HTMLVideoElement): Promise<void> {
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

  // --- processing ---------------------------------------------------------

  async function handleCapture(source: Blob): Promise<void> {
    releaseUrls();
    state.source = source;
    state.corners = null;
    state.rotation = 0;
    state.showOriginal = false;
    state.stage = 'processing';
    render();
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
      state.stage = 'idle';
      render();
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
    render();
  }

  async function reprocess(): Promise<void> {
    state.stage = 'processing';
    render();
    await nextFrame();
    try {
      await runPipeline();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Bildbehandlingen misslyckades.', { kind: 'error' });
      state.stage = 'review';
      render();
    }
  }

  // --- saving -------------------------------------------------------------

  async function save(andParse: boolean): Promise<void> {
    const result = state.result;
    if (!result) return;

    const settings = getSettings();
    const imageId = await putBlob(result.blob, {
      role: 'processed',
      width: result.width,
      height: result.height,
    });

    let originalImageId: string | null = null;
    if (settings.image.keepOriginal && state.source) {
      originalImageId = await putBlob(state.source, {
        role: 'original',
        width: state.sourceWidth,
        height: state.sourceHeight,
      });
    }

    const thumbId = await makeThumbnail(result.blob);
    const receipt = await createReceipt({
      source: 'camera',
      imageId,
      originalImageId,
      thumbId,
      status: 'draft',
    });

    if (!andParse) {
      toast('Kvittot sparades.', { kind: 'success' });
      router.navigate(`/receipt/${receipt.id}`);
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

  // --- rendering ----------------------------------------------------------

  function render(): void {
    cropEditor?.destroy();
    cropEditor = null;

    switch (state.stage) {
      case 'idle':
        replaceChildren(root, renderIdle());
        break;
      case 'camera':
        replaceChildren(root, renderCamera());
        break;
      case 'processing':
        replaceChildren(root, renderProcessing());
        break;
      case 'review':
        replaceChildren(root, renderReview());
        break;
    }
  }

  function renderIdle(): HTMLElement {
    const cv = cvClient.status;
    const aiReady = isAiConfigured();

    return el(
      'div',
      { class: 'scan-hero' },
      el(
        'button',
        {
          class: 'scan-button',
          type: 'button',
          on: {
            click: () => {
              haptic('impact');
              void startCamera();
            },
          },
        },
        icon('camera', { size: 56, className: 'scan-button__icon', weight: 1.4 }),
        el('span', { text: 'Skanna kvitto' }),
      ),
      el('p', { class: 'muted', style: 'font-size:15px;max-width:30ch',
        text: 'Lägg kvittot på ett jämnt underlag och håll kameran rakt ovanför.' }),
      el('button', {
        class: 'btn btn--plain',
        type: 'button',
        text: 'Välj bild från galleriet',
        on: { click: openFilePicker },
      }),
      el(
        'div',
        { class: 'status-line', style: 'margin-top:8px' },
        el('span', {
          class: [
            'status-dot',
            cv.ready ? 'status-dot--ok' : cv.loading ? 'status-dot--busy' : 'status-dot--warn',
          ],
        }),
        el('span', {
          text: cv.ready
            ? 'Bildbehandling redo — fungerar offline'
            : cv.loading
              ? 'Förbereder bildbehandling…'
              : 'Bildbehandling laddas vid första skanningen',
        }),
      ),
      aiReady
        ? null
        : el(
            'div',
            { style: 'margin-top:12px;text-align:left;width:100%' },
            banner({
              tone: 'info',
              title: 'Ingen AI-tolkning inställd',
              body: 'Du kan skanna och spara ändå — och fylla i uppgifterna själv.',
              actions: el('button', {
                class: 'btn btn--sm btn--plain',
                type: 'button',
                style: 'padding-left:0;margin-top:4px',
                text: 'Öppna inställningar',
                on: { click: () => router.navigate('/settings') },
              }),
            }),
          ),
    );
  }

  function renderCamera(): HTMLElement {
    const video = el('video', { autoplay: true, playsInline: true, muted: true });
    if (stream) video.srcObject = stream;

    return el(
      'div',
      { class: 'camera-stage' },
      video,
      el('p', { class: 'camera-hint', text: 'Få med hela kvittot i bild' }),
      el(
        'div',
        { class: 'camera-controls' },
        el('button', {
          class: 'camera-button',
          type: 'button',
          text: 'Avbryt',
          on: {
            click: () => {
              stopCamera();
              state.stage = 'idle';
              render();
            },
          },
        }),
        el('button', {
          class: 'shutter',
          type: 'button',
          'aria-label': 'Ta bild',
          on: {
            click: () => {
              haptic('impact');
              void captureFrame(video);
            },
          },
        }),
        el(
          'button',
          {
            class: 'camera-button',
            type: 'button',
            'aria-label': 'Välj från galleriet',
            on: {
              click: () => {
                stopCamera();
                openFilePicker();
              },
            },
          },
          icon('photo', { size: 26 }),
        ),
      ),
    );
  }

  function renderProcessing(): HTMLElement {
    return el(
      'div',
      { class: 'empty-state' },
      el('div', { class: 'spinner', style: 'width:28px;height:28px' }),
      el('p', { class: 'empty-state__title', text: 'Behandlar bilden…' }),
      el('p', { text: 'Hittar kvittots kanter, rätar ut och förbättrar kontrasten.' }),
    );
  }

  function renderReview(): HTMLElement {
    const result = state.result;
    if (!result) return renderIdle();

    const lowConfidence = result.detectionConfidence < 0.45;
    const preview = state.showOriginal ? buildCropEditor() : buildProcessedPreview(result);

    return el(
      'div',
      { class: 'crop' },
      lowConfidence
        ? banner({
            tone: 'warning',
            title: 'Osäker på kvittots kanter',
            body: 'Tryck på "Justera hörn" och dra dem på plats om beskärningen blev fel.',
          })
        : null,
      ...result.notes.map((note) => banner({ tone: 'info', body: note })),
      preview,
      el(
        'div',
        { class: 'stack stack--wrap', style: 'justify-content:center' },
        el('button', {
          class: 'btn btn--sm',
          type: 'button',
          text: state.showOriginal ? 'Visa resultat' : 'Justera hörn',
          on: {
            click: () => {
              state.showOriginal = !state.showOriginal;
              render();
            },
          },
        }),
        el(
          'button',
          {
            class: 'btn btn--sm',
            type: 'button',
            'aria-label': 'Rotera',
            on: {
              click: () => {
                haptic('selection');
                state.rotation = ((state.rotation + 90) % 360) as 0 | 90 | 180 | 270;
                void reprocess();
              },
            },
          },
          icon('rotate', { size: 18 }),
          el('span', { text: 'Rotera' }),
        ),
        el('button', {
          class: 'btn btn--sm',
          type: 'button',
          text: 'Ta om',
          on: {
            click: () => {
              releaseUrls();
              state.source = null;
              state.result = null;
              state.stage = 'idle';
              render();
            },
          },
        }),
      ),
      el(
        'p',
        { class: 'faint' },
        `${result.width}×${result.height} px · ${formatBytes(result.blob.size)} · ` +
          `${describeDetection(result)} · ${result.durationMs} ms`,
      ),
      el(
        'div',
        { class: 'stack' },
        el('button', {
          class: 'btn grow',
          type: 'button',
          text: 'Spara utan tolkning',
          on: { click: () => void save(false) },
        }),
        el('button', {
          class: 'btn btn--primary grow',
          type: 'button',
          text: isAiConfigured() ? 'Spara och tolka' : 'Spara',
          on: {
            click: () => {
              haptic('impact');
              void save(isAiConfigured());
            },
          },
        }),
      ),
    );
  }

  function buildProcessedPreview(result: PipelineResult): HTMLElement {
    return el('img', {
      class: 'preview-image',
      src: state.resultUrl ?? '',
      alt: 'Behandlat kvitto',
      width: result.width,
      height: result.height,
    });
  }

  function buildCropEditor(): HTMLElement {
    const editor = createCropEditor({
      imageUrl: state.sourceUrl ?? '',
      naturalWidth: state.sourceWidth,
      naturalHeight: state.sourceHeight,
      corners: state.corners,
      onChange: (corners) => {
        state.corners = corners;
      },
    });
    cropEditor = editor;

    return el(
      'div',
      {},
      editor.element,
      el(
        'div',
        { class: 'stack', style: 'margin-top:10px' },
        el('button', {
          class: 'btn btn--sm',
          type: 'button',
          text: 'Hela bilden',
          on: { click: () => editor.reset() },
        }),
        el('button', {
          class: 'btn btn--primary btn--sm grow',
          type: 'button',
          text: 'Använd dessa hörn',
          on: {
            click: () => {
              state.showOriginal = false;
              void reprocess();
            },
          },
        }),
      ),
    );
  }

  render();
  return root;
}

function describeDetection(result: PipelineResult): string {
  const engine = result.engine === 'opencv' ? 'OpenCV' : 'canvas';
  switch (result.detection) {
    case 'paper':
      return `${engine}, kvitto hittat`;
    case 'contour':
      return `${engine}, kanter hittade`;
    case 'threshold':
      return `${engine}, kanter via tröskling`;
    case 'manual':
      return `${engine}, egna hörn`;
    default:
      return `${engine}, hela bilden`;
  }
}

/**
 * Builds a small thumbnail for the list view.
 *
 * Worth the extra blob: the list would otherwise decode several full-size
 * scans at once, which is what makes a receipt archive feel slow on a phone.
 */
async function makeThumbnail(source: Blob, size = 200): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.72),
    );
    if (!blob) return null;
    return putBlob(blob, { role: 'thumb', width, height });
  } catch (error) {
    // A missing thumbnail is cosmetic; never let it block saving a receipt.
    console.warn('Could not build a thumbnail', error);
    return null;
  }
}
