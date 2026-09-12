/**
 * Anthropic provider, calling the API directly from the device.
 *
 * The SDK is loaded with a dynamic `import()` so its bytes only reach users who
 * actually pick this provider — an offline-first app should not ship a vendor
 * SDK to someone running a local Ollama model.
 *
 * `dangerouslyAllowBrowser` is required and is exactly as advertised: the key
 * lives in the browser and is visible to anyone with the device. The Settings
 * screen says so, and the `server` provider exists for users who would rather
 * keep the key off the phone.
 */

import {
  RECEIPT_JSON_SCHEMA,
  RECEIPT_USER_PROMPT,
  buildSystemPrompt,
  extractJsonObject,
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

type AnthropicModule = typeof import('@anthropic-ai/sdk');
type AnthropicClient = InstanceType<AnthropicModule['default']>;

let sdkPromise: Promise<AnthropicModule> | null = null;

function loadSdk(): Promise<AnthropicModule> {
  sdkPromise ??= import('@anthropic-ai/sdk');
  return sdkPromise;
}

async function createClient(apiKey: string): Promise<AnthropicClient> {
  const sdk = await loadSdk();
  return new sdk.default({
    apiKey,
    // Required for browser use. The key is the user's own, entered on this
    // device, and never sent anywhere but api.anthropic.com.
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

export const anthropicProvider: Provider = {
  id: 'anthropic',

  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    const { settings, image, signal } = request;
    if (!settings.apiKey) throw new ExtractionError('Ingen API-nyckel angiven för Anthropic.');

    const client = await createClient(settings.apiKey);
    const started = performance.now();
    const data = await blobToBase64(image);
    const mediaType = imageMediaType(image);

    const send = (structured: boolean) =>
      client.messages.create(
        {
          model: settings.model,
          max_tokens: settings.maxOutputTokens,
          system: buildSystemPrompt(settings.extraInstructions),
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
                { type: 'text', text: RECEIPT_USER_PROMPT },
              ],
            },
          ],
          ...(structured || settings.effort !== 'auto'
            ? {
                output_config: {
                  ...(structured
                    ? { format: { type: 'json_schema' as const, schema: RECEIPT_JSON_SCHEMA as never } }
                    : {}),
                  ...(settings.effort !== 'auto' ? { effort: settings.effort } : {}),
                },
              }
            : {}),
        },
        { signal },
      );

    let structuredOutputFallback = false;
    let message: Awaited<ReturnType<typeof send>>;
    try {
      message = await send(settings.structuredOutput);
    } catch (error) {
      // Not every model accepts a JSON schema. Rather than making the user
      // discover that through a raw 400, retry once with prompt-only JSON.
      if (settings.structuredOutput && isSchemaRejection(error)) {
        structuredOutputFallback = true;
        message = await send(false);
      } else {
        throw toExtractionError(error);
      }
    }

    if (message.stop_reason === 'refusal') {
      throw new ExtractionError(
        'Modellen avböjde att läsa bilden. Kontrollera att det verkligen är ett kvitto.',
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new ExtractionError(
        'Svaret klipptes av. Höj "Max tokens" i inställningarna och försök igen.',
        { retryable: true },
      );
    }

    const text = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const raw = extractJsonObject(text);
    if (!raw) {
      throw new ExtractionError('Modellen svarade inte med giltig JSON.');
    }

    return {
      extraction: normalizeExtraction(raw),
      raw,
      model: message.model,
      provider: 'anthropic',
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      durationMs: Math.round(performance.now() - started),
      structuredOutputFallback,
    };
  },

  async test(request): Promise<TestResult> {
    const { settings } = request;
    if (!settings.apiKey) return { ok: false, message: 'Ingen API-nyckel angiven.' };

    try {
      const client = await createClient(settings.apiKey);
      const models = await client.models.list({ limit: 50 });
      const ids = models.data.map((model) => model.id);
      const known = ids.includes(settings.model);
      return {
        ok: true,
        message: known
          ? `Ansluten. Modellen "${settings.model}" är tillgänglig.`
          : `Ansluten, men "${settings.model}" fanns inte i listan över modeller.`,
        models: ids,
      };
    } catch (error) {
      return { ok: false, message: toExtractionError(error).message };
    }
  },
};

/** True for the 400 a model returns when it will not accept an output schema. */
function isSchemaRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: number }).status;
  if (status !== 400) return false;
  const message = String((error as { message?: string }).message ?? '').toLowerCase();
  return (
    message.includes('output_config') ||
    message.includes('json_schema') ||
    message.includes('schema') ||
    message.includes('format')
  );
}

function toExtractionError(error: unknown): ExtractionError {
  if (error instanceof ExtractionError) return error;

  const status = (error as { status?: number } | null)?.status ?? null;
  const detail = (error as { message?: string } | null)?.message ?? String(error);

  switch (status) {
    case 401:
      return new ExtractionError('API-nyckeln avvisades. Kontrollera att den är korrekt.', { status });
    case 403:
      return new ExtractionError('Nyckeln saknar behörighet till den här modellen.', { status });
    case 404:
      return new ExtractionError('Modellen hittades inte. Kontrollera modellnamnet.', { status });
    case 413:
      return new ExtractionError('Bilden var för stor. Sänk maxupplösningen i inställningarna.', { status });
    case 429:
      return new ExtractionError('Hastighetsbegränsad av Anthropic. Försök igen om en stund.', {
        status,
        retryable: true,
      });
    default:
      if (status !== null && status >= 500) {
        return new ExtractionError('Anthropic svarade med ett serverfel. Försök igen.', {
          status,
          retryable: true,
        });
      }
      return new ExtractionError(detail, { status, cause: error });
  }
}
