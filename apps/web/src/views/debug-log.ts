import { listGroup, loadingState, segmented } from '../components/ui.js';
import { describeError } from '@kvitto/shared';
import { getClientDebugEntries, clearClientDebugEntries, type DebugEntry } from '../core/debug-log.js';
import { el, replaceChildren } from '../core/dom.js';
import { router } from '../core/router.js';
import { getSettings } from '../core/settings.js';
import { confirmDialog } from '../components/dialog.js';
import { toast } from '../core/toast.js';
import { clearServerDebugLog, serverDebugLog } from '../sync/client.js';

type LogSource = 'client' | 'server';

export async function debugLogView(): Promise<HTMLElement> {
  const root = el('div', {});
  let source: LogSource = 'client';
  // A fetch (especially the server log, a network round trip) can still be in
  // flight when the user navigates away; this stops it writing into a root
  // nobody is looking at any more.
  let disposed = false;
  router.onTeardown(() => {
    disposed = true;
  });

  async function render(): Promise<void> {
    replaceChildren(root, controls(true), loadingState({ title: 'Hämtar logg…' }));
    try {
      const entries = await load(source);
      if (disposed) return;
      replaceChildren(root, controls(false), renderEntries(entries));
    } catch (error) {
      if (disposed) return;
      replaceChildren(
        root,
        controls(false),
        listGroup(
          { title: 'Logg' },
          el('div', {
            class: 'debug-log__empty',
            text: describeError(error),
          }),
        ),
      );
    }
  }

  function controls(disabled: boolean): HTMLElement {
    return listGroup(
      {
        title: 'Utvecklarinställningar',
        footer: 'HTTP-loggen kan innehålla kvittodata. Bilder visas bara med typ och storlek; koder, tokens och API-nycklar maskeras.',
      },
      el(
        'div',
        { class: 'row debug-log__source' },
        segmented({
          label: 'Loggkälla',
          value: source,
          options: [
            { value: 'client', label: 'Klient' },
            { value: 'server', label: 'Server' },
          ],
          onChange: (value) => {
            source = value;
            void render();
          },
        }),
      ),
      el(
        'div',
        { class: 'row debug-log__actions' },
        el('button', {
          class: 'btn btn--plain',
          type: 'button',
          disabled,
          text: 'Uppdatera',
          on: { click: () => void render() },
        }),
        el('button', {
          class: 'btn btn--plain',
          type: 'button',
          disabled,
          text: 'Exportera',
          on: { click: () => void exportLog(source) },
        }),
        el('button', {
          class: 'btn btn--plain btn--danger-plain',
          type: 'button',
          disabled,
          text: 'Rensa',
          on: {
            click: async () => {
              const confirmed = await confirmDialog({
                title: 'Rensa debugloggen?',
                message: `Alla ${source === 'client' ? 'klientens' : 'serverns'} loggposter tas bort.`,
                confirmLabel: 'Rensa',
                destructive: true,
              });
              if (!confirmed) return;
              await clear(source);
              toast('Debugloggen rensades.');
              await render();
            },
          },
        }),
      ),
    );
  }

  await render();
  return root;
}

async function load(source: LogSource): Promise<DebugEntry[]> {
  if (source === 'client') return getClientDebugEntries();
  const serverUrl = getSettings().sync.serverUrl;
  if (!serverUrl) throw new Error('Ingen serveradress är angiven.');
  return (await serverDebugLog(serverUrl)).entries;
}

async function clear(source: LogSource): Promise<void> {
  if (source === 'client') {
    clearClientDebugEntries();
    return;
  }
  const serverUrl = getSettings().sync.serverUrl;
  if (!serverUrl) throw new Error('Ingen serveradress är angiven.');
  await clearServerDebugLog(serverUrl);
}

function renderEntries(entries: DebugEntry[]): HTMLElement {
  return listGroup(
    {
      title: `Logg (${entries.length})`,
      footer: entries.length ? 'Nyaste poster visas först. Högst 500 sparas.' : 'Inga loggposter ännu.',
    },
    entries.length
      ? entries.map((entry) =>
          el(
            'button',
            {
              class: 'debug-log__entry',
              type: 'button',
              'aria-label': `Visa detaljer för ${entry.message}`,
              on: { click: () => showEntryDetails(entry) },
            },
            el(
              'div',
              { class: 'debug-log__meta' },
              el('span', { class: ['debug-log__level', `debug-log__level--${entry.level}`], text: entry.level }),
              el('time', { datetime: new Date(entry.timestamp).toISOString(), text: formatTime(entry.timestamp) }),
            ),
            el('strong', { class: 'debug-log__message', text: entry.message }),
            Object.keys(entry.details).length
              ? el('code', { class: 'debug-log__details', text: formatDetails(entry.details) })
              : null,
          ),
        )
      : el('div', { class: 'debug-log__empty', text: 'Inga loggposter ännu.' }),
  );
}

function showEntryDetails(entry: DebugEntry): void {
  const dialog = el(
    'dialog',
    { class: 'dialog debug-log-dialog' },
    el(
      'div',
      { class: 'dialog__body' },
      el(
        'div',
        { class: 'dialog__content debug-log-dialog__content' },
        el('h2', { class: 'dialog__title', text: 'Loggdetaljer' }),
        el('p', { class: 'debug-log-dialog__message', text: entry.message }),
        el(
          'dl',
          { class: 'debug-log-dialog__metadata' },
          detailField('Tid', formatFullTime(entry.timestamp)),
          detailField('ISO-tid', new Date(entry.timestamp).toISOString()),
          detailField('Källa', entry.source === 'client' ? 'Klient' : 'Server'),
          detailField('Nivå', entry.level.toUpperCase()),
          detailField('ID', String(entry.id)),
        ),
        renderEntryData(entry.details),
      ),
      el(
        'div',
        { class: 'dialog__actions' },
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Kopiera',
          on: { click: () => void copyEntry(entry) },
        }),
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Stäng',
          on: { click: () => dialog.close() },
        }),
      ),
    ),
  );

  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dialog.close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  dialog.showModal();
}

function renderEntryData(details: DebugEntry['details']): HTMLElement {
  const request = asRecord(details.request);
  const response = asRecord(details.response);
  if (!request || !response) {
    return el(
      'div',
      {},
      el('h3', { class: 'debug-log-dialog__heading', text: 'Data' }),
      Object.keys(details).length
        ? dataBlock(details)
        : el('p', { class: 'debug-log-dialog__empty', text: 'Ingen ytterligare data.' }),
    );
  }

  const metadata = Object.fromEntries(
    Object.entries(details).filter(([key]) => key !== 'request' && key !== 'response'),
  );
  return el(
    'div',
    {},
    Object.keys(metadata).length ? dataSection('Metadata', metadata) : null,
    dataSection('Förfrågan', request),
    dataSection('Svar', response),
  );
}

function dataSection(title: string, value: DebugEntry['details']): HTMLElement {
  return el(
    'section',
    { class: 'debug-log-dialog__section' },
    el('h3', { class: 'debug-log-dialog__heading', text: title }),
    dataBlock(value),
  );
}

function dataBlock(value: DebugEntry['details']): HTMLElement {
  return el('pre', {
    class: 'code-block debug-log-dialog__data',
    text: JSON.stringify(value, null, 2),
  });
}

function asRecord(value: unknown): DebugEntry['details'] | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DebugEntry['details']
    : null;
}

function detailField(label: string, value: string): HTMLElement[] {
  return [
    el('dt', { text: label }),
    el('dd', { text: value }),
  ];
}

async function copyEntry(entry: DebugEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
    toast('Loggposten kopierades.', { kind: 'success' });
  } catch {
    toast('Kunde inte kopiera loggposten.', { kind: 'error' });
  }
}

async function exportLog(source: LogSource): Promise<void> {
  try {
    const entries = await load(source);
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kvitto-${source}-debug-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toast(describeError(error), { kind: 'error' });
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function formatFullTime(timestamp: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    dateStyle: 'long',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

function formatDetails(details: DebugEntry['details']): string {
  return Object.entries(details)
    .filter(([key]) => key !== 'request' && key !== 'response')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}