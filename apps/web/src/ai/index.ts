/**
 * Entry point for receipt extraction: picks a provider, runs it, and records
 * the outcome on the receipt.
 */

import { validateExtraction, type NormalizedExtraction } from '@kvitto/shared';

import { bus } from '../core/events.js';
import { getSettings, isAiConfigured, type AiProvider } from '../core/settings.js';
import { db } from '../db/db.js';
import { getBlob } from '../db/blobs.js';
import { resolveCompany } from '../company/lookup.js';
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

let pendingAiRequests = 0;

async function withAiActivity<T>(request: () => Promise<T>): Promise<T> {
  pendingAiRequests += 1;
  bus.emit('ai:activity', { pending: pendingAiRequests });
  try {
    return await request();
  } finally {
    pendingAiRequests = Math.max(0, pendingAiRequests - 1);
    bus.emit('ai:activity', { pending: pendingAiRequests });
  }
}

export function getProvider(id: AiProvider): Provider | null {
  return id === 'none' ? null : PROVIDERS[id];
}

/** Verifies the current AI configuration without spending a real extraction. */
export async function testConnection(): Promise<TestResult> {
  const settings = getSettings();
  const provider = getProvider(settings.ai.provider);
  if (!provider) return { ok: false, message: 'Ingen AI-leverantör vald.' };
  const serverToken = (await getDeviceToken()) ?? undefined;

  return withAiActivity(() => provider.test({
      settings: settings.ai,
      serverUrl: settings.sync.serverUrl,
      serverToken,
    }));
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
/**
 * Resolves the extracted organisation number to a stored company.
 *
 * Never throws and never blocks the extraction's result: a failed lookup is a
 * missing link, not a failed parse.
 */
async function linkCompany(receiptId: string, orgNumber: string | null): Promise<void> {
  if (!orgNumber) return;
  try {
    const receipt = await db.receipts.get(receiptId);
    if (!receipt || receipt.companyId) return;

    const outcome = await resolveCompany(orgNumber, {
      receiptText: receipt.ocr?.text,
      cacheOnly: !getSettings().company.autoLookup,
    });
    if (outcome.status === 'skipped') return;

    await updateReceipt(receiptId, {
      companyId: outcome.company.id,
      merchant: { ...receipt.merchant, name: receipt.merchant.name ?? outcome.company.name },
    });
  } catch (error) {
    console.warn('Company lookup after extraction failed', error);
  }
}

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
    const serverToken = (await getDeviceToken()) ?? undefined;
    const response = await withAiActivity(() => provider.extract({
        image: stored.data,
        settings: settings.ai,
        serverUrl: settings.sync.serverUrl,
        serverToken,
        signal: options.signal,
      }));

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

    // The model may have read an organisation number the OCR pass missed (or
    // never ran on). Same cache-first rule: a company already stored costs
    // nothing and never reaches the network.
    await linkCompany(receiptId, response.extraction.merchant.orgNumber);

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
