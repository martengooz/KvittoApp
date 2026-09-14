import { listGroup, segmented } from '../components/ui.js';
import { getClientDebugEntries, clearClientDebugEntries, type DebugEntry } from '../core/debug-log.js';
import { el, replaceChildren } from '../core/dom.js';
import { getSettings } from '../core/settings.js';
import { confirmDialog, toast } from '../core/toast.js';
import { clearServerDebugLog, serverDebugLog } from '../sync/client.js';

type LogSource = 'client' | 'server';

export async function debugLogView(): Promise<HTMLElement> {
  const root = el('div', {});
  let source: LogSource = 'client';

  async function render(): Promise<void> {
    replaceChildren(root, controls(true), el('p', { class: 'page-message', text: 'Hämtar logg…' }));
    try {
      const entries = await load(source);
      replaceChildren(root, controls(false), renderEntries(entries));
    } catch (error) {
      replaceChildren(
        root,
        controls(false),
        listGroup(
          { title: 'Logg' },
          el('div', {
            class: 'debug-log__empty',
            text: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }
  }

  function controls(disabled: boolean): HTMLElement {
    return listGroup(
      {
        title: 'Utvecklarinställningar',
        footer: 'Loggen innehåller teknisk metadata, aldrig kvitton, bilder, tokens eller API-nycklar.',
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
          class: 'btn btn--plain',
          type: 'button',
          disabled,
          style: 'color:var(--danger)',
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
      footer: entries.length ? 'Nyaste poster visas först.' : 'Inga loggposter ännu.',
    },
    entries.length
      ? entries.map((entry) =>
          el(
            'div',
            { class: 'debug-log__entry' },
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
    toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
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

function formatDetails(details: DebugEntry['details']): string {
  return Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
}