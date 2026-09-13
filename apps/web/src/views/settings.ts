/**
 * Settings, laid out as iOS Settings is: inset grouped lists, switches for
 * booleans, and an explanatory footer under each group rather than hint text
 * squeezed between controls.
 *
 * The AI section is the one most likely to be misconfigured, so it has a "test
 * connection" action that reports exactly what failed instead of leaving the
 * user to discover it on their next scan.
 */

import { formatBytes, formatRelativeTime } from '@kvitto/shared';

import { banner, listGroup, row, segmented, switchRow } from '../components/ui.js';
import { el, replaceChildren } from '../core/dom.js';
import { bus } from '../core/events.js';
import { icon } from '../core/icons.js';
import { isIos, isStandalone } from '../core/platform.js';
import { router } from '../core/router.js';
import {
  DEFAULT_BASE_URLS,
  MODEL_SUGGESTIONS,
  getSettings,
  updateSettings,
  type AiProvider,
} from '../core/settings.js';
import { confirmDialog, toast } from '../core/toast.js';
import { testConnection } from '../ai/index.js';
import { cvClient } from '../cv/client.js';
import { blobStoreSize, collectGarbage, discardOriginals } from '../db/blobs.js';
import { requestPersistentStorage, storageEstimate } from '../db/db.js';
import { eraseAllData, purgeTombstones } from '../db/repo.js';
import { pairDevice, whoAmI } from '../sync/client.js';
import { countPending, getSyncState, sync } from '../sync/engine.js';
import {
  getAccountId,
  getDeviceName,
  isPaired,
  setDeviceName,
  setDeviceToken,
  unpair,
} from '../sync/identity.js';

const PROVIDER_LABELS: Record<AiProvider, string> = {
  none: 'Ingen',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-kompatibel',
  ollama: 'Ollama (lokalt)',
  server: 'Min egen server',
};

/** Tint colours for the leading glyphs, matching how iOS Settings uses them. */
const GLYPH = {
  ai: 'var(--ios-indigo)',
  image: 'var(--ios-teal)',
  sync: 'var(--ios-blue)',
  storage: 'var(--ios-orange)',
  appearance: 'var(--ios-purple)',
  danger: 'var(--ios-red)',
} as const;

export async function settingsView(): Promise<HTMLElement> {
  const root = el('div', {});

  const unsubscribe = bus.on('settings:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  async function refresh(): Promise<void> {
    replaceChildren(
      root,
      renderInstallHint(),
      await renderAiSection(),
      renderImageSection(),
      await renderSyncSection(refresh),
      await renderStorageSection(refresh),
      renderAppearanceSection(),
      renderAbout(),
    );
  }

  await refresh();
  return root;
}

/**
 * iOS has no `beforeinstallprompt`, so a Home Screen install cannot be
 * triggered from script — the only thing that helps is telling the user where
 * the button is. Shown only on iOS, and only while not already installed.
 */
function renderInstallHint(): HTMLElement | null {
  if (!isIos() || isStandalone()) return null;
  return banner({
    tone: 'info',
    title: 'Lägg till på hemskärmen',
    body: 'Tryck på Dela-knappen i Safari och välj "Lägg till på hemskärmen" för helskärm, ikon och snabbare start.',
  });
}

// --- AI -------------------------------------------------------------------

async function renderAiSection(): Promise<HTMLElement> {
  const { ai } = getSettings();
  const statusHost = el('div', { class: 'list-group__footer' });
  const suggestions = MODEL_SUGGESTIONS[ai.provider];
  const needsKey = ai.provider === 'anthropic' || ai.provider === 'openai' || ai.provider === 'openai-compatible';
  const needsBaseUrl = ai.provider === 'openai-compatible' || ai.provider === 'ollama' || ai.provider === 'openai';

  const providerRow = row({
    label: 'Leverantör',
    icon: 'sparkles',
    iconColor: GLYPH.ai,
    trailing: el(
      'select',
      {
        'aria-label': 'AI-leverantör',
        on: {
          change: (event) => {
            const provider = (event.target as HTMLSelectElement).value as AiProvider;
            // Pre-fill the endpoint and model so the user is not left staring
            // at blank fields wondering what shape the values should take.
            void updateSettings({
              ai: {
                provider,
                baseUrl: DEFAULT_BASE_URLS[provider] ?? '',
                model: MODEL_SUGGESTIONS[provider][0] ?? '',
              },
            });
          },
        },
      },
      ...Object.entries(PROVIDER_LABELS).map(([value, label]) =>
        el('option', { value, text: label, selected: ai.provider === value }),
      ),
    ),
  });

  if (ai.provider === 'none') {
    return listGroup(
      { title: 'AI-tolkning', footer: 'Utan AI sparas kvitton som bilder och fylls i för hand.' },
      providerRow,
    );
  }

  const rows: HTMLElement[] = [providerRow];

  if (needsBaseUrl) {
    rows.push(
      row({
        label: 'Adress',
        trailing: el('input', {
          type: 'url',
          value: ai.baseUrl,
          placeholder: DEFAULT_BASE_URLS[ai.provider] ?? '',
          inputmode: 'url',
          autocapitalize: 'none',
          autocorrect: 'off',
          spellcheck: false,
          on: {
            change: (event) => {
              void updateSettings({ ai: { baseUrl: (event.target as HTMLInputElement).value.trim() } });
            },
          },
        }),
      }),
    );
  }

  if (needsKey) {
    rows.push(
      row({
        label: 'API-nyckel',
        trailing: el('input', {
          type: 'password',
          value: ai.apiKey,
          autocomplete: 'off',
          placeholder: 'Krävs',
          on: {
            change: (event) => {
              void updateSettings({ ai: { apiKey: (event.target as HTMLInputElement).value.trim() } });
            },
          },
        }),
      }),
    );
  }

  rows.push(
    row({
      label: 'Modell',
      trailing: el('input', {
        type: 'text',
        value: ai.model,
        list: suggestions.length ? 'model-suggestions' : undefined,
        placeholder: suggestions[0] ?? 'modellnamn',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        on: {
          change: (event) => {
            void updateSettings({ ai: { model: (event.target as HTMLInputElement).value.trim() } });
          },
        },
      }),
    }),
  );

  if (suggestions.length) {
    rows.push(
      el(
        'datalist',
        { id: 'model-suggestions' },
        ...suggestions.map((model) => el('option', { value: model })),
      ),
    );
  }

  rows.push(
    switchRow({
      label: 'Tolka direkt efter skanning',
      checked: ai.autoParse,
      onChange: (checked) => void updateSettings({ ai: { autoParse: checked } }),
    }),
  );

  const testButton = el('button', {
    class: 'row',
    type: 'button',
    style: 'color:var(--tint);justify-content:center;font-weight:500',
    text: 'Testa anslutningen',
    on: {
      click: async () => {
        testButton.disabled = true;
        replaceChildren(statusHost, el('span', { text: 'Testar…' }));
        const result = await testConnection();
        replaceChildren(
          statusHost,
          el(
            'span',
            { class: 'status-line' },
            el('span', { class: ['status-dot', result.ok ? 'status-dot--ok' : 'status-dot--error'] }),
            el('span', { text: result.message }),
          ),
        );
        testButton.disabled = false;
      },
    },
  });
  rows.push(testButton);

  const keyFooter = needsKey
    ? 'Nyckeln sparas bara på den här enheten och skickas bara till leverantören. Vill du hellre slippa ha den i telefonen — välj "Min egen server".'
    : ai.provider === 'ollama'
      ? `Starta Ollama med OLLAMA_ORIGINS="${location.origin}" så att webbläsaren får anropa den.`
      : 'Servern håller nyckeln åt dig.';

  return el(
    'div',
    {},
    listGroup({ title: 'AI-tolkning', footer: keyFooter }, ...rows),
    statusHost,
    renderAdvancedAi(),
  );
}

function renderAdvancedAi(): HTMLElement {
  const { ai } = getSettings();

  const rows: HTMLElement[] = [
    row({
      label: 'Max tokens',
      trailing: el('input', {
        type: 'number',
        min: 1000,
        max: 128000,
        step: 1000,
        value: String(ai.maxOutputTokens),
        inputmode: 'numeric',
        on: {
          change: (event) => {
            const value = Number((event.target as HTMLInputElement).value);
            if (Number.isFinite(value) && value > 0) {
              void updateSettings({ ai: { maxOutputTokens: Math.round(value) } });
            }
          },
        },
      }),
    }),
    switchRow({
      label: 'Tvinga JSON-schema',
      checked: ai.structuredOutput,
      onChange: (checked) => void updateSettings({ ai: { structuredOutput: checked } }),
    }),
  ];

  if (ai.provider === 'anthropic') {
    rows.splice(
      1,
      0,
      row({
        label: 'Tankedjup',
        trailing: el(
          'select',
          {
            'aria-label': 'Tankedjup',
            on: {
              change: (event) => {
                void updateSettings({
                  ai: { effort: (event.target as HTMLSelectElement).value as typeof ai.effort },
                });
              },
            },
          },
          ...(['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((value) =>
            el('option', {
              value,
              text: value === 'auto' ? 'Standard' : value,
              selected: ai.effort === value,
            }),
          ),
        ),
      }),
    );
  }

  rows.push(
    el(
      'div',
      { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:6px' },
      el('span', { class: 'field__label', style: 'margin:0', text: 'Extra instruktioner till modellen' }),
      el('textarea', {
        value: ai.extraInstructions,
        rows: 2,
        placeholder: 'T.ex. "Min lokala butik skriver pant som PANT+".',
        style: 'background:var(--fill-tertiary);border-radius:8px;padding:8px 10px;text-align:left',
        on: {
          change: (event) => {
            void updateSettings({ ai: { extraInstructions: (event.target as HTMLTextAreaElement).value } });
          },
        },
      }),
    ),
  );

  return listGroup(
    {
      title: 'Avancerat',
      footer:
        'Ett långt kvitto med många rader behöver fler tokens. JSON-schema ger stabilare svar och ' +
        'faller automatiskt tillbaka om modellen inte stödjer det.',
    },
    ...rows,
  );
}

// --- image ----------------------------------------------------------------

function renderImageSection(): HTMLElement {
  const { image } = getSettings();
  const cv = cvClient.status;

  const rows: HTMLElement[] = [
    el(
      'div',
      { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:8px' },
      el('span', { class: 'row__label', style: 'flex:none', text: 'Efterbehandling' }),
      segmented({
        label: 'Efterbehandling',
        value: image.enhance,
        options: [
          { value: 'grayscale', label: 'Grå' },
          { value: 'color', label: 'Färg' },
          { value: 'binarize', label: 'S/V' },
          { value: 'none', label: 'Av' },
        ],
        onChange: (value) => void updateSettings({ image: { enhance: value } }),
      }),
    ),
    switchRow({
      label: 'Hitta kanter automatiskt',
      checked: image.detectEdges,
      icon: 'crop',
      iconColor: GLYPH.image,
      onChange: (checked) => void updateSettings({ image: { detectEdges: checked } }),
    }),
    el(
      'div',
      { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:4px' },
      el(
        'span',
        { class: 'stack stack--between' },
        el('span', { class: 'row__label', text: 'Maxstorlek' }),
        el('span', { class: 'row__value', text: `${image.maxDimension} px` }),
      ),
      el('input', {
        type: 'range',
        min: 800,
        max: 3000,
        step: 128,
        value: String(image.maxDimension),
        'aria-label': 'Maxstorlek i pixlar',
        on: {
          change: (event) => {
            void updateSettings({ image: { maxDimension: Number((event.target as HTMLInputElement).value) } });
          },
        },
      }),
    ),
    switchRow({
      label: 'Spara originalbilden',
      checked: image.keepOriginal,
      icon: 'photo',
      iconColor: GLYPH.image,
      onChange: (checked) => void updateSettings({ image: { keepOriginal: checked } }),
    }),
  ];

  if (!cv.ready) {
    rows.push(
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center;font-weight:500',
        text: 'Ladda ner för offline-bruk',
        on: {
          click: async (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.disabled = true;
            button.textContent = 'Laddar ner…';
            const ok = await cvClient.warmup();
            toast(ok ? 'Bildbehandling är nu tillgänglig offline.' : 'Nedladdningen misslyckades.', {
              kind: ok ? 'success' : 'error',
            });
            button.disabled = false;
            button.textContent = 'Ladda ner för offline-bruk';
          },
        },
      }),
    );
  }

  return listGroup(
    {
      title: 'Bildbehandling',
      footer: cv.ready
        ? 'Gråskala jämnar ut skuggor och höjer kontrasten utan att kasta bort svag termoutskrift — ' +
          'det är oftast vad AI-modellen läser bäst. Bildbehandlingen fungerar offline.'
        : 'Gråskala läser oftast bäst. Bildbehandlingen (≈11 MB) laddas ner vid första skanningen ' +
          'och fungerar därefter offline.',
    },
    ...rows,
  );
}

// --- sync -----------------------------------------------------------------

async function renderSyncSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const { sync: syncSettings } = getSettings();
  const paired = await isPaired();
  const state = await getSyncState();
  const deviceName = await getDeviceName();
  const accountId = await getAccountId();

  const rows: HTMLElement[] = [
    row({
      label: 'Server',
      icon: 'cloud',
      iconColor: GLYPH.sync,
      trailing: el('input', {
        type: 'url',
        value: syncSettings.serverUrl,
        placeholder: 'https://…',
        inputmode: 'url',
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        on: {
          change: (event) => {
            void updateSettings({
              sync: { serverUrl: (event.target as HTMLInputElement).value.trim().replace(/\/+$/, '') },
            });
          },
        },
      }),
    }),
    row({
      label: 'Enhetsnamn',
      trailing: el('input', {
        type: 'text',
        value: deviceName,
        on: { change: (event) => void setDeviceName((event.target as HTMLInputElement).value) },
      }),
    }),
  ];

  if (!paired) {
    const codeInput = el('input', {
      type: 'text',
      placeholder: 'ABC-DEF-GHJ',
      autocapitalize: 'characters',
      autocorrect: 'off',
      spellcheck: false,
      'aria-label': 'Parkopplingskod',
    });

    rows.push(
      row({ label: 'Kod', trailing: codeInput }),
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center;font-weight:600',
        text: 'Parkoppla enheten',
        on: {
          click: async (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            const url = getSettings().sync.serverUrl;
            if (!url) {
              toast('Fyll i serveradressen först.', { kind: 'error' });
              return;
            }
            button.disabled = true;
            try {
              const result = await pairDevice(url, codeInput.value);
              await setDeviceToken(result.token, result.accountId);
              toast('Enheten är parkopplad.', { kind: 'success' });
              void sync();
              await refresh();
            } catch (error) {
              toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
            } finally {
              button.disabled = false;
            }
          },
        },
      }),
    );

    return listGroup(
      {
        title: 'Synkronisering',
        footer: 'Kör "npm run pair" på servern för att skapa en kod. Den gäller i 15 minuter.',
      },
      ...rows,
    );
  }

  const pending = await countPending();
  rows.push(
    row({
      label: 'Status',
      value: `${statusLabel(state.status)}${pending > 0 ? ` · ${pending} väntar` : ''}`,
    }),
    row({ label: 'Senast synkad', value: formatRelativeTime(state.lastSuccess) }),
    switchRow({
      label: 'Synka automatiskt',
      checked: syncSettings.autoSync,
      onChange: (checked) => void updateSettings({ sync: { autoSync: checked } }),
    }),
    switchRow({
      label: 'Synka även bilder',
      checked: syncSettings.syncImages,
      onChange: (checked) => void updateSettings({ sync: { syncImages: checked } }),
    }),
    el('button', {
      class: 'row',
      type: 'button',
      style: 'color:var(--tint);justify-content:center;font-weight:500',
      text: 'Synka nu',
      on: {
        click: async (event) => {
          const button = event.currentTarget as HTMLButtonElement;
          button.disabled = true;
          button.textContent = 'Synkar…';
          const report = await sync();
          toast(
            report.ok
              ? `Klart: ${report.pushed} skickade, ${report.pulled} hämtade.`
              : (report.error ?? 'Synkroniseringen misslyckades.'),
            { kind: report.ok ? 'success' : 'error' },
          );
          button.disabled = false;
          await refresh();
        },
      },
    }),
    el('button', {
      class: 'row',
      type: 'button',
      style: 'color:var(--danger);justify-content:center',
      text: 'Koppla från servern',
      on: {
        click: async () => {
          const confirmed = await confirmDialog({
            title: 'Koppla från?',
            message:
              'Dina kvitton ligger kvar på enheten. Nästa gång du parkopplar laddas hela arkivet upp igen.',
            confirmLabel: 'Koppla från',
            destructive: true,
          });
          if (!confirmed) return;
          await unpair();
          toast('Enheten är frånkopplad.');
          await refresh();
        },
      },
    }),
  );

  return listGroup(
    {
      title: 'Synkronisering',
      footer: accountId
        ? `Konto ${accountId.slice(0, 8)}… · Stäng av bildsynk för att spara mobildata; texten synkas ändå.`
        : 'Stäng av bildsynk för att spara mobildata; texten synkas ändå.',
    },
    ...rows,
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'idle':
      return 'Synkad';
    case 'syncing':
      return 'Synkar…';
    case 'error':
      return 'Fel vid synk';
    case 'offline':
      return 'Offline';
    default:
      return 'Inte parkopplad';
  }
}

// --- storage --------------------------------------------------------------

async function renderStorageSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const [estimate, blobs] = await Promise.all([storageEstimate(), blobStoreSize()]);
  const persisted = (await navigator.storage?.persisted?.()) ?? false;

  const rows: HTMLElement[] = [
    row({ label: 'Bilder', value: `${blobs.count} · ${formatBytes(blobs.bytes)}` }),
  ];

  if (estimate) {
    rows.push(
      el(
        'div',
        { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:6px' },
        el(
          'span',
          { class: 'stack stack--between' },
          el('span', { class: 'row__label', text: 'Använt utrymme' }),
          el('span', {
            class: 'row__value',
            text: `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`,
          }),
        ),
        el(
          'span',
          { class: 'progress' },
          el('span', {
            class: 'progress__bar',
            style: `width:${Math.min(100, (estimate.usage / estimate.quota) * 100)}%`,
          }),
        ),
      ),
    );
  }

  if (!persisted) {
    rows.push(
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center;font-weight:500',
        text: 'Be om permanent lagring',
        on: {
          click: async () => {
            const granted = await requestPersistentStorage();
            toast(granted ? 'Lagringen är nu permanent.' : 'Webbläsaren nekade permanent lagring.', {
              kind: granted ? 'success' : 'error',
            });
            await refresh();
          },
        },
      }),
    );
  }

  rows.push(
    el('button', {
      class: 'row',
      type: 'button',
      style: 'color:var(--tint);justify-content:center;font-weight:500',
      text: 'Frigör utrymme',
      on: {
        click: async () => {
          const originals = await discardOriginals();
          const orphans = await collectGarbage();
          const tombstones = await purgeTombstones();
          toast(
            `Frigjorde ${formatBytes(originals.bytes + orphans.bytes)} · ${tombstones} poster rensade.`,
            { kind: 'success' },
          );
          await refresh();
        },
      },
    }),
    el('button', {
      class: 'row',
      type: 'button',
      style: 'color:var(--danger);justify-content:center',
      text: 'Radera all data',
      on: {
        click: async () => {
          const confirmed = await confirmDialog({
            title: 'Radera allt?',
            message:
              'Alla kvitton, varor, etiketter och bilder på den här enheten tas bort. Det går inte att ångra.',
            confirmLabel: 'Radera',
            destructive: true,
          });
          if (!confirmed) return;
          await eraseAllData();
          toast('All data raderades.');
          router.navigate('/receipts');
        },
      },
    }),
  );

  return listGroup(
    {
      title: 'Lagring',
      footer: persisted
        ? 'Lagringen är permanent — webbläsaren rensar den inte automatiskt. "Frigör utrymme" tar bort ' +
          'originalbilder för redan tolkade kvitton.'
        : 'Webbläsaren kan rensa data vid platsbrist. Be om permanent lagring för att förhindra det.',
    },
    ...rows,
  );
}

// --- appearance -----------------------------------------------------------

function renderAppearanceSection(): HTMLElement {
  const { ui } = getSettings();

  return listGroup(
    { title: 'Utseende' },
    el(
      'div',
      { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:8px' },
      el('span', { class: 'row__label', style: 'flex:none', text: 'Tema' }),
      segmented({
        label: 'Tema',
        value: ui.theme,
        options: [
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Ljust' },
          { value: 'dark', label: 'Mörkt' },
        ],
        onChange: (value) => void updateSettings({ ui: { theme: value } }),
      }),
    ),
    switchRow({
      label: 'Visa rabatt- och pantrader',
      checked: ui.showAuxiliaryLines,
      onChange: (checked) => void updateSettings({ ui: { showAuxiliaryLines: checked } }),
    }),
  );
}

function renderAbout(): HTMLElement {
  return el(
    'div',
    { class: 'empty-state', style: 'padding:24px 32px 8px' },
    icon('receipt', { size: 34, className: 'empty-state__icon', weight: 1.3 }),
    el('p', {
      style: 'margin:0;font-size:13px;max-width:34ch',
      text:
        'KvittoApp fungerar helt offline. Kvitton, bilder och inställningar ligger bara på den ' +
        'här enheten tills du väljer att synka dem till din egen server.',
    }),
  );
}
