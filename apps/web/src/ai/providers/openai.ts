/**
 * OpenAI and OpenAI-compatible providers (OpenRouter, Groq, LM Studio, vLLM…).
 *
 * Thin adapter over the shared provider core in `@kvitto/shared`, which owns
 * the wire format, the structured-output fallback and the status→message
 * mapping — the same core the server proxy calls for this provider.
 */

import { describeError, ProviderError, callOpenAi, listOpenAiModels, normalizeExtraction } from '@kvitto/shared';

import {
  ExtractionError,
  blobToBase64,
  imageMediaType,
  type ExtractionRequest,
  type Provider,
  type TestResult,
} from '../types.js';

function makeProvider(id: 'openai' | 'openai-compatible', fallbackBaseUrl: string): Provider {
  return {
    id,

    async extract(request: ExtractionRequest) {
      const { settings, image, signal } = request;
      const baseUrl = settings.baseUrl.trim() || fallbackBaseUrl;
      if (!settings.apiKey) throw new ExtractionError('Ingen API-nyckel angiven.');

      const data = await blobToBase64(image);

      try {
        const result = await callOpenAi({
          apiKey: settings.apiKey,
          baseUrl,
          model: settings.model,
          image: { base64: data, mediaType: imageMediaType(image) },
          maxOutputTokens: settings.maxOutputTokens,
          effort: settings.effort,
          structuredOutput: settings.structuredOutput,
          extraInstructions: settings.extraInstructions,
          correction: request.correction,
          signal,
        });

        return {
          extraction: normalizeExtraction(result.raw),
          raw: result.raw,
          model: result.model,
          provider: id,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: result.durationMs,
          structuredOutputFallback: result.structuredOutputFallback,
          corrected: Boolean(request.correction),
        };
      } catch (error) {
        throw toExtractionError(error);
      }
    },

    async test(request): Promise<TestResult> {
      const { settings } = request;
      const baseUrl = settings.baseUrl.trim() || fallbackBaseUrl;
      if (!settings.apiKey) return { ok: false, message: 'Ingen API-nyckel angiven.' };

      try {
        const models = await listOpenAiModels({ apiKey: settings.apiKey, baseUrl });
        const known = models.includes(settings.model);
        return {
          ok: true,
          message: known
            ? `Ansluten. Modellen "${settings.model}" är tillgänglig.`
            : `Ansluten, men "${settings.model}" fanns inte bland ${models.length} modeller.`,
          models,
        };
      } catch (error) {
        return { ok: false, message: toExtractionError(error).message };
      }
    },
  };
}

export const openaiProvider = makeProvider('openai', 'https://api.openai.com/v1');
export const openaiCompatibleProvider = makeProvider('openai-compatible', 'https://openrouter.ai/api/v1');

function toExtractionError(error: unknown): ExtractionError {
  if (error instanceof ExtractionError) return error;
  if (error instanceof ProviderError) {
    return new ExtractionError(error.message, { status: error.status, retryable: error.retryable, cause: error });
  }
  return new ExtractionError(describeError(error), { cause: error });
}
