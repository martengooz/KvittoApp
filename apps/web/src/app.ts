/**
 * The application shell: header, routed outlet, bottom navigation.
 *
 * Views are code-split so the initial load only carries the shell and whichever
 * screen was opened — the settings and receipt-detail screens in particular
 * pull in code most sessions never touch.
 */

import { el, replaceChildren } from './core/dom.js';
import { bus } from './core/events.js';
import { router, type RouteContext } from './core/router.js';
import { getSettings } from './core/settings.js';
import { countPending, getSyncState } from './sync/engine.js';

interface NavEntry {
  path: string;
  label: string;
  icon: string;
  modifier?: string;
}

const NAV: NavEntry[] = [
  { path: '/receipts', label: 'Kvitton', icon: '🧾' },
  { path: '/purchases', label: 'Köp', icon: '🔍' },
  { path: '/scan', label: 'Skanna', icon: '＋', modifier: 'nav-item--scan' },
  { path: '/collections', label: 'Samlingar', icon: '🏷️' },
  { path: '/settings', label: 'Inställningar', icon: '⚙️' },
];

const TITLES: Record<string, string> = {
  '/receipts': 'Kvitton',
  '/purchases': 'Alla köp',
  '/scan': 'Skanna',
  '/collections': 'Samlingar',
  '/settings': 'Inställningar',
  '/receipt': 'Kvitto',
};

export function mountApp(container: HTMLElement): void {
  const title = el('h1', { class: 'app-header__title', text: 'Kvitton' });
  const statusSlot = el('div', { class: 'app-header__actions' });
  const outlet = el('main', { class: 'app-main', id: 'main' });
  const nav = el('nav', { class: 'app-nav', 'aria-label': 'Huvudnavigering' }, buildNav());

  replaceChildren(
    container,
    el('header', { class: 'app-header' }, title, statusSlot),
    outlet,
    nav,
  );

  applyTheme();
  bus.on('settings:changed', applyTheme);

  registerRoutes();
  router.start(outlet);

  const syncUpdates = (): void => void updateStatus(statusSlot);
  bus.on('sync:state', syncUpdates);
  bus.on('data:changed', syncUpdates);
  bus.on('net:online', syncUpdates);
  window.addEventListener('hashchange', () => {
    updateChrome(title, nav);
    syncUpdates();
  });

  updateChrome(title, nav);
  syncUpdates();
}

function registerRoutes(): void {
  router
    .add('/', async (context) => (await import('./views/receipts.js')).receiptsView(context))
    .add('/receipts', async (context) => (await import('./views/receipts.js')).receiptsView(context))
    .add('/purchases', async (context) => (await import('./views/purchases.js')).purchasesView(context))
    .add('/scan', async () => (await import('./views/scan.js')).scanView())
    .add('/receipt/:id', async (context) => (await import('./views/receipt.js')).receiptView(context))
    .add('/collections', async () => (await import('./views/collections.js')).collectionsView())
    .add('/settings', async () => (await import('./views/settings.js')).settingsView())
    .fallback(notFoundView);
}

function notFoundView(context: RouteContext): HTMLElement {
  return el(
    'div',
    { class: 'empty-state' },
    el('div', { class: 'empty-state__icon', 'aria-hidden': 'true', text: '🧭' }),
    el('p', { class: 'empty-state__title', text: 'Sidan finns inte' }),
    el('p', { text: context.path }),
    el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: 'Till kvittolistan',
      on: { click: () => router.navigate('/receipts') },
    }),
  );
}

function buildNav(): HTMLElement {
  return el(
    'div',
    { class: 'app-nav__inner' },
    ...NAV.map((entry) =>
      el(
        'a',
        { class: ['nav-item', entry.modifier], href: `#${entry.path}`, 'data-path': entry.path },
        el('span', { class: 'nav-item__icon', 'aria-hidden': 'true', text: entry.icon }),
        el('span', { text: entry.label }),
      ),
    ),
  );
}

function updateChrome(title: HTMLElement, nav: HTMLElement): void {
  const path = location.hash.replace(/^#/, '').split('?')[0] ?? '/';
  const base = `/${path.split('/').filter(Boolean)[0] ?? 'receipts'}`;
  title.textContent = TITLES[base] ?? 'KvittoApp';
  document.title = base === '/receipts' ? 'KvittoApp' : `${title.textContent} — KvittoApp`;

  for (const link of nav.querySelectorAll<HTMLAnchorElement>('.nav-item')) {
    const isCurrent = link.dataset['path'] === base;
    if (isCurrent) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/** Compact sync indicator in the header. */
async function updateStatus(slot: HTMLElement): Promise<void> {
  const state = await getSyncState();
  const pending = await countPending();

  if (state.status === 'unpaired') {
    replaceChildren(slot, pending > 0 ? el('span', { class: 'pill', text: `${pending} osparade` }) : null);
    return;
  }

  const label =
    state.status === 'syncing'
      ? 'Synkar…'
      : state.status === 'offline'
        ? 'Offline'
        : state.status === 'error'
          ? 'Synkfel'
          : pending > 0
            ? `${pending} väntar`
            : 'Synkad';

  const tone =
    state.status === 'error' ? 'pill--danger' : state.status === 'offline' ? 'pill--warning' : '';

  replaceChildren(
    slot,
    el(
      'button',
      {
        class: ['pill', tone],
        type: 'button',
        title: state.message ?? label,
        on: { click: () => router.navigate('/settings') },
      },
      el('span', { class: ['status-dot', state.status === 'syncing' ? 'status-dot--busy' : ''] }),
      label,
    ),
  );
}

/** Applies the theme choice to the document root. */
function applyTheme(): void {
  const { theme } = getSettings().ui;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
