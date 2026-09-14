/**
 * The scan screen: capture → review → parse, or upload → import.
 *
 * Camera access is attempted through `getUserMedia`, which gives a live preview
 * and a proper shutter. When that is unavailable — an insecure context, a
 * denied permission, or a browser without the API — it silently falls back to a
 * file input with `capture="environment"`, which opens the native camera app on
 * every mobile browser. The scan button therefore always does something.
 *
 * Picking existing photos is a separate path with no `capture` attribute, for
 * the reason spelled out at {@link openFilePicker} — and a different flow
 * entirely: several images at once, each its own receipt, cropped without
 * asking. See `scan/import.ts` for why that one skips the review screen.
 */

import { formatBytes } from '@kvitto/shared';

import { createCropEditor, type CropEditor } from '../components/crop-editor.js';
import { banner, emptyState } from '../components/ui.js';
import { el, nextFrame, replaceChildren } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { haptic } from '../core/platform.js';
import { router } from '../core/router.js';
import { getSettings } from '../core/settings.js';
import { toast } from '../core/toast.js';
import { cvClient, decodeImage } from '../cv/client.js';
import type { PipelineResult, Quad } from '../cv/types.js';
import { parseReceipt } from '../ai/index.js';
import { putBlob } from '../db/blobs.js';
import { createReceipt } from '../db/repo.js';
import { enrichFromImage } from '../ocr/enrich.js';
import { ocrClient } from '../ocr/client.js';
import { importImages, makeThumbnail, shouldParse, type ImportProgress } from '../scan/import.js';

type Stage = 'idle' | 'camera' | 'processing' | 'review' | 'importing';

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
  /** Progress of an unattended upload, while one is running. */
  importing: ImportProgress | null;
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
    importing: null,
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

  // --- unattended import --------------------------------------------------

  /**
   * Files a batch of photographs without asking anything.
   *
   * The import itself lives in `scan/import.ts` and outlives this screen: the
   * user is sent to the list as soon as the images are saved, and the reading
   * and the extraction carry on from there.
   */
  async function runImport(files: File[]): Promise<void> {
    state.stage = 'importing';
    state.importing = { total: files.length, index: 1, name: files[0]?.name ?? '', imported: 0 };
    render();
    await nextFrame();

    const outcome = await importImages(files, {
      source: 'upload',
      onProgress: (progress) => {
        if (disposed) return;
        state.importing = progress;
        render();
      },
    });

    const saved = outcome.receiptIds.length;
    if (saved === 0) {
      const first = outcome.failures[0];
      toast(first ? `Bilden kunde inte läsas: ${first.message}` : 'Inga kvitton kunde sparas.', {
        kind: 'error',
      });
      if (!disposed) {
        state.stage = 'idle';
        state.importing = null;
        render();
      }
      return;
    }

    // Reported rather than acted on: an uncertain crop kept the whole frame, so
    // the receipt is complete and readable — it just looks untidier than usual,
    // and the user may want to rescan it.
    const notes = [
      saved === 1 ? 'Ett kvitto tillagt' : `${saved} kvitton tillagda`,
      outcome.parsing ? 'tolkas nu med AI' : null,
    ].filter(Boolean);
    toast(`${notes.join(' — ')}.`, { kind: 'success' });

    if (outcome.failures.length > 0) {
      toast(
        outcome.failures.length === 1
          ? `${outcome.failures[0]?.name} kunde inte läsas.`
          : `${outcome.failures.length} bilder kunde inte läsas.`,
        { kind: 'error' },
      );
    }
    if (outcome.uncropped > 0) {
      toast(
        outcome.uncropped === 1
          ? 'Ett kvitto sparades obeskuret — kanterna gick inte att hitta.'
          : `${outcome.uncropped} kvitton sparades obeskurna — kanterna gick inte att hitta.`,
        { kind: 'info' },
      );
    }

    // Only when the user is still watching this screen. The import outlives it
    // on purpose, and a batch finishing while they are reading their settings
    // must not drag them somewhere they did not ask to go — the toast above is
    // the whole notification in that case.
    if (!disposed) router.navigate('/receipts');
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
      case 'importing':
        replaceChildren(root, renderImporting());
        break;
    }
  }

  function renderImporting(): HTMLElement {
    const progress = state.importing;
    const total = progress?.total ?? 0;
    const index = Math.min(progress?.index ?? 1, total);
    const done = total > 0 && (progress?.imported ?? 0) >= total;

    return el(
      'div',
      { class: 'empty-state scan-import' },
      el('div', { class: 'spinner', style: 'width:28px;height:28px' }),
      el('p', {
        class: 'empty-state__title',
        text: total === 1 ? 'Lägger till kvittot…' : `Lägger till kvitto ${index} av ${total}`,
      }),
      el('p', {
        text: done
          ? 'Klart. Öppnar kvittolistan…'
          : 'Hittar kvittots kanter, rätar ut och sparar. Ingen granskning behövs.',
      }),
      progress?.name ? el('p', { class: 'faint truncate', text: progress.name }) : null,
      el(
        'div',
        { class: 'scan-import__bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': total },
        el('span', {
          class: 'scan-import__fill',
          style: `width:${total > 0 ? Math.round(((progress?.imported ?? 0) / total) * 100) : 0}%`,
        }),
      ),
      shouldParse()
        ? el('p', { class: 'faint', text: 'AI-tolkningen startar allt eftersom.' })
        : null,
    );
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
          title: 'Välj en eller flera bilder — varje bild blir ett kvitto',
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
      el('p', {
        class: 'scan-capture__offline',
        text: 'Fungerar offline. Bilden stannar på telefonen. Flera bilder från galleriet blir ett kvitto var.',
      }),
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
          title: 'Välj en eller flera bilder — varje bild blir ett kvitto',
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
              void save(shouldParse());
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
