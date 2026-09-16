/**
 * Server-side extraction, so a device can parse receipts without holding a
 * provider API key.
 *
 * Thin adapter over the shared provider core in `@kvitto/shared` — the same
 * wire calls the in-app providers make, with the operator's key instead of
 * the user's. Only the trust boundary moves; the request, the schema and the
 * failure handling are identical.
 */

import {
  describeError,
  ProviderError,
  callAnthropic,
  callOpenAi,
  normalizeExtraction,
  validateExtraction,
  type NormalizedExtraction,
  type ProviderCallResult,
} from '@kvitto/shared';

import type { AiEffort, EffectiveAiSettings } from '../db/server-settings.ts';
import { config } from '../env.ts';

export interface ProxyResult {
  /** The model's raw parsed JSON, kept for debugging a bad read. */
  raw: Record<string, unknown>;
  extraction: NormalizedExtraction;
  /** Arithmetic/consistency warnings from {@link validateExtraction}, same as the device computes. */
  warnings: string[];
  model: string;
  provider: string;
  inputTokens: number | null;
  outputTokens: number | null;
  structuredOutputFallback: boolean;
}

export class ProxyError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status = 502, retryable = false) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.retryable = retryable;
  }
}

export async function runExtraction(
  settings: EffectiveAiSettings,
  image: Buffer,
  mimeType: string,
  options: { model?: string; extraInstructions?: string; effort?: AiEffort; maxOutputTokens?: number } = {},
): Promise<ProxyResult> {
  const model = options.model ?? settings.model;
  const extraInstructions = [settings.extraInstructions, options.extraInstructions].filter(Boolean).join('\n');
  // A device may spend less of the operator's money than the server allows, but
  // never more — the same rule the model allow-list enforces above.
  const maxOutputTokens = Math.min(options.maxOutputTokens ?? settings.maxOutputTokens, settings.maxOutputTokens);
  const effort = options.effort ?? settings.effort;
  const imageInput = { base64: image.toString('base64'), mediaType: mimeType };
  const timeoutMs = config.ai.timeoutMs;

  try {
    switch (settings.provider) {
      case 'anthropic': {
        const result = await callAnthropic({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          model,
          image: imageInput,
          maxOutputTokens,
          effort,
          structuredOutput: settings.structuredOutput,
          extraInstructions,
          timeoutMs,
        });
        return finish(result, 'anthropic');
      }
      case 'openai':
      case 'openai-compatible': {
        const result = await callOpenAi({
          apiKey: settings.apiKey,
          baseUrl: (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
          model,
          image: imageInput,
          maxOutputTokens,
          effort,
          structuredOutput: settings.structuredOutput,
          extraInstructions,
          timeoutMs,
        });
        return finish(result, settings.provider);
      }
      default:
        throw new ProxyError(`Unsupported AI provider "${settings.provider}".`, 500);
    }
  } catch (error) {
    throw toProxyError(error);
  }
}

function finish(result: ProviderCallResult, provider: string): ProxyResult {
  const extraction = normalizeExtraction(result.raw);
  const report = validateExtraction(extraction);
  const warnings = report.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.message);

  return {
    raw: result.raw,
    extraction,
    warnings,
    model: result.model,
    provider,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    structuredOutputFallback: result.structuredOutputFallback,
  };
}

/**
 * Turns a provider error into one safe to return to a device.
 *
 * Upstream bodies can echo request headers, so only the status and a short
 * message are forwarded — never the raw response. A 401/403 is deliberately
 * flattened to one message: a device must never learn whether the operator's
 * key is wrong versus merely unauthorised for this model, because it cannot
 * fix either.
 */
function toProxyError(error: unknown): ProxyError {
  if (error instanceof ProxyError) return error;
  if (error instanceof ProviderError) {
    if (error.status === 401 || error.status === 403) {
      return new ProxyError('Serverns AI-nyckel avvisades. Kontakta administratören.', 502);
    }
    if (error.status === 429) return new ProxyError('AI-tjänsten är hastighetsbegränsad just nu.', 429, true);
    return new ProxyError(error.message, 502, error.retryable);
  }
  return new ProxyError(describeError(error), 502);
}
