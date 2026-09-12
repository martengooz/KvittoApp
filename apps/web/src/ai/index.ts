/**
 * Entry point for receipt extraction: picks a provider, runs it, and records
 * the outcome on the receipt.
 */

import { validateExtraction, type NormalizedExtraction } from '@kvitto/shared';

import { getSettings, isAiConfigured, type AiProvider } from '../core/settings.js';
import { db } from '../db/db.js';
import { getBlob } from '../db/blobs.js';
import { applyExtraction, updateReceipt } from '../db/repo.js';
import { getDeviceToken } from '../sync/identity.js';

import { anthropicProvider } from './providers/anthropic.js';
import { ollamaProvider } from './providers/ollama.js';
import { openaiCompatibleProvider, openaiProvider } from './providers/openai.js';
import { serverProvider } from './providers/server.js';
import { ExtractionError, type ExtractionResponse, type Provider, type TestResult } from './types.js';

export { ExtractionError } from './types.js';
export type { ExtractionResponse, TestResult } from './types.js';

const PROVIDERS: Record<Exclude<AiProvider, 'none'>, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  'openai-compatible': openaiCompatibleProvider,
  ollama: ollamaProvider,
  server: serverProvider,
};

export function getProvider(id: AiProvider): Provider | null {
  return id === 'none' ? null : PROVIDERS[id];
}

/** Verifies the current AI configuration without spending a real extraction. */
export async function testConnection(): Promise<TestResult> {
  const settings = getSettings();
  const provider = getProvider(settings.ai.provider);
  if (!provider) return { ok: false, message: 'Ingen AI-leverantör vald.' };

  return provider.test({
    settings: settings.ai,
    serverUrl: settings.sync.serverUrl,
    serverToken: (await getDeviceToken()) ?? undefined,
  });
}

export interface ParseOutcome {
  ok: boolean;
  extraction: NormalizedExtraction | null;
  response: ExtractionResponse | null;
  /** Warnings from normalisation plus issues from arithmetic validation. */
  warnings: string[];
  error: string | null;
}

/**
 * Runs extraction for a stored receipt and writes the result back.
 *
 * Failures are recorded on the receipt (`status: 'failed'`) rather than thrown,
 * because the scan itself is still valuable: the image is saved, and the user
 * can retry, switch provider, or fill the receipt in by hand.
 */
export async function parseReceipt(
  receiptId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ParseOutcome> {
  const settings = getSettings();
  const provider = getProvider(settings.ai.provider);

  if (!provider || !isAiConfigured(settings)) {
    return {
      ok: false,
      extraction: null,
      response: null,
      warnings: [],
      error: 'AI-tolkning är inte konfigurerad. Ställ in en leverantör under Inställningar.',
    };
  }

  const receipt = await db.receipts.get(receiptId);
  if (!receipt) {
    return { ok: false, extraction: null, response: null, warnings: [], error: 'Kvittot finns inte.' };
  }

  const stored = await getBlob(receipt.imageId);
  if (!stored) {
    return {
      ok: false,
      extraction: null,
      response: null,
      warnings: [],
      error: 'Kvittobilden saknas på den här enheten.',
    };
  }

  await updateReceipt(receiptId, { status: 'processing' });

  try {
    const response = await provider.extract({
      image: stored.data,
      settings: settings.ai,
      serverUrl: settings.sync.serverUrl,
      serverToken: (await getDeviceToken()) ?? undefined,
      signal: options.signal,
    });

    const report = validateExtraction(response.extraction);
    const warnings = [
      ...response.extraction.warnings,
      ...report.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message),
    ];
    if (response.structuredOutputFallback) {
      warnings.push('Leverantören stödde inte JSON-schema; tolkningen kördes utan schemakontroll.');
    }

    await applyExtraction(receiptId, response.extraction, {
      provider: response.provider,
      model: response.model,
      at: Date.now(),
      durationMs: response.durationMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      warnings,
      error: null,
    });

    return { ok: true, extraction: response.extraction, response, warnings, error: null };
  } catch (error) {
    const message =
      error instanceof ExtractionError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    await updateReceipt(receiptId, {
      status: 'failed',
      extraction: {
        provider: settings.ai.provider,
        model: settings.ai.model,
        at: Date.now(),
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        warnings: [],
        error: message,
      },
    });
    return { ok: false, extraction: null, response: null, warnings: [], error: message };
  }
}
