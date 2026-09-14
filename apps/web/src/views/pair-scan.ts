import QrScanner from 'qr-scanner';

import type { PairingQrPayload } from '@kvitto/shared';

import { listGroup } from '../components/ui.js';
import { appendClientDebug } from '../core/debug-log.js';
import { el } from '../core/dom.js';
import { router } from '../core/router.js';
import { updateSettings } from '../core/settings.js';
import { toast } from '../core/toast.js';
import { pairDevice } from '../sync/client.js';
import { resetSyncBackoff, sync } from '../sync/engine.js';
import { setDeviceToken } from '../sync/identity.js';

export async function pairScanView(): Promise<HTMLElement> {
  const video = el('video', { autoplay: true, playsInline: true, muted: true });
  const status = el('p', { class: 'pair-scan__status', role: 'status', text: 'Startar kameran…' });
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/*',
    class: 'visually-hidden',
  });
  let completed = false;

  const scanner = new QrScanner(video, (result) => void complete(result.data), {
    preferredCamera: 'environment',
    maxScansPerSecond: 8,
    highlightScanRegion: true,
    highlightCodeOutline: true,
    returnDetailedScanResult: true,
  });

  router.onTeardown(() => scanner.destroy());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void decodePairingQr(file)
      .then((payload) => complete(JSON.stringify(payload)))
      .catch(() => {
        status.textContent = 'Ingen QR-kod hittades i bilden.';
      });
  });

  async function complete(raw: string): Promise<void> {
    if (completed) return;
    let payload: PairingQrPayload;
    try {
      payload = parsePairingPayload(raw);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      return;
    }

    completed = true;
    scanner.stop();
    status.textContent = 'Parkopplar…';
    try {
      await updateSettings({ sync: { serverUrl: payload.serverUrl } });
      resetSyncBackoff();
      const result = await pairDevice(payload.serverUrl, payload.code);
      await setDeviceToken(result.token, result.accountId);
      appendClientDebug('info', 'Device paired from QR code');
      toast('Enheten är parkopplad.', { kind: 'success' });
      void sync();
      router.navigate('/settings', { replace: true });
    } catch (error) {
      completed = false;
      status.textContent = error instanceof Error ? error.message : String(error);
      await scanner.start().catch(() => undefined);
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
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center;font-weight:600',
        text: 'Välj QR-bild',
        on: { click: () => fileInput.click() },
      }),
    ),
    fileInput,
  );

  void scanner.start().then(
    () => {
      status.textContent = 'Rikta kameran mot QR-koden.';
    },
    () => {
      status.textContent = 'Kameran är inte tillgänglig. Välj en QR-bild istället.';
    },
  );

  return root;
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