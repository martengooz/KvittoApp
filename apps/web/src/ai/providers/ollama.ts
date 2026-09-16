/**
 * Ollama provider, for a vision model running on the user's own machine.
 *
 * Nothing leaves the local network, which makes it the privacy-preserving
 * option — at the cost of needing Ollama started with `OLLAMA_ORIGINS` set so
 * the browser is allowed to call it. Thin adapter over the shared provider
 * core in `@kvitto/shared`, which the server's local-model worker also calls.
 */

import { ProviderError, callOllama, describeNetworkError, listOllamaModels, normalizeExtraction } from '@kvitto/shared';

import {
  ExtractionError,
  blobToBase64,
  type ExtractionRequest,
  type Provider,
  type TestResult,
} from '../types.js';

export const ollamaProvider: Provider = {
  id: 'ollama',

  async extract(request: ExtractionRequest) {
    const { settings, image, signal } = request;
    const baseUrl = settings.baseUrl.trim() || 'http://localhost:11434';

    const data = await blobToBase64(image);

    try {
      const result = await callOllama({
        baseUrl,
        model: settings.model,
        images: [data],
        maxOutputTokens: settings.maxOutputTokens,
        structuredOutput: settings.structuredOutput,
        extraInstructions: settings.extraInstructions,
        correction: request.correction,
        signal,
      });

      return {
        extraction: normalizeExtraction(result.raw),
        raw: result.raw,
        model: result.model,
        provider: 'ollama',
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
    const baseUrl = settings.baseUrl.trim() || 'http://localhost:11434';
    try {
      const models = await listOllamaModels({ baseUrl });
      const known = models.some((name) => name === settings.model || name.startsWith(`${settings.model}:`));
      return {
        ok: true,
        message: known
          ? `Ansluten till Ollama. Modellen "${settings.model}" finns nedladdad.`
          : `Ansluten, men "${settings.model}" är inte nedladdad. Kör "ollama pull ${settings.model}".`,
        models,
      };
    } catch (error) {
      const base = toExtractionError(error).message;
      // A network-layer failure (as opposed to Ollama answering with an
      // error) is most often a missing OLLAMA_ORIGINS, not a dead instance.
      const hint =
        error instanceof ProviderError && error.kind === 'network'
          ? ` Starta Ollama med OLLAMA_ORIGINS="${location.origin}" så att webbläsaren får anropa den.`
          : '';
      return { ok: false, message: `${base}${hint}` };
    }
  },
};

function toExtractionError(error: unknown): ExtractionError {
  if (error instanceof ExtractionError) return error;
  if (error instanceof ProviderError) {
    return new ExtractionError(error.message, { status: error.status, retryable: error.retryable, cause: error });
  }
  return new ExtractionError(describeNetworkError(error), { cause: error });
}
