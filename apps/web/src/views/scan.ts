/**
 * The scan screen: capture → review → parse, or upload → import.
 *
 * The state machine — camera lifecycle, the CV pipeline, saving — lives in
 * `scan/session.ts`; this file only renders whatever stage the session is in
 * and calls back into it.
 *
 * Capture is one screen, not two. The camera comes up with the screen and the
 * viewfinder is the same box before and after the picture arrives in it, so the
 * shutter is where the eye left it and the first press takes a photograph. The
 * `<video>` outlives each render for the same reason: rebuilding it would
 * reattach the stream and blink the preview every time anything else on the
 * screen changed.
 *
 * Picking existing photos is a separate path with no `capture` attribute, for
 * the reason spelled out in `scan/session.ts`'s `openFilePicker` — and a
 * different flow entirely: several images at once, each its own receipt,
 * cropped without asking. See `scan/import.ts` for why that one skips the
 * review screen.
 */

import { formatBytes } from '@kvitto/shared';

import { createCropEditor, type CropEditor } from '../components/crop-editor.js';
import { banner, loadingState } from '../components/ui.js';
import { el, replaceChildren } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { haptic } from '../core/platform.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import type { PipelineResult } from '../cv/types.js';
import { shouldParse } from '../scan/import.js';
import { createScanSession, type CameraState } from '../scan/session.js';

/** What the viewfinder says it is doing, for each thing it can be doing. */
const HINTS: Record<CameraState, string> = {
  starting: 'Startar kameran…',
  live: 'Håll kvar — beskär automatiskt',
  stopped: 'Tryck för att starta kameran',
  unavailable: 'Ingen kamera — tryck för att välja en bild',
};

const SHUTTER_LABELS: Record<CameraState, string> = {
  starting: 'Startar kameran',
  live: 'Ta bild',
  stopped: 'Starta kameran',
  unavailable: 'Välj bild',
};

export function scanView(): HTMLElement {
  const root = el('div', { class: 'scan' });
  let cropEditor: CropEditor | null = null;

  // Built once and re-used by every capture render: moving the same element
  // keeps the stream attached and the picture playing.
  const video = el('video', {
    class: 'scan-viewfinder__video',
    autoplay: true,
    playsInline: true,
    muted: true,
  });

  const session = createScanSession(render);
  router.onTeardown(() => cropEditor?.destroy());

  // Asked for here rather than inside the session, which would call back into
  // this view through `render` before `session` itself exists.
  void session.startCamera();

  function render(): void {
    cropEditor?.destroy();
    cropEditor = null;

    switch (session.state.stage) {
      case 'capture':
        replaceChildren(root, renderCapture());
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

  // --- capture --------------------------------------------------------------

  /**
   * The shutter does whatever the camera makes possible.
   *
   * Live, it takes the picture — which is the whole point of starting the
   * camera with the screen. Refused or unsupported, it hands over to the native
   * picker, so the button is never the one thing on the screen that does
   * nothing.
   */
  function onShutter(): void {
    switch (session.state.camera) {
      case 'live':
        void session.captureFrame(video);
        break;
      case 'stopped':
        void session.startCamera();
        break;
      case 'unavailable':
        session.openFilePicker('camera');
        break;
      case 'starting':
        break;
    }
  }

  function renderCapture(): HTMLElement {
    const camera = session.state.camera;
    const live = camera === 'live';

    // Assigned rather than re-created, and cleared when there is nothing to
    // show, so the placeholder is never a still of the last frame.
    if (video.srcObject !== session.stream) video.srcObject = session.stream;
    if (live) void video.play().catch(() => undefined);

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
        { class: ['scan-viewfinder', live ? 'scan-viewfinder--live' : ''] },
        video,
        el('div', { class: 'scan-viewfinder__paper' }),
        el('span', { class: 'scan-viewfinder__hint', text: HINTS[camera] }),
      ),
      el(
        'button',
        {
          class: 'scan-shutter',
          type: 'button',
          'aria-label': SHUTTER_LABELS[camera],
          // Only while the camera is coming up, which is the one moment there
          // is nothing for it to do.
          disabled: camera === 'starting',
          on: {
            click: () => {
              haptic('impact');
              onShutter();
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
          on: { click: () => session.openFilePicker('library') },
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
          title: 'Blixt stöds inte av den här kameravyn ännu',
          'aria-disabled': 'true',
          on: { click: () => toast('Blixt stöds inte av den här kameravyn ännu.', { kind: 'info' }) },
        }),
      ),
      el('p', {
        class: 'scan-capture__offline',
        text: 'Fungerar offline. Bilden stannar på telefonen. Flera bilder från galleriet blir ett kvitto var.',
      }),
    );
  }

  // --- processing / importing ------------------------------------------------

  function renderProcessing(): HTMLElement {
    return loadingState({
      title: 'Behandlar bilden…',
      body: 'Hittar kvittots kanter, rätar ut och förbättrar kontrasten.',
    });
  }

  function renderImporting(): HTMLElement {
    const progress = session.state.importing;
    const total = progress?.total ?? 0;
    const index = Math.min(progress?.index ?? 1, total);
    const done = total > 0 && (progress?.imported ?? 0) >= total;

    return loadingState(
      {
        className: 'scan-import',
        title: total === 1 ? 'Lägger till kvittot…' : `Lägger till kvitto ${index} av ${total}`,
        body: done
          ? 'Klart. Öppnar kvittolistan…'
          : 'Hittar kvittots kanter, rätar ut och sparar. Ingen granskning behövs.',
      },
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

  // --- review -----------------------------------------------------------------

  function renderReview(): HTMLElement {
    const result = session.state.result;
    if (!result) return renderCapture();

    const lowConfidence = result.detectionConfidence < 0.45;
    const preview = session.state.showOriginal ? buildCropEditor() : buildProcessedPreview(result);

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
          el('strong', { text: session.state.showOriginal ? 'Justera kvittots hörn' : 'Bilden är beskuren' }),
          el('span', {
            text: `${result.width}×${result.height} · ${formatBytes(result.blob.size)} · ${result.durationMs} ms`,
          }),
          el('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: session.state.showOriginal ? 'Visa resultat' : 'Justera hörn',
            on: { click: () => session.setShowOriginal(!session.state.showOriginal) },
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
          on: { click: () => session.retake() },
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
                void session.rotate();
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
          on: { click: () => void session.save(false) },
        }),
        el('button', {
          class: 'btn btn--primary grow',
          type: 'button',
          text: 'Spara kvitto',
          on: {
            click: () => {
              haptic('impact');
              void session.save(shouldParse());
            },
          },
        }),
      ),
    );
  }

  function buildProcessedPreview(result: PipelineResult): HTMLElement {
    return el('img', {
      class: 'preview-image',
      src: session.state.resultUrl ?? '',
      alt: 'Behandlat kvitto',
      width: result.width,
      height: result.height,
    });
  }

  function buildCropEditor(): HTMLElement {
    const editor = createCropEditor({
      imageUrl: session.state.sourceUrl ?? '',
      naturalWidth: session.state.sourceWidth,
      naturalHeight: session.state.sourceHeight,
      corners: session.state.corners,
      onChange: (corners) => session.setCorners(corners),
    });
    cropEditor = editor;

    return el(
      'div',
      {},
      editor.element,
      el(
        'div',
        { class: ['stack', 'stack--top-gap'] },
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
              session.setShowOriginal(false);
              void session.reprocess();
            },
          },
        }),
      ),
    );
  }

  render();
  return root;
}
