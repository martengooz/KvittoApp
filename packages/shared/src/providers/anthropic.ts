/**
 * The Anthropic Messages API, as a pure `fetch` call.
 *
 * Used directly from the browser (the API key is the user's own, entered on
 * their device — see the web `anthropic` adapter for that trust decision) and
 * from the server proxy, which holds the operator's key instead. Same wire
 * call either way, which is the point: this used to be written out twice, by
 * hand, once against `@anthropic-ai/sdk` and once against raw `fetch`.
 */

import { normalizeBaseUrl } from '../url.js';
import { RECEIPT_JSON_SCHEMA } from '../extraction.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  jsonOnlyInstruction,
  type CorrectionContext,
} from '../prompt.js';

import {
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  isRetryableStatus,
  parseModelJson,
  providerErrorForResponse,
  sendWithStructuredFallback,
  timedFetch,
  withRetry,
  type ProviderCallResult,
  type ProviderImage,
} from './core.js';

/** Reasoning effort, mirrored from `ai-settings-ui.ts` to avoid a runtime import into a UI module. */
export type AnthropicEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicCallParams {
  apiKey: string;
  /** Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  model: string;
  image: ProviderImage;
  maxOutputTokens: number;
  effort?: AnthropicEffort;
  structuredOutput: boolean;
  extraInstructions?: string | null;
  /** When set, runs the correcting pass instead of a plain transcription. */
  correction?: CorrectionContext | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const ANTHROPIC_VERSION = '2023-06-01';

function endpoint(baseUrl: string | undefined): string {
  return normalizeBaseUrl(baseUrl || 'https://api.anthropic.com');
}

export async function callAnthropic(params: AnthropicCallParams): Promise<ProviderCallResult> {
  const started = Date.now();
  const system = buildSystemPrompt(params.extraInstructions, { correction: Boolean(params.correction) });
  const userPrompt = buildUserPrompt(params.correction);
  const url = `${endpoint(params.baseUrl)}/v1/messages`;
  const hasEffort = Boolean(params.effort && params.effort !== 'auto');

  const body = (structured: boolean): Record<string, unknown> => ({
    model: params.model,
    max_tokens: params.maxOutputTokens,
    system: structured ? system : `${system}\n\n${jsonOnlyInstruction(RECEIPT_JSON_SCHEMA)}`,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: params.image.mediaType, data: params.image.base64 },
          },
          { type: 'text', text: userPrompt },
        ],
      },
    ],
    ...(structured || hasEffort
      ? {
          output_config: {
            ...(structured ? { format: { type: 'json_schema', schema: RECEIPT_JSON_SCHEMA } } : {}),
            ...(hasEffort ? { effort: params.effort } : {}),
          },
        }
      : {}),
  });

  const send = (structured: boolean): Promise<Response> =>
    withRetry(
      () =>
        timedFetch(
          url,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': params.apiKey,
              'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify(body(structured)),
          },
          { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: params.signal },
        ),
      // The Anthropic SDK retried up to twice on a retryable failure; matched
      // here now that the browser calls `fetch` directly instead of the SDK.
      { attempts: 3, isRetryable: isRetryableStatus, signal: params.signal },
    );

  const { response, structuredOutputFallback } = await sendWithStructuredFallback(params.structuredOutput, send);
  if (!response.ok) {
    throw await providerErrorForResponse(response, {
      notFound: `Modellen "${params.model}" hittades inte. Kontrollera modellnamnet.`,
    });
  }

  const payload = (await response.json()) as {
    content?: { type: string; text?: string }[];
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  if (payload.stop_reason === 'refusal') {
    throw new ProviderError('Modellen avböjde att läsa bilden. Kontrollera att det verkligen är ett kvitto.', {
      kind: 'invalid-response',
    });
  }
  if (payload.stop_reason === 'max_tokens') {
    throw new ProviderError('Svaret klipptes av. Höj "Max tokens" i inställningarna och försök igen.', {
      retryable: true,
      kind: 'invalid-response',
    });
  }

  const text = (payload.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const raw = parseModelJson(text);

  return {
    raw,
    model: payload.model ?? params.model,
    inputTokens: payload.usage?.input_tokens ?? null,
    outputTokens: payload.usage?.output_tokens ?? null,
    structuredOutputFallback,
    durationMs: Date.now() - started,
  };
}

export interface AnthropicModelsParams {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Lists models the key can use — the same round-trip the SDK's `models.list()` made. */
export async function listAnthropicModels(params: AnthropicModelsParams): Promise<string[]> {
  const response = await timedFetch(
    `${endpoint(params.baseUrl)}/v1/models?limit=50`,
    { headers: { 'x-api-key': params.apiKey, 'anthropic-version': ANTHROPIC_VERSION } },
    { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: params.signal },
  );
  if (!response.ok) throw await providerErrorForResponse(response);
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return (payload.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string');
}
