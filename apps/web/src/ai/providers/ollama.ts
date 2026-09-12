/**
 * Ollama provider, for a vision model running on the user's own machine.
 *
 * Nothing leaves the local network, which makes it the privacy-preserving
 * option — at the cost of needing Ollama started with `OLLAMA_ORIGINS` set so
 * the browser is allowed to call it.
 */

import {
  RECEIPT_JSON_SCHEMA,
  RECEIPT_USER_PROMPT,
  buildSystemPrompt,
  extractJsonObject,
  jsonOnlyInstruction,
  normalizeExtraction,
} from '@kvitto/shared';

import {
  ExtractionError,
  blobToBase64,
  type ExtractionRequest,
  type ExtractionResponse,
  type Provider,
  type TestResult,
} from '../types.js';
import { describeNetworkError } from './openai.js';

interface OllamaChatResponse {
  message?: { content?: string };
  model?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export const ollamaProvider: Provider = {
  id: 'ollama',

  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    const { settings, image, signal } = request;
    const baseUrl = (settings.baseUrl.trim() || 'http://localhost:11434').replace(/\/+$/, '');

    const started = performance.now();
    const data = await blobToBase64(image);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: signal ?? null,
        body: JSON.stringify({
          model: settings.model,
          stream: false,
          // Ollama takes a JSON Schema directly in `format`, which is a much
          // stronger guarantee than asking for JSON in the prompt.
          ...(settings.structuredOutput ? { format: RECEIPT_JSON_SCHEMA } : {}),
          options: { num_predict: settings.maxOutputTokens, temperature: 0 },
          messages: [
            {
              role: 'system',
              content: settings.structuredOutput
                ? buildSystemPrompt(settings.extraInstructions)
                : `${buildSystemPrompt(settings.extraInstructions)}\n\n${jsonOnlyInstruction(RECEIPT_JSON_SCHEMA)}`,
            },
            { role: 'user', content: RECEIPT_USER_PROMPT, images: [data] },
          ],
        }),
      });
    } catch (error) {
      throw new ExtractionError(describeNetworkError(error), { cause: error });
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ExtractionError(
        response.status === 404
          ? `Modellen "${settings.model}" finns inte i Ollama. Kör "ollama pull ${settings.model}".`
          : detail || `${response.status} ${response.statusText}`,
        { status: response.status },
      );
    }

    const payload = (await response.json()) as OllamaChatResponse;
    if (payload.error) throw new ExtractionError(payload.error);

    const raw = extractJsonObject(payload.message?.content ?? '');
    if (!raw) throw new ExtractionError('Modellen svarade inte med giltig JSON.');

    return {
      extraction: normalizeExtraction(raw),
      raw,
      model: payload.model ?? settings.model,
      provider: 'ollama',
      inputTokens: payload.prompt_eval_count ?? null,
      outputTokens: payload.eval_count ?? null,
      durationMs: Math.round(performance.now() - started),
      structuredOutputFallback: false,
    };
  },

  async test(request): Promise<TestResult> {
    const { settings } = request;
    const baseUrl = (settings.baseUrl.trim() || 'http://localhost:11434').replace(/\/+$/, '');
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) {
        return { ok: false, message: `Ollama svarade ${response.status}.` };
      }
      const payload = (await response.json()) as { models?: { name?: string }[] };
      const models = (payload.models ?? [])
        .map((model) => model.name)
        .filter((name): name is string => typeof name === 'string');
      const known = models.some((name) => name === settings.model || name.startsWith(`${settings.model}:`));
      return {
        ok: true,
        message: known
          ? `Ansluten till Ollama. Modellen "${settings.model}" finns nedladdad.`
          : `Ansluten, men "${settings.model}" är inte nedladdad. Kör "ollama pull ${settings.model}".`,
        models,
      };
    } catch (error) {
      return {
        ok: false,
        message:
          `${describeNetworkError(error)} Starta Ollama med ` +
          `OLLAMA_ORIGINS="${location.origin}" så att webbläsaren får anropa den.`,
      };
    }
  },
};
