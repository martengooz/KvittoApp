import { appendClientDebug } from './debug-log.js';
import { toast } from './toast.js';

type UpdateServiceWorker = (reloadPage?: boolean) => Promise<void>;

let updateServiceWorker: UpdateServiceWorker | null = null;
let registration: ServiceWorkerRegistration | null = null;

export async function registerAppServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    const { registerSW } = await import('virtual:pwa-register');
    updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh() {
        appendClientDebug('info', 'Application update available');
        toast('En ny version finns.', {
          durationMs: 30_000,
          action: { label: 'Uppdatera', onClick: () => void activateUpdateSafely() },
        });
      },
      onOfflineReady() {
        toast('Appen fungerar nu offline.', { kind: 'success' });
      },
      onRegisteredSW(_url, currentRegistration) {
        registration = currentRegistration ?? null;
      },
      onRegisterError(error) {
        appendClientDebug('error', 'Service worker registration failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
  } catch (error) {
    appendClientDebug('error', 'Service worker registration failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export type UpdateCheckResult = 'unsupported' | 'current' | 'updating';

export async function checkForAppUpdate(): Promise<UpdateCheckResult> {
  if (!('serviceWorker' in navigator)) return 'unsupported';

  registration ??= await navigator.serviceWorker.getRegistration() ?? null;
  if (!registration) return 'unsupported';

  appendClientDebug('info', 'Checking for application update');
  await registration.update();
  if (registration.waiting) {
    await activateUpdate();
    return 'updating';
  }
  if (registration.installing) return 'updating';

  appendClientDebug('info', 'Application is current');
  return 'current';
}

async function activateUpdateSafely(): Promise<void> {
  try {
    await activateUpdate();
  } catch (error) {
    appendClientDebug('error', 'Application update activation failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    toast('Uppdateringen misslyckades.', { kind: 'error' });
  }
}

async function activateUpdate(): Promise<void> {
  appendClientDebug('info', 'Activating application update');
  if (updateServiceWorker) {
    await updateServiceWorker(true);
    return;
  }

  const currentRegistration = registration ?? await navigator.serviceWorker.getRegistration();
  if (!currentRegistration?.waiting) {
    location.reload();
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  currentRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
}