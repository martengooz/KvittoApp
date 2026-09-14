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
import { checkForAppUpdate } from '../core/app-update.js';
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
import { APIVERKET_BASE_URL } from '../api/apiverket.js';
import { cvClient } from '../cv/client.js';
import { clearCompanyMisses, listCompanies, searchBudgetUsed } from '../db/companies.js';
import { blobStoreSize, collectGarbage, discardOriginals } from '../db/blobs.js';
import { requestPersistentStorage, storageEstimate } from '../db/db.js';
import { eraseAllData, purgeTombstones } from '../db/repo.js';
import {
  llmPull,
  llmRequeue,
  llmScan,
  llmStatus,
  pairDevice,
  whoAmI,
  type LlmStatusResponse,
} from '../sync/client.js';
import { countPending, getSyncState, resetSyncBackoff, sync, syncNow, type SyncReport } from '../sync/engine.js';
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
  company: 'var(--ios-green)',
  sync: 'var(--ios-blue)',
  storage: 'var(--ios-orange)',
  appearance: 'var(--ios-purple)',
  developer: 'var(--label-secondary)',
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
      await renderCompanySection(),
      await renderSyncSection(refresh),
      await renderLocalModelSection(refresh),
      await renderStorageSection(refresh),
      renderAppearanceSection(),
      renderDeveloperSection(),
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
    ? 'Nyckeln synkroniseras mellan dina parkopplade enheter.'
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

// --- company lookup -------------------------------------------------------

/**
 * The organisation-number lookup.
 *
 * Kept apart from the AI section because it is a different kind of thing: a
 * registry query keyed off a checksum-verified number, not a model guess. It
 * also has its own key, its own quota, and works when no model is configured
 * at all.
 */
async function renderCompanySection(): Promise<HTMLElement> {
  const { company } = getSettings();
  const [stored, searchesUsed] = await Promise.all([listCompanies(), searchBudgetUsed()]);

  const rows: HTMLElement[] = [
    switchRow({
      label: 'Slå upp företag automatiskt',
      checked: company.autoLookup,
      icon: 'building',
      iconColor: GLYPH.company,
      onChange: (checked) => void updateSettings({ company: { autoLookup: checked } }),
    }),
    row({
      label: 'API-nyckel',
      trailing: el('input', {
        type: 'password',
        value: company.apiKey,
        autocomplete: 'off',
        placeholder: 'sk_live_…',
        on: {
          change: (event) => {
            void updateSettings({ company: { apiKey: (event.target as HTMLInputElement).value.trim() } });
          },
        },
      }),
    }),
    row({
      label: 'Adress',
      trailing: el('input', {
        type: 'url',
        value: company.baseUrl,
        placeholder: APIVERKET_BASE_URL,
        autocapitalize: 'none',
        autocorrect: 'off',
        spellcheck: false,
        on: {
          change: (event) => {
            const value = (event.target as HTMLInputElement).value.trim();
            void updateSettings({ company: { baseUrl: value || APIVERKET_BASE_URL } });
          },
        },
      }),
    }),
    switchRow({
      label: 'Sök på namn om nummer saknas',
      checked: company.nameSearch,
      icon: 'search',
      iconColor: GLYPH.company,
      onChange: (checked) => void updateSettings({ company: { nameSearch: checked } }),
    }),
  ];

  if (company.nameSearch) {
    rows.push(
      el(
        'div',
        { class: 'row', style: 'flex-direction:column;align-items:stretch;gap:4px' },
        el(
          'span',
          { class: 'stack stack--between' },
          el('span', { class: 'row__label', text: 'Namnsökningar per dag' }),
          el('span', {
            class: 'row__value',
            text: `${searchesUsed} av ${company.searchBudget} idag`,
          }),
        ),
        el('input', {
          type: 'range',
          min: 0,
          max: 20,
          step: 1,
          value: String(company.searchBudget),
          'aria-label': 'Namnsökningar per dag',
          on: {
            change: (event) => {
              const value = Number((event.target as HTMLInputElement).value);
              void updateSettings({ company: { searchBudget: value } });
            },
          },
        }),
      ),
    );
  }

  rows.push(row({ label: 'Sparade företag', value: String(stored.length) }));

  if (stored.length > 0) {
    rows.push(
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center',
        text: 'Glöm misslyckade uppslag',
        on: {
          click: async () => {
            await clearCompanyMisses();
            toast('Nekade organisationsnummer slås upp igen vid nästa avläsning.', { kind: 'success' });
          },
        },
      }),
    );
  }

  return listGroup(
    {
      title: 'Företagsuppslag',
      footer:
        'Organisationsnumret läses av kvittot på enheten och slås upp mot Bolagsverket via ' +
        'Apiverket. Ett företag som redan är sparat slås aldrig upp igen, så ett kvitto från ' +
        'samma butik kostar inget. Går numret inte att läsa söks butikens namn istället — ' +
        'den sökningen har en egen, mycket mindre kvot hos Apiverket (20 per dygn på en ' +
        'gratisnyckel), därför dagsgränsen. Nyckeln synkroniseras mellan parkopplade enheter.',
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
            // A new address is a new server; whatever the old one was failing
            // at says nothing about this one.
            resetSyncBackoff();
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
      el('button', {
        class: 'row',
        type: 'button',
        style: 'color:var(--tint);justify-content:center;font-weight:600',
        text: 'Skanna QR-kod',
        on: { click: () => router.navigate('/pair-scan') },
      }),
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
        footer: 'Skanna QR-koden från serverdashboarden eller ange koden manuellt. Den gäller i 15 minuter.',
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
          // The explicit button bypasses the breaker and the change probe:
          // someone watching a spinner wants the round trip actually made.
          const report = await syncNow();
          toast(
            report.ok
              ? summarise(report)
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
    case 'paused':
      return 'Pausad efter upprepade fel';
    default:
      return 'Inte parkopplad';
  }
}

// --- the server's own model -----------------------------------------------

/**
 * The companion server's local model, when it has one.
 *
 * Rendered only for a paired device whose server reports the feature: it is an
 * operator's setting, not a user's, and a server without it should not grow a
 * section explaining what it is missing.
 */
async function renderLocalModelSection(refresh: () => Promise<void>): Promise<HTMLElement | null> {
  const { sync: syncSettings } = getSettings();
  if (!syncSettings.serverUrl || !(await isPaired())) return null;

  let status: LlmStatusResponse;
  try {
    status = await llmStatus(syncSettings.serverUrl);
  } catch {
    // An older server has no such endpoint, and an unreachable one is the sync
    // section's problem to report, not this one's.
    return null;
  }
  if (!status.enabled) return null;

  const { runtime, queue } = status;
  const rows: HTMLElement[] = [
    row({
      label: 'Modell',
      icon: 'sparkles',
      iconColor: GLYPH.ai,
      value: runtime.model,
    }),
    row({ label: 'Status', trailing: modelStateBadge(runtime) }),
  ];

  if (runtime.state === 'pulling' && runtime.pull) {
    rows.push(row({ label: 'Laddar ner', value: `${runtime.pull.status} · ${runtime.pull.percent} %` }));
  }

  rows.push(
    row({
      label: 'Kö',
      value: `${queue.pending} väntar · ${queue.done} klara${queue.failed > 0 ? ` · ${queue.failed} misslyckade` : ''}`,
    }),
  );

  if (runtime.state === 'no-model') {
    rows.push(
      actionRow('Ladda ner modellen', async () => {
        await llmPull(syncSettings.serverUrl);
        toast('Nedladdningen startade. Den tar några minuter.', { kind: 'success' });
      }, refresh),
    );
  }

  if (runtime.state === 'ready') {
    rows.push(
      actionRow('Läs kvitton nu', async () => {
        const report = await llmScan(syncSettings.serverUrl);
        toast(
          report.blocked ??
            `${report.extracted} tolkade, ${report.skipped} överhoppade, ${report.failed} misslyckade.`,
          { kind: report.blocked ? 'error' : 'success' },
        );
        // The results arrive as ordinary changes, so a normal sync collects them.
        void syncNow();
      }, refresh),
    );
  }

  if (queue.failed > 0) {
    rows.push(
      actionRow('Försök misslyckade igen', async () => {
        const { requeued } = await llmRequeue(syncSettings.serverUrl);
        toast(`${requeued} kvitton lades tillbaka i kön.`, { kind: 'success' });
      }, refresh),
    );
  }

  return listGroup(
    {
      title: 'Lokal modell på servern',
      footer:
        runtime.state === 'missing'
          ? `Ollama hittades inte på servern${runtime.installHint ? `. Installera med: ${runtime.installHint}` : '.'}`
          : (runtime.detail ??
            'Servern läser synkade kvitton med en modell som körs lokalt — inget lämnar ditt ' +
              'nätverk. Resultatet kommer tillbaka med vanlig synkronisering, och det du själv ' +
              'har fyllt i skrivs aldrig över.'),
    },
    ...rows,
  );
}

function modelStateBadge(runtime: LlmStatusResponse['runtime']): HTMLElement {
  const [text, tone] = ((): [string, string] => {
    switch (runtime.state) {
      case 'ready':
        return [runtime.managed ? 'Redo (startad av servern)' : 'Redo', 'success'];
      case 'pulling':
        return ['Laddar ner modellen', 'warning'];
      case 'starting':
        return ['Startar', 'warning'];
      case 'no-model':
        return ['Modellen saknas', 'warning'];
      case 'missing':
        return ['Ollama saknas', 'danger'];
      default:
        return ['Avstängd', 'label-secondary'];
    }
  })();
  return el('span', { class: 'row__value', style: `color:var(--${tone})`, text });
}

/** A tappable row that runs an async action and refreshes the screen after. */
function actionRow(label: string, action: () => Promise<void>, refresh: () => Promise<void>): HTMLElement {
  return el('button', {
    class: 'row',
    type: 'button',
    style: 'color:var(--tint);justify-content:center',
    text: label,
    on: {
      click: async (event) => {
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        try {
          await action();
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
        } finally {
          button.disabled = false;
          await refresh();
        }
      },
    },
  });
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

function renderDeveloperSection(): HTMLElement {
  return listGroup(
    {
      title: 'Utvecklarinställningar',
      footer: 'Diagnostik för felsökning. Loggarna innehåller inte kvitton, bilder eller hemligheter.',
    },
    row({
      label: 'Debugglogg',
      value: 'Klient och server',
      icon: 'gear',
      iconColor: GLYPH.developer,
      onClick: () => router.navigate('/debug-log'),
    }),
    row({
      label: 'Sök efter uppdatering',
      value: 'Ny klientversion',
      icon: 'rotate',
      iconColor: GLYPH.developer,
      onClick: () => {
        void checkForAppUpdate()
          .then((result) => {
            if (result === 'current') toast('Du har den senaste versionen.', { kind: 'success' });
            if (result === 'unsupported') {
              toast('Uppdateringar hanteras inte av den här webbläsaren.', { kind: 'error' });
            }
          })
          .catch((error) => {
            toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
          });
      },
    }),
  );
}

/** One line describing what a completed pass actually did. */
function summarise(report: SyncReport): string {
  if (report.resynced) return 'Servern hade byggts om — allt synkades om från början.';
  if (report.skipped) return 'Allt var redan i synk.';

  const parts = [`${report.pushed} skickade`, `${report.pulled} hämtade`];
  if (report.merged > 0) parts.push(`${report.merged} sammanfogade`);
  if (report.blobsUploaded > 0) parts.push(`${report.blobsUploaded} bilder upp`);
  if (report.blobsDownloaded > 0) parts.push(`${report.blobsDownloaded} bilder ner`);
  return `Klart: ${parts.join(', ')}.`;
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
