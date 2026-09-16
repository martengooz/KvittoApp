import QrScanner from 'qr-scanner';

import { describeError, type PairingQrPayload } from '@kvitto/shared';

import { actionRow, listGroup } from '../components/ui.js';
import { appendClientDebug } from '../core/debug-log.js';
import { el, nextFrame } from '../core/dom.js';
import { router } from '../core/router.js';
import { updateSettings } from '../core/settings.js';
import { toast } from '../core/toast.js';
import { SyncError } from '../sync/client.js';
import { resetSyncBackoff } from '../sync/engine.js';
import { pairAndSync } from '../sync/pairing.js';

const MAX_PAIR_ATTEMPTS = 3;

export async function pairScanView(): Promise<HTMLElement> {
  const video = el('video', { autoplay: true, playsInline: true, muted: true });
  const status = el('p', { class: 'pair-scan__status', role: 'status', text: 'Startar kameran…' });
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
  });
  const cameraInput = el('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    class: 'visually-hidden',
  });
  let completed = false;
  let disposed = false;
  let pairAttempts = 0;
  let scanner: QrScanner | null = null;

  router.onTeardown(() => {
    disposed = true;
    scanner?.destroy();
  });

  function handleImage(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    status.textContent = 'Läser QR-koden…';
    void decodePairingQr(file)
      .then((payload) => complete(JSON.stringify(payload)))
      .catch(() => {
        status.textContent = 'Ingen QR-kod hittades i bilden.';
      });
  }

  fileInput.addEventListener('change', () => handleImage(fileInput));
  cameraInput.addEventListener('change', () => handleImage(cameraInput));

  async function complete(raw: string): Promise<void> {
    if (completed) return;
    let payload: PairingQrPayload;
    try {
      payload = parsePairingPayload(raw);
    } catch (error) {
      status.textContent = describeError(error);
      return;
    }

    completed = true;
    scanner?.stop();
    pairAttempts += 1;
    status.textContent = 'Parkopplar…';
    try {
      await updateSettings({ sync: { serverUrl: payload.serverUrl } });
      resetSyncBackoff();
      await pairAndSync(payload.serverUrl, payload.code);
      appendClientDebug('info', 'Device paired from QR code');
      router.navigate('/settings', { replace: true });
    } catch (error) {
      const canRetry = error instanceof SyncError && error.retryable && pairAttempts < MAX_PAIR_ATTEMPTS;
      appendClientDebug('warn', 'QR pairing failed', {
        attempt: pairAttempts,
        retryable: error instanceof SyncError && error.retryable,
        stopped: !canRetry,
      });
      if (!canRetry) {
        status.textContent = describeError(error);
        toast(
          pairAttempts >= MAX_PAIR_ATTEMPTS
            ? 'Parkopplingen stoppades efter tre misslyckade försök.'
            : 'Parkopplingen misslyckades.',
          { kind: 'error' },
        );
        return;
      }

      completed = false;
      status.textContent = `Kunde inte nå servern. Försök ${pairAttempts} av ${MAX_PAIR_ATTEMPTS}.`;
      await scanner?.start().catch(() => undefined);
    }
  }

  const root = el(
    'div',
    { class: 'pair-scan' },
    el(
      'div',
      { class: 'pair-scan__camera' },
      video,
      el('div', { class: 'pair-scan__frame', 'aria-hidden': 'true' }),
    ),
    status,
    listGroup(
      {},
      actionRow({ label: 'Ta bild av QR-kod', onClick: () => cameraInput.click() }),
      actionRow({ label: 'Välj QR-bild', onClick: () => fileInput.click() }),
    ),
    cameraInput,
    fileInput,
  );

  requestAnimationFrame(() => void startScanner());

  return root;

  async function startScanner(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      status.textContent = window.isSecureContext
        ? 'Livekameran stöds inte. Ta en bild av QR-koden istället.'
        : 'Livekameran kräver HTTPS. Ta en bild av QR-koden istället.';
      return;
    }

    try {
      await nextFrame();
      if (disposed || !root.isConnected) return;
      scanner = new QrScanner(video, (result) => void complete(result.data), {
        preferredCamera: 'environment',
        maxScansPerSecond: 8,
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
      });
      await scanner.start();
      await waitForCameraFrame(video);
      if (!disposed) status.textContent = 'Rikta kameran mot QR-koden.';
    } catch (error) {
      if (disposed) return;
      scanner?.stop();
      appendClientDebug('warn', 'Pairing camera unavailable', {
        message: describeError(error),
      });
      status.textContent = 'Kameran är inte tillgänglig. Ta en bild av QR-koden istället.';
    }
  }
}

async function waitForCameraFrame(video: HTMLVideoElement): Promise<void> {
  const stream = video.srcObject instanceof MediaStream ? video.srcObject : null;
  if (!stream?.getVideoTracks().some((track) => track.readyState === 'live')) {
    throw new Error('Kameran startade utan bildström.');
  }
  if (video.videoWidth > 0 && video.videoHeight > 0) return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Kameran gav ingen bild.'));
    }, 3000);
    const onLoaded = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadeddata', onLoaded);
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
  });
}

export async function decodePairingQr(image: File | Blob | URL | string): Promise<PairingQrPayload> {
  const result = await QrScanner.scanImage(image, { returnDetailedScanResult: true });
  return parsePairingPayload(result.data);
}

export function parsePairingPayload(raw: string): PairingQrPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('QR-koden är inte en parkopplingskod för KvittoApp.');
  }
  if (!value || typeof value !== 'object') throw new Error('QR-koden är ogiltig.');
  const payload = value as Partial<PairingQrPayload>;
  if (
    payload.type !== 'kvitto-pair' ||
    payload.version !== 1 ||
    typeof payload.serverUrl !== 'string' ||
    typeof payload.code !== 'string'
  ) {
    throw new Error('QR-koden är ogiltig eller har fel version.');
  }
  const serverUrl = new URL(payload.serverUrl);
  if (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') {
    throw new Error('QR-koden innehåller en ogiltig serveradress.');
  }
  if (!/^(?:[A-Z0-9]{3}-){2}[A-Z0-9]{3}$/.test(payload.code)) {
    throw new Error('QR-koden innehåller en ogiltig parkopplingskod.');
  }
  return {
    type: 'kvitto-pair',
    version: 1,
    serverUrl: serverUrl.href.replace(/\/$/, ''),
    code: payload.code,
  };
}