/**
 * OpenAI and OpenAI-compatible providers (OpenRouter, Groq, LM Studio, vLLM…).
 *
 * Plain `fetch` rather than an SDK: the wire format is a stable, widely-cloned
 * shape, and the compatible endpoints differ from each other in small ways that
 * are easier to accommodate directly than through a vendor client.
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
  imageMediaType,
  type ExtractionRequest,
  type ExtractionResponse,
  type Provider,
  type TestResult,
} from '../types.js';

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string };
}

function endpoint(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}${path}`;
}

function makeProvider(id: 'openai' | 'openai-compatible', fallbackBaseUrl: string): Provider {
  return {
    id,

    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      const { settings, image, signal } = request;
      const baseUrl = settings.baseUrl.trim() || fallbackBaseUrl;
      if (!settings.apiKey) throw new ExtractionError('Ingen API-nyckel angiven.');

      const started = performance.now();
      const data = await blobToBase64(image);
      const dataUrl = `data:${imageMediaType(image)};base64,${data}`;

      const send = async (structured: boolean): Promise<Response> =>
        fetch(endpoint(baseUrl, '/chat/completions'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          signal: signal ?? null,
          body: JSON.stringify({
            model: settings.model,
            max_completion_tokens: settings.maxOutputTokens,
            messages: [
              {
                role: 'system',
                content: structured
                  ? buildSystemPrompt(settings.extraInstructions)
                  : `${buildSystemPrompt(settings.extraInstructions)}\n\n${jsonOnlyInstruction(RECEIPT_JSON_SCHEMA)}`,
              },
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
                  { type: 'text', text: RECEIPT_USER_PROMPT },
                ],
              },
            ],
            ...(structured
              ? {
                  response_format: {
                    type: 'json_schema',
                    json_schema: { name: 'receipt', strict: true, schema: RECEIPT_JSON_SCHEMA },
                  },
                }
              : {}),
          }),
        });

      let structuredOutputFallback = false;
      let response = await send(settings.structuredOutput);
      if (!response.ok && settings.structuredOutput && (response.status === 400 || response.status === 422)) {
        // Many compatible endpoints advertise the OpenAI surface but not
        // `json_schema`. Retry once with the schema in the prompt instead.
        structuredOutputFallback = true;
        response = await send(false);
      }
      if (!response.ok) throw await toExtractionError(response);

      const payload = (await response.json()) as ChatCompletion;
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw new ExtractionError('Svaret klipptes av. Höj "Max tokens" och försök igen.', {
          retryable: true,
        });
      }

      const raw = extractJsonObject(choice?.message?.content ?? '');
      if (!raw) throw new ExtractionError('Modellen svarade inte med giltig JSON.');

      return {
        extraction: normalizeExtraction(raw),
        raw,
        model: payload.model ?? settings.model,
        provider: id,
        inputTokens: payload.usage?.prompt_tokens ?? null,
        outputTokens: payload.usage?.completion_tokens ?? null,
        durationMs: Math.round(performance.now() - started),
        structuredOutputFallback,
      };
    },

    async test(request): Promise<TestResult> {
      const { settings } = request;
      const baseUrl = settings.baseUrl.trim() || fallbackBaseUrl;
      if (!settings.apiKey) return { ok: false, message: 'Ingen API-nyckel angiven.' };

      try {
        const response = await fetch(endpoint(baseUrl, '/models'), {
          headers: { authorization: `Bearer ${settings.apiKey}` },
        });
        if (!response.ok) return { ok: false, message: (await toExtractionError(response)).message };

        const payload = (await response.json()) as { data?: { id?: string }[] };
        const models = (payload.data ?? [])
          .map((model) => model.id)
          .filter((value): value is string => typeof value === 'string');
        const known = models.includes(settings.model);
        return {
          ok: true,
          message: known
            ? `Ansluten. Modellen "${settings.model}" är tillgänglig.`
            : `Ansluten, men "${settings.model}" fanns inte bland ${models.length} modeller.`,
          models,
        };
      } catch (error) {
        return { ok: false, message: describeNetworkError(error) };
      }
    },
  };
}

export const openaiProvider = makeProvider('openai', 'https://api.openai.com/v1');
export const openaiCompatibleProvider = makeProvider('openai-compatible', 'https://openrouter.ai/api/v1');

async function toExtractionError(response: Response): Promise<ExtractionError> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) detail = body.error.message;
  } catch {
    // A non-JSON error body is common from proxies; the status line will do.
  }

  switch (response.status) {
    case 401:
      return new ExtractionError('API-nyckeln avvisades.', { status: 401 });
    case 403:
      return new ExtractionError('Nyckeln saknar behörighet till den här modellen.', { status: 403 });
    case 404:
      return new ExtractionError(
        'Endpointen eller modellen hittades inte. Kontrollera bas-URL och modellnamn.',
        { status: 404 },
      );
    case 429:
      return new ExtractionError('Hastighetsbegränsad. Försök igen om en stund.', {
        status: 429,
        retryable: true,
      });
    default:
      return new ExtractionError(detail, {
        status: response.status,
        retryable: response.status >= 500,
      });
  }
}

/** CORS and DNS failures both surface as an opaque `TypeError` from `fetch`. */
export function describeNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Avbruten.';
  if (error instanceof TypeError) {
    return (
      'Kunde inte nå servern. Kontrollera adressen, och att den tillåter anrop ' +
      'från webbläsaren (CORS).'
    );
  }
  return error instanceof Error ? error.message : String(error);
}
