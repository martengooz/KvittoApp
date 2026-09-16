/**
 * Anthropic provider, calling the API directly from the device.
 *
 * Talks to `api.anthropic.com` with plain `fetch`, via the shared provider
 * core in `@kvitto/shared` — the same wire call the server proxy makes with
 * the operator's key instead of the user's. No SDK: `@anthropic-ai/sdk` gave
 * two things worth keeping (`maxRetries: 2` and browser support), and both
 * live in the shared core now (`withRetry`, and `fetch` being available in
 * both places to begin with).
 *
 * The key lives in the browser and is visible to anyone with the device —
 * that was equally true through the SDK's `dangerouslyAllowBrowser`. The
 * Settings screen says so, and the `server` provider exists for users who
 * would rather keep the key off the phone.
 */

import {
  describeError,
  ProviderError,
  callAnthropic,
  listAnthropicModels,
  normalizeExtraction,
} from '@kvitto/shared';

import {
  ExtractionError,
  blobToBase64,
  imageMediaType,
  type Provider,
  type TestResult,
} from '../types.js';

export const anthropicProvider: Provider = {
  id: 'anthropic',

  async extract(request) {
    const { settings, image, signal } = request;
    if (!settings.apiKey) throw new ExtractionError('Ingen API-nyckel angiven för Anthropic.');

    const data = await blobToBase64(image);

    try {
      const result = await callAnthropic({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || undefined,
        model: settings.model,
        image: { base64: data, mediaType: imageMediaType(image) },
        maxOutputTokens: settings.maxOutputTokens,
        effort: settings.effort,
        structuredOutput: settings.structuredOutput,
        extraInstructions: settings.extraInstructions,
        signal,
      });

      return {
        extraction: normalizeExtraction(result.raw),
        raw: result.raw,
        model: result.model,
        provider: 'anthropic',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        structuredOutputFallback: result.structuredOutputFallback,
      };
    } catch (error) {
      throw toExtractionError(error);
    }
  },

  async test(request): Promise<TestResult> {
    const { settings } = request;
    if (!settings.apiKey) return { ok: false, message: 'Ingen API-nyckel angiven.' };

    try {
      const models = await listAnthropicModels({ apiKey: settings.apiKey, baseUrl: settings.baseUrl || undefined });
      const known = models.includes(settings.model);
      return {
        ok: true,
        message: known
          ? `Ansluten. Modellen "${settings.model}" är tillgänglig.`
          : `Ansluten, men "${settings.model}" fanns inte i listan över modeller.`,
        models,
      };
    } catch (error) {
      return { ok: false, message: toExtractionError(error).message };
    }
  },
};

function toExtractionError(error: unknown): ExtractionError {
  if (error instanceof ExtractionError) return error;
  if (error instanceof ProviderError) {
    return new ExtractionError(error.message, { status: error.status, retryable: error.retryable, cause: error });
  }
  return new ExtractionError(describeError(error), { cause: error });
}
