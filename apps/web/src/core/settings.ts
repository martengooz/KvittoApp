/**
 * User settings, persisted in IndexedDB.
 *
 * Kept out of `localStorage` deliberately: the AI settings hold an API key, and
 * IndexedDB is the same origin-scoped store as the receipts themselves, so a
 * single "erase all data" action can reach everything. Settings are loaded once
 * at boot and cached in memory, so reads are synchronous everywhere else.
 */

import { db } from '../db/db.js';
import { bus } from './events.js';

/** Where extraction requests are sent. */
export type AiProvider =
  /** Anthropic's API, called directly from the device with the user's key. */
  | 'anthropic'
  /** OpenAI's API, called directly from the device. */
  | 'openai'
  /** Any OpenAI-compatible endpoint: OpenRouter, Groq, LM Studio, vLLM. */
  | 'openai-compatible'
  /** A local Ollama instance. */
  | 'ollama'
  /** The companion server, which holds the provider keys instead of the device. */
  | 'server'
  /** No AI. Receipts are stored as images and filled in by hand. */
  | 'none';

export interface AiSettings {
  provider: AiProvider;
  model: string;
  /** Base URL for `openai-compatible` and `ollama`. */
  baseUrl: string;
  /** Stored on this device only, and never included in sync payloads. */
  apiKey: string;
  maxOutputTokens: number;
  /**
   * Reasoning effort for providers that support it. `auto` omits the parameter,
   * which is the only safe default across models that reject it.
   */
  effort: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Ask the provider to constrain its output to the receipt JSON schema.
   * Falls back to prompt-only JSON automatically if the provider rejects it.
   */
  structuredOutput: boolean;
  /** Run extraction automatically after a scan, instead of on a button press. */
  autoParse: boolean;
  /** Appended to the system prompt. For store-specific quirks. */
  extraInstructions: string;
}

export interface ImageSettings {
  detectEdges: boolean;
  enhance: 'color' | 'grayscale' | 'binarize' | 'none';
  maxDimension: number;
  quality: number;
  /** Keep the untouched camera capture alongside the processed scan. */
  keepOriginal: boolean;
}

export interface SyncSettings {
  /** Companion server base URL, e.g. `https://kvitto.example.com`. */
  serverUrl: string;
  /** Sync automatically when online and after local changes. */
  autoSync: boolean;
  /** Upload receipt images too, not just the parsed data. */
  syncImages: boolean;
}

export interface UiSettings {
  theme: 'system' | 'light' | 'dark';
  /** Show discount and pant rows in the purchases list. */
  showAuxiliaryLines: boolean;
}

export interface AppSettings {
  ai: AiSettings;
  image: ImageSettings;
  sync: SyncSettings;
  ui: UiSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    provider: 'none',
    model: 'claude-opus-5',
    baseUrl: '',
    apiKey: '',
    maxOutputTokens: 16000,
    effort: 'auto',
    structuredOutput: true,
    autoParse: true,
    extraInstructions: '',
  },
  image: {
    detectEdges: true,
    enhance: 'grayscale',
    maxDimension: 1568,
    quality: 0.9,
    keepOriginal: false,
  },
  sync: {
    serverUrl: '',
    autoSync: true,
    syncImages: true,
  },
  ui: {
    theme: 'system',
    showAuxiliaryLines: false,
  },
};

/** Suggested models per provider, offered as a datalist rather than a hard list. */
export const MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini'],
  'openai-compatible': [],
  ollama: ['llama3.2-vision', 'qwen2.5vl', 'minicpm-v'],
  server: [],
  none: [],
};

/** Default endpoint per provider, filled in when the user switches provider. */
export const DEFAULT_BASE_URLS: Partial<Record<AiProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434',
};

const SETTINGS_KEY = 'settings';

let cached: AppSettings = structuredClone(DEFAULT_SETTINGS);
let loaded = false;

/** Loads settings from IndexedDB. Call once during boot. */
export async function loadSettings(): Promise<AppSettings> {
  const stored = await db.kv.get(SETTINGS_KEY);
  cached = merge(DEFAULT_SETTINGS, stored?.value);
  loaded = true;
  return cached;
}

/** The current settings. Returns defaults if called before {@link loadSettings}. */
export function getSettings(): AppSettings {
  if (!loaded) console.warn('getSettings() called before loadSettings(); using defaults.');
  return cached;
}

/** Merges a partial update into the stored settings and notifies listeners. */
export async function updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
  cached = merge(cached, patch);
  await db.kv.put({ key: SETTINGS_KEY, value: cached });
  bus.emit('settings:changed', {});
  return cached;
}

/**
 * Settings with secrets removed. Used anywhere settings might be logged,
 * exported or displayed — the API key must never leave the device by accident.
 */
export function redactSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    ai: { ...settings.ai, apiKey: settings.ai.apiKey ? '••••••••' : '' },
  };
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Recursively merges stored settings over the defaults.
 *
 * Going through the defaults means a settings object written by an older
 * version of the app gains any new keys instead of leaving them `undefined`,
 * and a corrupted value for one key cannot take the rest of the app down.
 */
function merge(base: AppSettings, patch: unknown): AppSettings {
  const result = structuredClone(base);
  if (!patch || typeof patch !== 'object') return result;

  for (const [section, values] of Object.entries(patch as Record<string, unknown>)) {
    if (!(section in result) || !values || typeof values !== 'object') continue;
    const target = result[section as keyof AppSettings] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (!(key in target) || value === undefined) continue;
      // Reject a stored value whose type drifted from the default's.
      if (typeof value !== typeof target[key]) continue;
      target[key] = value;
    }
  }
  return result;
}

/** True when the current configuration can actually run an extraction. */
export function isAiConfigured(settings: AppSettings = getSettings()): boolean {
  const { ai, sync } = settings;
  switch (ai.provider) {
    case 'none':
      return false;
    case 'server':
      return sync.serverUrl.trim().length > 0;
    case 'ollama':
      return ai.baseUrl.trim().length > 0 && ai.model.trim().length > 0;
    case 'anthropic':
    case 'openai':
    case 'openai-compatible':
      return ai.apiKey.trim().length > 0 && ai.model.trim().length > 0;
  }
}
