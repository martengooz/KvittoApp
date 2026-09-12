/**
 * Settings: AI provider, image pipeline, sync pairing, storage.
 *
 * The AI section is the one the user is most likely to get wrong, so it has a
 * "test connection" button that reports exactly what failed rather than leaving
 * them to discover it on their next scan.
 */

import { formatBytes, formatRelativeTime } from '@kvitto/shared';

import { appendChildren, el, replaceChildren } from '../core/dom.js';
import { bus } from '../core/events.js';
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
  none: 'Ingen — fyll i själv',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-kompatibel (OpenRouter, Groq, LM Studio…)',
  ollama: 'Ollama (lokalt)',
  server: 'Via min egen server',
};

export async function settingsView(): Promise<HTMLElement> {
  const root = el('div', {});

  const unsubscribe = bus.on('settings:changed', () => void refresh());
  router.onTeardown(unsubscribe);

  async function refresh(): Promise<void> {
    replaceChildren(
      root,
      await renderAiSection(refresh),
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

// --- AI -------------------------------------------------------------------

async function renderAiSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const { ai } = getSettings();
  const statusHost = el('div', { class: 'status-line' });
  const suggestions = MODEL_SUGGESTIONS[ai.provider];
  const needsKey = ai.provider === 'anthropic' || ai.provider === 'openai' || ai.provider === 'openai-compatible';
  const needsBaseUrl = ai.provider === 'openai-compatible' || ai.provider === 'ollama' || ai.provider === 'openai';

  const section = el(
    'section',
    { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: 'AI-tolkning' }),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: 'Leverantör' }),
      el(
        'select',
        {
          on: {
            change: (event) => {
              const provider = (event.target as HTMLSelectElement).value as AiProvider;
              void updateSettings({
                ai: {
                  provider,
                  // Pre-fill the endpoint so the user is not left staring at a
                  // blank field wondering what shape the URL should take.
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
    ),
  );

  if (ai.provider === 'none') {
    section.appendChild(
      el('p', { class: 'field__hint', text: 'Kvitton sparas som bilder och fylls i för hand.' }),
    );
    return section;
  }

  if (needsBaseUrl) {
    section.appendChild(
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field__label', text: 'Bas-URL' }),
        el('input', {
          type: 'url',
          value: ai.baseUrl,
          placeholder: DEFAULT_BASE_URLS[ai.provider] ?? '',
          on: {
            change: (event) => {
              void updateSettings({ ai: { baseUrl: (event.target as HTMLInputElement).value.trim() } });
            },
          },
        }),
        ai.provider === 'ollama'
          ? el('p', {
              class: 'field__hint',
              text:
                `Starta Ollama med OLLAMA_ORIGINS="${location.origin}" så att webbläsaren ` +
                'får anropa den.',
            })
          : null,
      ),
    );
  }

  if (needsKey) {
    section.appendChild(
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field__label', text: 'API-nyckel' }),
        el('input', {
          type: 'password',
          value: ai.apiKey,
          autocomplete: 'off',
          placeholder: 'sk-…',
          on: {
            change: (event) => {
              void updateSettings({ ai: { apiKey: (event.target as HTMLInputElement).value.trim() } });
            },
          },
        }),
        el('p', {
          class: 'field__hint',
          text:
            'Nyckeln sparas bara på den här enheten och skickas aldrig till någon annan än ' +
            'leverantören. Vill du hellre slippa ha den i telefonen — välj "Via min egen server".',
        }),
      ),
    );
  }

  const modelInput = el('input', {
    type: 'text',
    value: ai.model,
    list: suggestions.length ? 'model-suggestions' : undefined,
    placeholder: suggestions[0] ?? 'modellnamn',
    on: {
      change: (event) => {
        void updateSettings({ ai: { model: (event.target as HTMLInputElement).value.trim() } });
      },
    },
  });

  section.appendChild(
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: 'Modell' }),
      modelInput,
      suggestions.length
        ? el(
            'datalist',
            { id: 'model-suggestions' },
            ...suggestions.map((model) => el('option', { value: model })),
          )
        : null,
    ),
  );

  section.appendChild(
    el(
      'details',
      {},
      el('summary', { class: 'field__label', style: 'cursor:pointer', text: 'Avancerat' }),
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field__label', text: 'Max tokens i svaret' }),
        el('input', {
          type: 'number',
          min: 1000,
          max: 128000,
          step: 1000,
          value: String(ai.maxOutputTokens),
          on: {
            change: (event) => {
              const value = Number((event.target as HTMLInputElement).value);
              if (Number.isFinite(value) && value > 0) {
                void updateSettings({ ai: { maxOutputTokens: Math.round(value) } });
              }
            },
          },
        }),
        el('p', {
          class: 'field__hint',
          text: 'Ett långt kvitto med många rader behöver mer utrymme. Höj om tolkningen klipps av.',
        }),
      ),
      ai.provider === 'anthropic'
        ? el(
            'label',
            { class: 'field' },
            el('span', { class: 'field__label', text: 'Tankedjup (effort)' }),
            el(
              'select',
              {
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
                  text: value === 'auto' ? 'Modellens standard' : value,
                  selected: ai.effort === value,
                }),
              ),
            ),
            el('p', {
              class: 'field__hint',
              text: 'Lägre nivå går fortare och kostar mindre. Alla modeller stödjer inte inställningen — "Modellens standard" utelämnar den.',
            }),
          )
        : null,
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: ai.structuredOutput,
          on: {
            change: (event) => {
              void updateSettings({ ai: { structuredOutput: (event.target as HTMLInputElement).checked } });
            },
          },
        }),
        el(
          'span',
          {},
          el('strong', { text: 'Tvinga JSON-schema' }),
          el('p', {
            class: 'field__hint',
            text: 'Ger stabilare svar. Faller automatiskt tillbaka om modellen inte stödjer det.',
          }),
        ),
      ),
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: ai.autoParse,
          on: {
            change: (event) => {
              void updateSettings({ ai: { autoParse: (event.target as HTMLInputElement).checked } });
            },
          },
        }),
        el('span', {}, el('strong', { text: 'Tolka direkt efter skanning' })),
      ),
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field__label', text: 'Extra instruktioner till modellen' }),
        el('textarea', {
          value: ai.extraInstructions,
          placeholder: 'T.ex. "Min lokala butik skriver pant som PANT+".',
          on: {
            change: (event) => {
              void updateSettings({
                ai: { extraInstructions: (event.target as HTMLTextAreaElement).value },
              });
            },
          },
        }),
      ),
    ),
  );

  const testButton = el('button', {
    class: 'btn btn--ghost btn--block',
    type: 'button',
    text: 'Testa anslutningen',
    on: {
      click: async () => {
        testButton.disabled = true;
        replaceChildren(
          statusHost,
          el('span', { class: 'status-dot status-dot--busy' }),
          el('span', { text: 'Testar…' }),
        );
        const result = await testConnection();
        replaceChildren(
          statusHost,
          el('span', { class: ['status-dot', result.ok ? 'status-dot--ok' : 'status-dot--error'] }),
          el('span', { text: result.message }),
        );
        testButton.disabled = false;
        void refresh;
      },
    },
  });

  appendChildren(section, testButton, statusHost);
  return section;
}

// --- image ----------------------------------------------------------------

function renderImageSection(): HTMLElement {
  const { image } = getSettings();
  const cv = cvClient.status;

  return el(
    'section',
    { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: 'Bildbehandling' }),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: 'Efterbehandling' }),
      el(
        'select',
        {
          on: {
            change: (event) => {
              void updateSettings({
                image: { enhance: (event.target as HTMLSelectElement).value as typeof image.enhance },
              });
            },
          },
        },
        el('option', { value: 'grayscale', text: 'Gråskala (rekommenderas)', selected: image.enhance === 'grayscale' }),
        el('option', { value: 'color', text: 'Färg', selected: image.enhance === 'color' }),
        el('option', { value: 'binarize', text: 'Svartvitt', selected: image.enhance === 'binarize' }),
        el('option', { value: 'none', text: 'Ingen', selected: image.enhance === 'none' }),
      ),
      el('p', {
        class: 'field__hint',
        text:
          'Gråskala jämnar ut skuggor och höjer kontrasten utan att kasta bort svag ' +
          'termoutskrift — det är oftast vad AI-modellen läser bäst. Svartvitt ger minsta ' +
          'filer men tappar bleka rader.',
      }),
    ),
    el(
      'label',
      { class: 'checkbox' },
      el('input', {
        type: 'checkbox',
        checked: image.detectEdges,
        on: {
          change: (event) => {
            void updateSettings({ image: { detectEdges: (event.target as HTMLInputElement).checked } });
          },
        },
      }),
      el(
        'span',
        {},
        el('strong', { text: 'Hitta kvittots kanter automatiskt' }),
        el('p', { class: 'field__hint', text: 'Beskär och rätar ut kvittot. Du kan alltid justera hörnen själv.' }),
      ),
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: `Maxstorlek: ${image.maxDimension} px` }),
      el('input', {
        type: 'range',
        min: 800,
        max: 3000,
        step: 128,
        value: String(image.maxDimension),
        on: {
          change: (event) => {
            void updateSettings({
              image: { maxDimension: Number((event.target as HTMLInputElement).value) },
            });
          },
        },
      }),
      el('p', {
        class: 'field__hint',
        text: '1568 px räcker för de flesta modeller och håller nere kostnad och väntetid.',
      }),
    ),
    el(
      'label',
      { class: 'checkbox' },
      el('input', {
        type: 'checkbox',
        checked: image.keepOriginal,
        on: {
          change: (event) => {
            void updateSettings({ image: { keepOriginal: (event.target as HTMLInputElement).checked } });
          },
        },
      }),
      el(
        'span',
        {},
        el('strong', { text: 'Spara originalbilden' }),
        el('p', { class: 'field__hint', text: 'Låter dig beskära om senare, men tar betydligt mer plats.' }),
      ),
    ),
    el(
      'div',
      { class: 'status-line' },
      el('span', { class: ['status-dot', cv.ready ? 'status-dot--ok' : 'status-dot--warn'] }),
      el('span', {
        text: cv.ready
          ? `OpenCV ${cv.version ?? ''} laddad — bildbehandling fungerar offline`.trim()
          : 'OpenCV laddas vid första skanningen (≈11 MB, sparas sedan offline)',
      }),
    ),
    cv.ready
      ? null
      : el('button', {
          class: 'btn btn--ghost btn--block',
          type: 'button',
          text: 'Ladda ner nu för offline-bruk',
          on: {
            click: async (event) => {
              const button = event.currentTarget as HTMLButtonElement;
              button.disabled = true;
              button.textContent = 'Laddar ner…';
              const ok = await cvClient.warmup();
              toast(ok ? 'OpenCV är nu tillgängligt offline.' : 'Nedladdningen misslyckades.', {
                kind: ok ? 'success' : 'error',
              });
              button.disabled = false;
              button.textContent = 'Ladda ner nu för offline-bruk';
            },
          },
        }),
  );
}

// --- sync -----------------------------------------------------------------

async function renderSyncSection(refresh: () => Promise<void>): Promise<HTMLElement> {
  const { sync: syncSettings } = getSettings();
  const paired = await isPaired();
  const state = await getSyncState();
  const deviceName = await getDeviceName();
  const accountId = await getAccountId();

  const section = el(
    'section',
    { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: 'Synkronisering' }),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: 'Serveradress' }),
      el('input', {
        type: 'url',
        value: syncSettings.serverUrl,
        placeholder: 'https://kvitto.example.com',
        on: {
          change: (event) => {
            void updateSettings({
              sync: { serverUrl: (event.target as HTMLInputElement).value.trim().replace(/\/+$/, '') },
            });
          },
        },
      }),
    ),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: 'Enhetens namn' }),
      el('input', {
        type: 'text',
        value: deviceName,
        on: {
          change: (event) => {
            void setDeviceName((event.target as HTMLInputElement).value);
          },
        },
      }),
    ),
  );

  if (!paired) {
    const codeInput = el('input', {
      type: 'text',
      placeholder: 'ABC-DEF-GHJ',
      autocapitalize: 'characters',
      'aria-label': 'Parkopplingskod',
    });

    appendChildren(
      section,
      el(
        'label',
        { class: 'field' },
        el('span', { class: 'field__label', text: 'Parkopplingskod' }),
        codeInput,
        el('p', {
          class: 'field__hint',
          text: 'Kör "npm run pair" på servern för att skapa en kod. Den gäller i 15 minuter.',
        }),
      ),
      el('button', {
        class: 'btn btn--primary btn--block',
        type: 'button',
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
    return section;
  }

  const pending = await countPending();
  appendChildren(
    section,
    el(
      'div',
      { class: 'status-line' },
      el('span', { class: ['status-dot', statusDotClass(state.status)] }),
      el('span', {
        text:
          `${statusLabel(state.status)} · senast ${formatRelativeTime(state.lastSuccess)}` +
          (pending > 0 ? ` · ${pending} ändringar väntar` : ''),
      }),
    ),
    accountId ? el('p', { class: 'faint', text: `Konto ${accountId.slice(0, 8)}…` }) : null,
    el(
      'label',
      { class: 'checkbox' },
      el('input', {
        type: 'checkbox',
        checked: syncSettings.autoSync,
        on: {
          change: (event) => {
            void updateSettings({ sync: { autoSync: (event.target as HTMLInputElement).checked } });
          },
        },
      }),
      el('span', {}, el('strong', { text: 'Synka automatiskt' })),
    ),
    el(
      'label',
      { class: 'checkbox' },
      el('input', {
        type: 'checkbox',
        checked: syncSettings.syncImages,
        on: {
          change: (event) => {
            void updateSettings({ sync: { syncImages: (event.target as HTMLInputElement).checked } });
          },
        },
      }),
      el(
        'span',
        {},
        el('strong', { text: 'Synka även bilder' }),
        el('p', { class: 'field__hint', text: 'Stäng av för att spara mobildata; texten synkas ändå.' }),
      ),
    ),
    el(
      'div',
      { class: 'row' },
      el('button', {
        class: 'btn btn--primary grow',
        type: 'button',
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
        class: 'btn btn--ghost',
        type: 'button',
        text: 'Testa',
        on: {
          click: async () => {
            try {
              const info = await whoAmI(getSettings().sync.serverUrl);
              toast(`Ansluten som ${info.deviceName}.`, { kind: 'success' });
            } catch (error) {
              toast(error instanceof Error ? error.message : String(error), { kind: 'error' });
            }
          },
        },
      }),
    ),
    el('button', {
      class: 'btn btn--ghost btn--block',
      type: 'button',
      style: 'margin-top:0.5rem',
      text: 'Koppla från servern',
      on: {
        click: async () => {
          const confirmed = await confirmDialog({
            title: 'Koppla från?',
            message:
              'Dina kvitton ligger kvar på enheten. Nästa gång du parkopplar laddas hela ' +
              'arkivet upp igen.',
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
  return section;
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'idle':
      return 'status-dot--ok';
    case 'syncing':
      return 'status-dot--busy';
    case 'error':
      return 'status-dot--error';
    default:
      return 'status-dot--warn';
  }
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
  const usedFraction = estimate ? Math.min(1, estimate.usage / estimate.quota) : 0;

  return el(
    'section',
    { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: 'Lagring' }),
    estimate
      ? el(
          'div',
          {},
          el('div', { class: 'progress' }, el('div', { class: 'progress__bar', style: `width:${usedFraction * 100}%` })),
          el('p', {
            class: 'field__hint',
            text: `${formatBytes(estimate.usage)} av ${formatBytes(estimate.quota)} använt · ${blobs.count} bilder (${formatBytes(blobs.bytes)})`,
          }),
        )
      : el('p', { class: 'field__hint', text: `${blobs.count} bilder (${formatBytes(blobs.bytes)})` }),
    el(
      'div',
      { class: 'status-line' },
      el('span', { class: ['status-dot', persisted ? 'status-dot--ok' : 'status-dot--warn'] }),
      el('span', {
        text: persisted
          ? 'Lagringen är permanent — webbläsaren rensar den inte automatiskt.'
          : 'Webbläsaren kan rensa data vid platsbrist.',
      }),
    ),
    persisted
      ? null
      : el('button', {
          class: 'btn btn--ghost btn--block',
          type: 'button',
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
    el('button', {
      class: 'btn btn--ghost btn--block',
      type: 'button',
      style: 'margin-top:0.5rem',
      text: 'Frigör utrymme (ta bort originalbilder)',
      on: {
        click: async () => {
          const [originals, orphans, tombstones] = [
            await discardOriginals(),
            await collectGarbage(),
            await purgeTombstones(),
          ];
          toast(
            `Frigjorde ${formatBytes(originals.bytes + orphans.bytes)} · ` +
              `${tombstones} borttagna poster rensade.`,
            { kind: 'success' },
          );
          await refresh();
        },
      },
    }),
    el('button', {
      class: 'btn btn--ghost btn--block',
      type: 'button',
      style: 'margin-top:0.5rem;color:var(--danger)',
      text: 'Radera all data',
      on: {
        click: async () => {
          const confirmed = await confirmDialog({
            title: 'Radera allt?',
            message:
              'Alla kvitton, varor, etiketter och bilder på den här enheten tas bort. ' +
              'Det går inte att ångra.',
            confirmLabel: 'Radera allt',
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
}

// --- appearance -----------------------------------------------------------

function renderAppearanceSection(): HTMLElement {
  const { ui } = getSettings();
  return el(
    'section',
    { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: 'Utseende' }),
    el(
      'label',
      { class: 'field' },
      el('span', { class: 'field__label', text: 'Tema' }),
      el(
        'select',
        {
          on: {
            change: (event) => {
              void updateSettings({
                ui: { theme: (event.target as HTMLSelectElement).value as typeof ui.theme },
              });
            },
          },
        },
        el('option', { value: 'system', text: 'Följ systemet', selected: ui.theme === 'system' }),
        el('option', { value: 'light', text: 'Ljust', selected: ui.theme === 'light' }),
        el('option', { value: 'dark', text: 'Mörkt', selected: ui.theme === 'dark' }),
      ),
    ),
    el(
      'label',
      { class: 'checkbox' },
      el('input', {
        type: 'checkbox',
        checked: ui.showAuxiliaryLines,
        on: {
          change: (event) => {
            void updateSettings({
              ui: { showAuxiliaryLines: (event.target as HTMLInputElement).checked },
            });
          },
        },
      }),
      el('span', {}, el('strong', { text: 'Visa rabatt- och pantrader som standard' })),
    ),
  );
}

function renderAbout(): HTMLElement {
  return el(
    'section',
    { class: 'settings-group' },
    el('h2', { class: 'settings-group__title', text: 'Om' }),
    el('p', {
      class: 'field__hint',
      text:
        'KvittoApp fungerar helt offline. Kvitton, bilder och inställningar ligger bara på ' +
        'den här enheten tills du väljer att synka dem till din egen server.',
    }),
  );
}
