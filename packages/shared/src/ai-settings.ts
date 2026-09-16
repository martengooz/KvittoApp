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
