import { eq } from 'drizzle-orm';

import { config } from '../env.ts';
import { getDb, schema } from './index.ts';
import { readRecord } from './sync.ts';

export const SERVER_AI_PROVIDERS = ['none', 'anthropic', 'openai', 'openai-compatible'] as const;
export type ServerAiProvider = (typeof SERVER_AI_PROVIDERS)[number];
export const AI_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export interface ServerAiSettings {
  provider: ServerAiProvider;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  effort: AiEffort;
  structuredOutput: boolean;
  extraInstructions: string;
}

export interface ServerSettings {
  ai: ServerAiSettings;
}

export interface EffectiveAiSettings extends ServerAiSettings {
  apiKey: string;
  allowedModels: string[];
  enabled: boolean;
}

export function getServerSettings(accountId: string): ServerSettings {
  const defaults = defaultSettings();
  const row = getDb()
    .select({ payload: schema.serverSettings.payload })
    .from(schema.serverSettings)
    .where(eq(schema.serverSettings.accountId, accountId))
    .limit(1)
    .all()[0];
  if (!row) return defaults;

  try {
    return normalizeSettings(JSON.parse(row.payload), defaults);
  } catch {
    return defaults;
  }
}

export function saveServerSettings(accountId: string, settings: ServerSettings): ServerSettings {
  const normalized = normalizeSettings(settings, defaultSettings());
  getDb()
    .insert(schema.serverSettings)
    .values({ accountId, payload: JSON.stringify(normalized), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: schema.serverSettings.accountId,
      set: { payload: JSON.stringify(normalized), updatedAt: Date.now() },
    })
    .run();
  return normalized;
}

export function effectiveAiSettings(accountId: string): EffectiveAiSettings {
  const settings = getServerSettings(accountId).ai;
  const secret = readRecord(accountId, 'secrets', 'aiApiKey');
  const apiKey = secret?.deletedAt === 0 && secret.value ? secret.value : config.ai.apiKey;
  const allowedModels = config.ai.allowedModels.length > 0 ? config.ai.allowedModels : [settings.model];
  return {
    ...settings,
    apiKey,
    allowedModels,
    enabled: settings.provider !== 'none' && Boolean(apiKey),
  };
}

export function publicServerSettings(accountId: string) {
  const settings = getServerSettings(accountId);
  return {
    ai: {
      ...settings.ai,
      apiKeyConfigured: Boolean(effectiveAiSettings(accountId).apiKey),
    },
  };
}

function defaultSettings(): ServerSettings {
  const provider = SERVER_AI_PROVIDERS.includes(config.ai.provider as ServerAiProvider)
    ? (config.ai.provider as ServerAiProvider)
    : 'none';
  return {
    ai: {
      provider,
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
      maxOutputTokens: config.ai.maxOutputTokens,
      effort: 'auto',
      structuredOutput: true,
      extraInstructions: '',
    },
  };
}

function normalizeSettings(value: unknown, defaults: ServerSettings): ServerSettings {
  if (!value || typeof value !== 'object') return defaults;
  const ai = (value as { ai?: unknown }).ai;
  if (!ai || typeof ai !== 'object') return defaults;
  const candidate = ai as Partial<ServerAiSettings>;
  return {
    ai: {
      provider: SERVER_AI_PROVIDERS.includes(candidate.provider as ServerAiProvider)
        ? (candidate.provider as ServerAiProvider)
        : defaults.ai.provider,
      model: typeof candidate.model === 'string' && candidate.model ? candidate.model : defaults.ai.model,
      baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : defaults.ai.baseUrl,
      maxOutputTokens:
        typeof candidate.maxOutputTokens === 'number' &&
        Number.isInteger(candidate.maxOutputTokens) &&
        candidate.maxOutputTokens >= 1_000 &&
        candidate.maxOutputTokens <= 128_000
          ? candidate.maxOutputTokens
          : defaults.ai.maxOutputTokens,
      effort: AI_EFFORTS.includes(candidate.effort as AiEffort)
        ? (candidate.effort as AiEffort)
        : defaults.ai.effort,
      structuredOutput:
        typeof candidate.structuredOutput === 'boolean'
          ? candidate.structuredOutput
          : defaults.ai.structuredOutput,
      extraInstructions:
        typeof candidate.extraInstructions === 'string'
          ? candidate.extraInstructions.slice(0, 2_000)
          : defaults.ai.extraInstructions,
    },
  };
}