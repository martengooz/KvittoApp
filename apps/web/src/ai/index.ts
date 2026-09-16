/**
 * Entry point for receipt extraction: picks a provider, runs it, and records
 * the outcome on the receipt.
 */

import {
  isBetterReading,
  validateExtraction,
  type NormalizedExtraction,
  type ValidationReport,
} from '@kvitto/shared';

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
  /** True when a correcting second pass ran and its result was the one kept. */
  corrected: boolean;
}

/** Normalisation warnings plus everything validation considers worth raising. */
function collectWarnings(response: ExtractionResponse, report: ValidationReport): string[] {
  const warnings = [
    ...response.extraction.warnings,
    ...report.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message),
  ];
  if (response.structuredOutputFallback) {
    warnings.push('Leverantören stödde inte JSON-schema; tolkningen kördes utan schemakontroll.');
  }
  return warnings;
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

interface CorrectionOutcome {
  response: ExtractionResponse;
  report: ValidationReport;
  warnings: string[];
}

/**
 * Re-reads a receipt whose first pass did not add up.
 *
 * Returns `null` — leaving the first result in place — when the retry fails, or
 * when it comes back no better than what it was correcting. A provider error
 * here is deliberately swallowed: the first pass produced something usable, and
 * losing it because an optional second call timed out would be the worse
 * outcome.
 */
async function runCorrectionPass(
  first: ExtractionResponse,
  firstReport: ValidationReport,
  context: {
    provider: Provider;
    image: Blob;
    settings: ReturnType<typeof getSettings>;
    serverUrl: string;
    serverToken: string | undefined;
    signal?: AbortSignal;
  },
): Promise<CorrectionOutcome | null> {
  const problems = firstReport.issues
    .filter((issue) => issue.severity !== 'info')
    .map((issue) => issue.message);
  if (problems.length === 0) return null;

  try {
    const response = await withAiActivity(() => context.provider.extract({
        image: context.image,
        settings: context.settings.ai,
        serverUrl: context.serverUrl,
        serverToken: context.serverToken,
        signal: context.signal,
        correction: { problems, previous: first.raw },
      }));

    const report = validateExtraction(response.extraction);
    if (!isBetterReading(report, firstReport)) return null;

    return { response, report, warnings: collectWarnings(response, report) };
  } catch (error) {
    console.warn('Correcting pass failed; keeping the first reading', error);
    return null;
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
      corrected: false,
    };
  }

  const receipt = await db.receipts.get(receiptId);
  if (!receipt) {
    return {
      ok: false,
      extraction: null,
      response: null,
      warnings: [],
      error: 'Kvittot finns inte.',
      corrected: false,
    };
  }

  const stored = await getBlob(receipt.imageId);
  if (!stored) {
    return {
      ok: false,
      extraction: null,
      response: null,
      warnings: [],
      error: 'Kvittobilden saknas på den här enheten.',
      corrected: false,
    };
  }

  await updateReceipt(receiptId, { status: 'processing' });

  try {
    const serverToken = (await getDeviceToken()) ?? undefined;
    let response = await withAiActivity(() => provider.extract({
        image: stored.data,
        settings: settings.ai,
        serverUrl: settings.sync.serverUrl,
        serverToken,
        signal: options.signal,
      }));

    let report = validateExtraction(response.extraction);
    let warnings = collectWarnings(response, report);

    // A first pass that does not hold together gets one more attempt, this time
    // told what is wrong so it can hunt for the misreading rather than start
    // cold. Exactly one retry: a model that could not find the mistake with the
    // problem spelled out will not find it on a third look either, and each
    // pass costs the user another call.
    //
    // The second result is only kept if it is actually better. A correcting
    // pass that introduces new problems, or trades one for another, is a worse
    // reading of the same paper — so the original stands and the receipt stays
    // flagged for the user.
    if (!report.ok) {
      const retry = await runCorrectionPass(response, report, {
        provider,
        image: stored.data,
        settings,
        serverUrl: settings.sync.serverUrl,
        serverToken,
        signal: options.signal,
      });
      if (retry) {
        response = retry.response;
        report = retry.report;
        warnings = retry.warnings;
      }
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

    return {
      ok: true,
      extraction: response.extraction,
      response,
      warnings,
      error: null,
      corrected: response.corrected,
    };
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
    return {
      ok: false,
      extraction: null,
      response: null,
      warnings: [],
      error: message,
      corrected: false,
    };
  }
}
