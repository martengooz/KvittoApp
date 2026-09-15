/**
 * The scan screen: capture → review → parse, or upload → import.
 *
 * The state machine — camera lifecycle, the CV pipeline, saving — lives in
 * `scan/session.ts`; this file only renders whatever stage the session is in
 * and calls back into it. `renderIdle` and `renderCamera` share almost all
 * their markup, so `renderCaptureChrome` builds it once and each supplies the
 * handful of bits that differ (the viewfinder itself, the shutter's action,
 * the tool row's wording).
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
import { el, replaceChildren, type Child } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { haptic } from '../core/platform.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import type { PipelineResult } from '../cv/types.js';
import { shouldParse } from '../scan/import.js';
import { createScanSession } from '../scan/session.js';

export function scanView(): HTMLElement {
  const root = el('div', { class: 'scan' });
  let cropEditor: CropEditor | null = null;

  const session = createScanSession(render);
  router.onTeardown(() => cropEditor?.destroy());

  function render(): void {
    cropEditor?.destroy();
    cropEditor = null;

    switch (session.state.stage) {
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

  // --- idle / camera --------------------------------------------------------

  /**
   * The chrome `renderIdle` and `renderCamera` share: header with a cancel
   * button, the viewfinder area (theirs alone — a static frame vs. a live
   * `<video>`), the shutter, and the Galleri/Flera sidor/Blixt tool row.
   */
  function renderCaptureChrome(options: {
    live: boolean;
    onCancel: () => void;
    viewport: Child;
    shutter: { ariaLabel: string; onClick: () => void };
    gallery: { onClick: () => void };
    multiPage: { title?: string; message: string };
    flash: { title?: string; message: string };
    offlineNote: string;
  }): HTMLElement {
    return el(
      'section',
      { class: ['scan-capture', options.live ? 'scan-capture--live' : ''] },
      el(
        'header',
        { class: 'scan-capture__header' },
        el('h2', { text: 'Skanna kvitto' }),
        el('button', { type: 'button', text: 'Avbryt', on: { click: options.onCancel } }),
      ),
      options.viewport,
      el(
        'button',
        {
          class: 'scan-shutter',
          type: 'button',
          'aria-label': options.shutter.ariaLabel,
          on: {
            click: () => {
              haptic('impact');
              options.shutter.onClick();
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
          on: { click: options.gallery.onClick },
        }),
        el('button', {
          type: 'button',
          text: 'Flera sidor',
          title: options.multiPage.title,
          'aria-disabled': 'true',
          on: { click: () => toast(options.multiPage.message, { kind: 'info' }) },
        }),
        el('button', {
          type: 'button',
          text: 'Blixt',
          title: options.flash.title,
          'aria-disabled': 'true',
          on: { click: () => toast(options.flash.message, { kind: 'info' }) },
        }),
      ),
      el('p', { class: 'scan-capture__offline', text: options.offlineNote }),
    );
  }

  function renderIdle(): HTMLElement {
    return renderCaptureChrome({
      live: false,
      onCancel: () => router.navigate('/receipts'),
      viewport: el(
        'div',
        { class: 'scan-viewfinder' },
        el('div', { class: 'scan-viewfinder__paper' }),
        el('span', { class: 'scan-viewfinder__hint', text: 'Håll kvar — beskär automatiskt' }),
      ),
      shutter: { ariaLabel: 'Öppna kameran', onClick: () => void session.startCamera() },
      gallery: { onClick: () => session.openFilePicker('library') },
      multiPage: {
        title: 'Flersidiga kvitton stöds inte ännu',
        message: 'Flersidiga kvitton stöds inte ännu.',
      },
      flash: {
        title: 'Blixt kan väljas när kameran är öppen',
        message: 'Blixt kan väljas när kameran är öppen.',
      },
      offlineNote:
        'Fungerar offline. Bilden stannar på telefonen. Flera bilder från galleriet blir ett kvitto var.',
    });
  }

  function renderCamera(): HTMLElement {
    const video = el('video', { autoplay: true, playsInline: true, muted: true });
    if (session.stream) video.srcObject = session.stream;

    return renderCaptureChrome({
      live: true,
      onCancel: () => session.cancelCamera(),
      viewport: el(
        'div',
        { class: 'camera-stage' },
        video,
        el('div', { class: 'camera-frame' }),
        el('p', { class: 'camera-hint', text: 'Håll kvar — beskär automatiskt' }),
      ),
      shutter: { ariaLabel: 'Ta bild', onClick: () => void session.captureFrame(video) },
      gallery: {
        onClick: () => {
          session.stopCamera();
          session.openFilePicker('library');
        },
      },
      multiPage: { message: 'Flersidiga kvitton stöds inte ännu.' },
      flash: { message: 'Blixt stöds inte av den här kameravyn ännu.' },
      offlineNote: 'Fungerar offline. Bilden stannar på telefonen.',
    });
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
    if (!result) return renderIdle();

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
