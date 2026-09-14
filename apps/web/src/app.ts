/**
 * The application shell: navigation bar, routed outlet, tab bar.
 *
 * Follows the iOS navigation model. Top-level tabs get a large title that
 * scrolls away and hands over to a centred inline title in the bar; pushed
 * screens (a single receipt) get a back chevron and the inline title from the
 * start, as a navigation stack would.
 *
 * Views are code-split, so a session only downloads the screens it opens.
 */

import { el, replaceChildren } from './core/dom.js';
import { bus } from './core/events.js';
import { icon, type IconName } from './core/icons.js';
import { haptic } from './core/platform.js';
import { router, type RouteContext } from './core/router.js';
import { getSettings } from './core/settings.js';
import { countPending, getSyncState } from './sync/engine.js';

interface TabEntry {
  path: string;
  label: string;
  icon: IconName;
  title: string;
}

const TABS: TabEntry[] = [
  { path: '/receipts', label: 'Kvitton', icon: 'receipt', title: 'Kvitton' },
  { path: '/purchases', label: 'Köp', icon: 'search', title: 'Alla köp' },
  { path: '/scan', label: 'Skanna', icon: 'camera', title: 'Skanna' },
  { path: '/collections', label: 'Samlingar', icon: 'tag', title: 'Samlingar' },
  { path: '/settings', label: 'Inställningar', icon: 'gear', title: 'Inställningar' },
];

/** Screens pushed on top of a tab, which get a back button instead of a tab. */
const PUSHED_TITLES: Record<string, string> = {
  '/receipt': 'Kvitto',
  '/debug-log': 'Debugglogg',
  '/pair-scan': 'Skanna QR-kod',
};

/** How far the page scrolls before the large title hands over to the bar. */
const TITLE_HANDOVER_PX = 28;

export function mountApp(container: HTMLElement): void {
  const leading = el('div', { class: 'app-header__leading' });
  const inlineTitle = el('h1', { class: 'app-header__title', text: 'Kvitton' });
  const actions = el('div', { class: 'app-header__actions' });
  const aiProgress = el('div', {
    class: 'ai-progress',
    role: 'progressbar',
    'aria-label': 'AI-bearbetning pågår',
    hidden: true,
  }, el('span', { class: 'ai-progress__bar' }));
  const header = el(
    'header',
    { class: 'app-header', dataset: { scrolled: 'false' } },
    el('div', { class: 'app-header__bar' }, leading, inlineTitle, actions),
    aiProgress,
  );

  const largeTitle = el('h1', { class: 'large-title', text: 'Kvitton' });
  const outlet = el('div', { id: 'view-outlet' });
  const main = el('main', { class: 'app-main', id: 'main' }, largeTitle, outlet);
  const nav = el('nav', { class: 'app-nav', 'aria-label': 'Flikar' }, buildTabBar());

  replaceChildren(container, header, main, nav);

  applyTheme();
  bus.on('settings:changed', applyTheme);

  registerRoutes();
  router.start(outlet);

  const chrome = (): void => updateChrome({ header, leading, inlineTitle, largeTitle, nav });
  const status = (): void => void updateStatus(actions);

  bus.on('sync:state', status);
  bus.on('data:changed', status);
  bus.on('net:online', status);
  bus.on('ai:activity', ({ pending }) => {
    aiProgress.hidden = pending === 0;
  });
  window.addEventListener('hashchange', () => {
    chrome();
    status();
  });

  // Drives the large-title handover. Passive, because it never preventDefaults
  // and a blocking listener here would make scrolling feel heavy.
  const onScroll = (): void => {
    if (header.dataset['pushed'] === 'true') return;
    header.dataset['scrolled'] = String(window.scrollY > TITLE_HANDOVER_PX);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  chrome();
  status();
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
    .add('/debug-log', async () => (await import('./views/debug-log.js')).debugLogView())
    .add('/pair-scan', async () => (await import('./views/pair-scan.js')).pairScanView())
    .fallback(notFoundView);
}

async function notFoundView(context: RouteContext): Promise<HTMLElement> {
  const { emptyState } = await import('./components/ui.js');
  return emptyState({
    icon: 'compass',
    title: 'Sidan finns inte',
    body: context.path,
    action: el('button', {
      class: 'btn btn--primary',
      type: 'button',
      text: 'Till kvittolistan',
      on: { click: () => router.navigate('/receipts') },
    }),
  });
}

function buildTabBar(): HTMLElement {
  return el(
    'div',
    { class: 'app-nav__inner' },
    ...TABS.map((tab) =>
      el(
        'a',
        {
          class: 'nav-item',
          href: `#${tab.path}`,
          dataset: { path: tab.path },
          on: { click: () => haptic('selection') },
        },
        el(
          'span',
          { class: ['nav-item__icon', tab.path === '/scan' ? 'nav-item__icon--scan' : ''] },
          icon(tab.icon, { size: 24, weight: 2 }),
        ),
        el('span', { class: 'nav-item__label', text: tab.label }),
      ),
    ),
  );
}

interface Chrome {
  header: HTMLElement;
  leading: HTMLElement;
  inlineTitle: HTMLElement;
  largeTitle: HTMLElement;
  nav: HTMLElement;
}

function updateChrome(chrome: Chrome): void {
  const path = location.hash.replace(/^#/, '').split('?')[0] ?? '/';
  const base = `/${path.split('/').filter(Boolean)[0] ?? 'receipts'}`;
  const tab = TABS.find((entry) => entry.path === base);
  const pushedTitle = PUSHED_TITLES[base];
  const title = tab?.title ?? pushedTitle ?? 'KvittoApp';

  chrome.inlineTitle.textContent = title;
  chrome.largeTitle.textContent = title;
  document.title = base === '/receipts' ? 'KvittoApp' : `${title} — KvittoApp`;

  // A pushed screen keeps the compact bar and shows a back chevron; a tab
  // shows the large title until it is scrolled away.
  const pushed = tab === undefined && pushedTitle !== undefined;
  chrome.header.dataset['pushed'] = String(pushed);
  chrome.largeTitle.hidden = pushed;
  chrome.nav.hidden = pushed;

  if (pushed) {
    const settingsChild = base === '/debug-log' || base === '/pair-scan';
    const backTarget = settingsChild ? '/settings' : '/receipts';
    const backLabel = settingsChild ? 'Inställningar' : 'Kvitton';
    chrome.header.dataset['scrolled'] = 'true';
    replaceChildren(
      chrome.leading,
      el(
        'button',
        {
          class: 'bar-button',
          type: 'button',
          'aria-label': 'Tillbaka',
          on: {
            click: () => {
              haptic('selection');
              // Prefer real back navigation so the browser keeps its history,
              // and only synthesise a destination when there is nothing to
              // go back to (a cold load straight into a receipt).
              if (history.length > 1) history.back();
              else router.navigate(backTarget);
            },
          },
        },
        icon('chevron-left', { size: 20, weight: 2.4 }),
        el('span', { text: backLabel }),
      ),
    );
  } else {
    chrome.header.dataset['scrolled'] = String(window.scrollY > TITLE_HANDOVER_PX);
    replaceChildren(chrome.leading);
  }

  for (const link of chrome.nav.querySelectorAll<HTMLAnchorElement>('.nav-item')) {
    const current = link.dataset['path'] === base;
    if (current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/** Compact sync indicator in the navigation bar. */
async function updateStatus(slot: HTMLElement): Promise<void> {
  const base = `/${location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? ''}`;
  if (base === '/receipt') {
    replaceChildren(
      slot,
      el('button', {
        class: 'bar-edit-button',
        type: 'button',
        text: 'Redigera',
        on: {
          click: () => document.querySelector<HTMLElement>('.detail-edit-heading')?.scrollIntoView({ behavior: 'smooth' }),
        },
      }),
    );
    return;
  }

  const state = await getSyncState();
  const pending = await countPending();

  if (state.status === 'unpaired') {
    replaceChildren(slot, el('span', { class: 'avatar-chip', text: 'K' }));
    return;
  }

  const label =
    state.status === 'syncing'
      ? 'Synkar'
      : state.status === 'offline'
        ? 'Offline'
        : state.status === 'error'
          ? 'Synkfel'
          : pending > 0
            ? String(pending)
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

/** Applies the theme choice to the document root and the status-bar colour. */
function applyTheme(): void {
  const { theme } = getSettings().ui;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
