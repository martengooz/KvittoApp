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
  const root = document.createElement('div');
  root.className = 'ai-settings-view';
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
      }));
    }
    if (options.onTest) rows.push(actionRow('Testa anslutningen', options.onTest));
  }

  const footer = ai.provider === 'none'
    ? 'Utan AI sparas kvitton som bilder och fylls i för hand.'
    : ai.provider === 'ollama'
      ? `Starta Ollama med OLLAMA_ORIGINS="${location.origin}" så att webbläsaren får anropa den.`
      : ai.provider === 'server'
        ? 'Servern håller nyckeln åt dig.'
        : 'Nyckeln synkroniseras mellan dina parkopplade enheter.';
  return listGroup('AI-tolkning', footer, rows);
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
    }),
    stackedRow('Extra instruktioner till modellen', textarea(ai.extraInstructions, (extraInstructions) => {
      void options.onChange({ extraInstructions });
    })),
  );
  return listGroup(
    'Avancerat',
    'Ett långt kvitto med många rader behöver fler tokens. JSON-schema ger stabilare svar och faller automatiskt tillbaka om modellen inte stödjer det.',
    rows,
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
  return listGroup('Lokal modell på servern', footer, rows);
}

function listGroup(title: string, footer: string, rows: HTMLElement[]): HTMLElement {
  return node('section', { className: 'list-group' },
    node('h2', { className: 'list-group__title', textContent: title }),
    node('div', { className: 'inset-list' }, ...rows),
    node('p', { className: 'list-group__footer', textContent: footer }),
  );
}

function fieldRow(label: string, control: HTMLElement): HTMLElement {
  return node('label', { className: 'row' }, node('span', { className: 'row__label', textContent: label }), control);
}

function valueRow(label: string, value: string): HTMLElement {
  return node('div', { className: 'row' },
    node('span', { className: 'row__label', textContent: label }),
    node('span', { className: 'row__value', textContent: value }),
  );
}

function stackedRow(label: string, control: HTMLElement): HTMLElement {
  return node('label', { className: 'row row--stacked' }, node('span', { className: 'row__label', textContent: label }), control);
}

function toggleRow(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const control = node('input', { className: 'switch toggle', type: 'checkbox', checked }) as HTMLInputElement;
  control.setAttribute('aria-label', label);
  control.addEventListener('change', () => onChange(control.checked));
  return fieldRow(label, control);
}

function actionRow(label: string, action: () => Promise<unknown>): HTMLElement {
  const button = node('button', { className: 'row', type: 'button', textContent: label }) as HTMLButtonElement;
  button.style.color = 'var(--tint)';
  button.style.justifyContent = 'center';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const message = await action();
      if (typeof message === 'string') button.textContent = message;
    } catch (error) {
      button.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function input(type: string, value: string, placeholder: string, onChange: (value: string) => void): HTMLInputElement {
  const control = node('input', { type, value, placeholder, autocomplete: 'off' }) as HTMLInputElement;
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
  const control = node('textarea', { value, rows: 2 }) as HTMLTextAreaElement;
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
  const control = node('select', {}) as HTMLSelectElement;
  control.setAttribute('aria-label', label);
  for (const option of options) {
    control.append(node('option', { value: option.value, textContent: option.label, selected: option.value === value }));
  }
  control.addEventListener('change', () => onChange(control.value));
  return control;
}

function datalist(id: string, values: string[]): HTMLDataListElement {
  return node('datalist', { id }, ...values.map((value) => node('option', { value }))) as HTMLDataListElement;
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

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Record<string, unknown>,
  ...children: Node[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) (element as unknown as Record<string, unknown>)[key] = value;
  }
  element.append(...children);
  return element;
}