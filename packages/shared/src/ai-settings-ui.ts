import { el } from './dom.js';
import { actionRow, fieldRow, listGroup, stackedRow, toggleRow, valueRow } from './ui-rows.js';

export type AiSettingsProvider =
  | 'none'
  | 'anthropic'
  | 'openai'
  | 'openai-compatible'
  | 'ollama'
  | 'server';

export type AiEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SharedAiSettings {
  provider: AiSettingsProvider;
  model: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyConfigured?: boolean;
  maxOutputTokens: number;
  effort: AiEffort;
  structuredOutput: boolean;
  autoParse?: boolean;
  extraInstructions: string;
}

export interface SharedLocalModelStatus {
  enabled: boolean;
  runtime: {
    state: 'off' | 'missing' | 'starting' | 'no-model' | 'pulling' | 'ready';
    model: string;
    managed: boolean;
    pull: { status: string; percent: number } | null;
    detail: string | null;
    installHint: string | null;
  };
  queue: { pending: number; running: number; done: number; failed: number };
}

export interface AiSettingsViewOptions {
  ai: SharedAiSettings;
  providers?: AiSettingsProvider[];
  localModel?: SharedLocalModelStatus | null;
  onChange: (patch: Partial<SharedAiSettings>) => void | Promise<void>;
  onTest?: () => Promise<{ ok: boolean; message: string }>;
  onLocalAction?: (action: 'start' | 'pull' | 'scan' | 'requeue') => Promise<string | void>;
}

export const AI_PROVIDER_LABELS: Record<AiSettingsProvider, string> = {
  none: 'Ingen',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-kompatibel',
  ollama: 'Ollama (lokalt)',
  server: 'Min egen server',
};

export const AI_MODEL_SUGGESTIONS: Record<AiSettingsProvider, string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  'openai-compatible': [],
  ollama: ['llama3.2-vision', 'qwen2.5vl', 'minicpm-v'],
  server: [],
  none: [],
};

export const AI_DEFAULT_BASE_URLS: Partial<Record<AiSettingsProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434',
};

export function createAiSettingsView(options: AiSettingsViewOptions): HTMLElement {
  const root = el('div', { class: 'ai-settings-view' });
  root.append(renderProviderSettings(options));
  if (options.ai.provider !== 'none') root.append(renderAdvancedSettings(options));
  if (options.localModel) root.append(renderLocalModel(options.localModel, options.onLocalAction));
  return root;
}

function renderProviderSettings(options: AiSettingsViewOptions): HTMLElement {
  const { ai } = options;
  const providers = options.providers ?? Object.keys(AI_PROVIDER_LABELS) as AiSettingsProvider[];
  const rows: HTMLElement[] = [
    fieldRow(
      'Leverantör',
      select(
        'AI-leverantör',
        providers.map((provider) => ({ value: provider, label: AI_PROVIDER_LABELS[provider] })),
        ai.provider,
        (provider) => {
          const selected = provider as AiSettingsProvider;
          void options.onChange({
            provider: selected,
            baseUrl: AI_DEFAULT_BASE_URLS[selected] ?? '',
            model: AI_MODEL_SUGGESTIONS[selected][0] ?? ai.model,
          });
        },
      ),
    ),
  ];

  if (ai.provider !== 'none') {
    const needsBaseUrl = ai.provider === 'openai-compatible' || ai.provider === 'ollama' || ai.provider === 'openai';
    const needsKey = ai.provider === 'anthropic' || ai.provider === 'openai' || ai.provider === 'openai-compatible';
    if (needsBaseUrl) {
      rows.push(fieldRow('Adress', input('url', ai.baseUrl, AI_DEFAULT_BASE_URLS[ai.provider] ?? '', (baseUrl) => {
        void options.onChange({ baseUrl: baseUrl.trim() });
      })));
    }
    if (needsKey) {
      rows.push(fieldRow('API-nyckel', input(
        'password',
        ai.apiKey ?? '',
        ai.apiKeyConfigured ? 'Sparad' : 'Krävs',
        (apiKey) => void options.onChange({ apiKey: apiKey.trim() }),
      )));
    }
    const suggestions = AI_MODEL_SUGGESTIONS[ai.provider];
    const modelInput = input('text', ai.model, suggestions[0] ?? 'modellnamn', (model) => {
      void options.onChange({ model: model.trim() });
    });
    if (suggestions.length) {
      const listId = `ai-model-suggestions-${ai.provider}`;
      modelInput.setAttribute('list', listId);
      rows.push(fieldRow('Modell', modelInput), datalist(listId, suggestions));
    } else {
      rows.push(fieldRow('Modell', modelInput));
    }
    if (typeof ai.autoParse === 'boolean') {
      rows.push(toggleRow('Tolka direkt efter skanning', ai.autoParse, (autoParse) => {
        void options.onChange({ autoParse });
      }, 'switch toggle'));
    }
    if (options.onTest) rows.push(actionRow('Testa anslutningen', options.onTest, 'Testar…'));
  }

  const footer = ai.provider === 'none'
    ? 'Utan AI sparas kvitton som bilder och fylls i för hand.'
    : ai.provider === 'ollama'
      ? `Starta Ollama med OLLAMA_ORIGINS="${location.origin}" så att webbläsaren får anropa den.`
      : ai.provider === 'server'
        ? 'Servern håller nyckeln åt dig.'
        : 'Nyckeln synkroniseras mellan dina parkopplade enheter.';
  return listGroup({ title: 'AI-tolkning', footer }, ...rows);
}

function renderAdvancedSettings(options: AiSettingsViewOptions): HTMLElement {
  const { ai } = options;
  const rows: HTMLElement[] = [
    fieldRow('Max tokens', numberInput(ai.maxOutputTokens, (maxOutputTokens) => {
      void options.onChange({ maxOutputTokens });
    })),
  ];
  if (ai.provider === 'anthropic') {
    rows.push(fieldRow('Tankedjup', select(
      'Tankedjup',
      (['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((effort) => ({
        value: effort,
        label: effort === 'auto' ? 'Standard' : effort,
      })),
      ai.effort,
      (effort) => void options.onChange({ effort: effort as AiEffort }),
    )));
  }
  rows.push(
    toggleRow('Tvinga JSON-schema', ai.structuredOutput, (structuredOutput) => {
      void options.onChange({ structuredOutput });
    }, 'switch toggle'),
    stackedRow('Extra instruktioner till modellen', textarea(ai.extraInstructions, (extraInstructions) => {
      void options.onChange({ extraInstructions });
    })),
  );
  return listGroup(
    {
      title: 'Avancerat',
      footer: 'Ett långt kvitto med många rader behöver fler tokens. JSON-schema ger stabilare svar och faller automatiskt tillbaka om modellen inte stödjer det.',
    },
    ...rows,
  );
}

function renderLocalModel(
  status: SharedLocalModelStatus,
  onAction?: AiSettingsViewOptions['onLocalAction'],
): HTMLElement {
  const { runtime, queue } = status;
  const rows: HTMLElement[] = [
    valueRow('Modell', runtime.model),
    valueRow('Status', localModelState(runtime)),
  ];
  if (runtime.state === 'pulling' && runtime.pull) {
    rows.push(valueRow('Laddar ner', `${runtime.pull.status} · ${runtime.pull.percent} %`));
  }
  rows.push(valueRow(
    'Kö',
    `${queue.pending} väntar · ${queue.running} bearbetas · ${queue.done} klara${queue.failed ? ` · ${queue.failed} misslyckade` : ''}`,
  ));
  if (onAction && status.enabled) {
    if (runtime.state === 'off' || runtime.state === 'missing') rows.push(actionRow('Starta', () => onAction('start')));
    if (runtime.state === 'no-model') rows.push(actionRow('Ladda ner modellen', () => onAction('pull')));
    if (runtime.state === 'ready') rows.push(actionRow('Läs kvitton nu', () => onAction('scan')));
    if (queue.failed > 0) rows.push(actionRow('Försök misslyckade igen', () => onAction('requeue')));
  }
  const footer = !status.enabled
    ? 'Den lokala modellen är avstängd på servern.'
    : runtime.state === 'missing'
      ? `Ollama hittades inte på servern${runtime.installHint ? `. Installera med: ${runtime.installHint}` : '.'}`
      : runtime.detail ?? 'Servern läser synkade kvitton lokalt. Inget lämnar ditt nätverk.';
  return listGroup({ title: 'Lokal modell på servern', footer }, ...rows);
}

function input(type: string, value: string, placeholder: string, onChange: (value: string) => void): HTMLInputElement {
  const control = el('input', { type, value, placeholder, autocomplete: 'off' });
  control.addEventListener('change', () => onChange(control.value));
  return control;
}

function numberInput(value: number, onChange: (value: number) => void): HTMLInputElement {
  const control = input('number', String(value), '', (raw) => {
    const next = Number(raw);
    if (Number.isInteger(next) && next >= 1_000 && next <= 128_000) onChange(next);
  });
  control.min = '1000';
  control.max = '128000';
  control.step = '1000';
  return control;
}

function textarea(value: string, onChange: (value: string) => void): HTMLTextAreaElement {
  const control = el('textarea', { value, rows: 2 });
  control.placeholder = 'T.ex. "Min lokala butik skriver pant som PANT+".';
  control.addEventListener('change', () => onChange(control.value));
  return control;
}

function select(
  label: string,
  options: { value: string; label: string }[],
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const control = el('select', { 'aria-label': label });
  for (const option of options) {
    control.append(el('option', { value: option.value, text: option.label, selected: option.value === value }));
  }
  control.addEventListener('change', () => onChange(control.value));
  return control;
}

function datalist(id: string, values: string[]): HTMLDataListElement {
  return el('datalist', { id }, ...values.map((value) => el('option', { value })));
}

function localModelState(runtime: SharedLocalModelStatus['runtime']): string {
  switch (runtime.state) {
    case 'ready': return runtime.managed ? 'Redo (startad av servern)' : 'Redo';
    case 'pulling': return 'Laddar ner modellen';
    case 'starting': return 'Startar';
    case 'no-model': return 'Modellen saknas';
    case 'missing': return 'Ollama saknas';
    default: return 'Avstängd';
  }
}