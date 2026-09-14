/**
 * Boot sequence.
 *
 * Order matters: the database and settings have to be ready before any view
 * renders, but service-worker registration and sync are deliberately deferred
 * so a slow network cannot delay first paint.
 */

import './styles/app.css';

import { mountApp } from './app.js';
import { installClientDebugLogging } from './core/debug-log.js';
import { bus } from './core/events.js';
import { loadSettings } from './core/settings.js';
import { toast } from './core/toast.js';
import { db, requestPersistentStorage } from './db/db.js';
import { seedDefaultCategoriesOnce } from './db/repo.js';
import { startAutoSync } from './sync/engine.js';

installClientDebugLogging();

async function boot(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('Missing #app container.');

  try {
    await db.open();
  } catch (error) {
    renderFatal(container, error);
    return;
  }

  await loadSettings();
  await seedDefaultCategoriesOnce();

  mountApp(container);

  // Everything below this point is best-effort and must never block the UI.
  void registerServiceWorker();
  void requestPersistentStorage();
  startAutoSync();

  watchOtherTabs();
}

/**
 * Mirrors data changes between open tabs.
 *
 * Dexie only notifies listeners in the tab that made the write, so without this
 * a second tab (or the same app open on a desktop alongside a phone-sized
 * window) shows a stale list until it is reloaded.
 */
function watchOtherTabs(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('kvitto-data');

  bus.on('data:changed', (payload) => {
    // `echo` marks a message this tab re-broadcast, so tabs cannot ping-pong.
    if (payload.echo) return;
    channel.postMessage({ kinds: payload.kinds });
  });

  channel.addEventListener('message', (event: MessageEvent<{ kinds: string[] }>) => {
    bus.emit('data:changed', { kinds: event.data?.kinds ?? [], echo: true });
  });
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const { registerSW } = await import('virtual:pwa-register');
    registerSW({
      immediate: true,
      onNeedRefresh() {
        toast('En ny version finns.', {
          durationMs: 15_000,
          action: { label: 'Ladda om', onClick: () => location.reload() },
        });
      },
      onOfflineReady() {
        toast('Appen fungerar nu offline.', { kind: 'success' });
      },
    });
  } catch (error) {
    // A failed registration only costs offline support, not the app.
    console.warn('Service worker registration failed', error);
  }
}

function renderFatal(container: HTMLElement, error: unknown): void {
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';

  const heading = document.createElement('p');
  heading.className = 'empty-state__title';
  heading.textContent = 'Databasen kunde inte öppnas';

  const detail = document.createElement('p');
  detail.textContent =
    'Privat surfläge och blockerade cookies kan hindra KvittoApp från att spara data. ' +
    (error instanceof Error ? error.message : String(error));

  wrapper.append(heading, detail);
  container.appendChild(wrapper);
}

void boot();
