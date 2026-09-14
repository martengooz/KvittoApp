/**
 * The scan screen: capture → review → parse.
 *
 * Camera access is attempted through `getUserMedia`, which gives a live preview
 * and a proper shutter. When that is unavailable — an insecure context, a
 * denied permission, or a browser without the API — it silently falls back to a
 * file input with `capture="environment"`, which opens the native camera app on
 * every mobile browser. The scan button therefore always does something.
 *
 * Picking an existing photo is a separate path with no `capture` attribute, for
 * the reason spelled out at {@link openFilePicker}.
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
import { enrichFromImage } from '../ocr/enrich.js';
import { ocrClient } from '../ocr/client.js';

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
    if (disposed) return;
    if (state.stage === 'idle') render();
    // The OCR runtime is a separate download. Start it only once OpenCV is in:
    // the two compete for the same connection, and a scan cannot begin without
    // OpenCV whereas it merely finishes later without Tesseract.
    void ocrClient.warmup();
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
      openFilePicker('camera');
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
      openFilePicker('camera');
    }
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
      ...(source === 'camera' ? { capture: 'environment' } : {}),
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
    return el(
      'section',
      { class: 'scan-capture' },
      el(
        'header',
        { class: 'scan-capture__header' },
        el('h2', { text: 'Skanna kvitto' }),
        el('button', {
          type: 'button',
          text: 'Avbryt',
          on: { click: () => router.navigate('/receipts') },
        }),
      ),
      el(
        'div',
        { class: 'scan-viewfinder' },
        el('div', { class: 'scan-viewfinder__paper' }),
        el('span', { class: 'scan-viewfinder__hint', text: 'Håll kvar — beskär automatiskt' }),
      ),
      el(
        'button',
        {
          class: 'scan-shutter',
          type: 'button',
          'aria-label': 'Öppna kameran',
          on: {
            click: () => {
              haptic('impact');
              void startCamera();
            },
          },
        },
        icon('camera', { size: 30, weight: 2 }),
      ),
      el(
        'div',
        { class: 'scan-capture__tools' },
        el('button', {
          type: 'button',
          text: 'Galleri',
          on: { click: () => openFilePicker('library') },
        }),
        el('button', {
          type: 'button',
          text: 'Flera sidor',
          title: 'Flersidiga kvitton stöds inte ännu',
          'aria-disabled': 'true',
          on: { click: () => toast('Flersidiga kvitton stöds inte ännu.', { kind: 'info' }) },
        }),
        el('button', {
          type: 'button',
          text: 'Blixt',
          title: 'Blixt kan väljas när kameran är öppen',
          'aria-disabled': 'true',
          on: { click: () => toast('Blixt kan väljas när kameran är öppen.', { kind: 'info' }) },
        }),
      ),
      el('p', { class: 'scan-capture__offline', text: 'Fungerar offline. Bilden stannar på telefonen.' }),
    );
  }

  function renderCamera(): HTMLElement {
    const video = el('video', { autoplay: true, playsInline: true, muted: true });
    if (stream) video.srcObject = stream;

    return el(
      'section',
      { class: 'scan-capture scan-capture--live' },
      el(
        'header',
        { class: 'scan-capture__header' },
        el('h2', { text: 'Skanna kvitto' }),
        el('button', {
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
      ),
      el(
        'div',
        { class: 'camera-stage' },
        video,
        el('div', { class: 'camera-frame' }),
        el('p', { class: 'camera-hint', text: 'Håll kvar — beskär automatiskt' }),
      ),
      el(
        'button',
        {
          class: 'scan-shutter',
          type: 'button',
          'aria-label': 'Ta bild',
          on: {
            click: () => {
              haptic('impact');
              void captureFrame(video);
            },
          },
        },
        icon('camera', { size: 30, weight: 2 }),
      ),
      el(
        'div',
        { class: 'scan-capture__tools' },
        el('button', {
          type: 'button',
          text: 'Galleri',
          on: {
            click: () => {
              stopCamera();
              openFilePicker('library');
            },
          },
        }),
        el('button', {
          type: 'button',
          text: 'Flera sidor',
          'aria-disabled': 'true',
          on: { click: () => toast('Flersidiga kvitton stöds inte ännu.', { kind: 'info' }) },
        }),
        el('button', {
          type: 'button',
          text: 'Blixt',
          'aria-disabled': 'true',
          on: { click: () => toast('Blixt stöds inte av den här kameravyn ännu.', { kind: 'info' }) },
        }),
      ),
      el('p', { class: 'scan-capture__offline', text: 'Fungerar offline. Bilden stannar på telefonen.' }),
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
      'section',
      { class: 'crop scan-review' },
      el(
        'header',
        { class: 'scan-review__header' },
        el('h2', { text: 'Ser det rätt ut?' }),
        el('p', { text: 'Kontrollera beskärningen innan kvittot sparas.' }),
      ),
      lowConfidence
        ? banner({
            tone: 'warning',
            title: 'Osäker på kvittots kanter',
            body: 'Tryck på "Justera hörn" och dra dem på plats om beskärningen blev fel.',
          })
        : null,
      ...result.notes.map((note) => banner({ tone: 'info', body: note })),
      el(
        'div',
        { class: 'scan-review__image-card' },
        el('div', { class: 'scan-review__preview' }, preview),
        el(
          'div',
          { class: 'scan-review__image-copy' },
          el('strong', { text: state.showOriginal ? 'Justera kvittots hörn' : 'Bilden är beskuren' }),
          el('span', {
            text: `${result.width}×${result.height} · ${formatBytes(result.blob.size)} · ${result.durationMs} ms`,
          }),
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
        ),
      ),
      el(
        'div',
        { class: 'scan-review__utilities' },
        el('button', {
          class: 'btn btn--plain btn--sm',
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
      ),
      el(
        'div',
        { class: 'scan-review__actions' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Senare',
          on: { click: () => void save(false) },
        }),
        el('button', {
          class: 'btn btn--primary grow',
          type: 'button',
          text: 'Spara kvitto',
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
