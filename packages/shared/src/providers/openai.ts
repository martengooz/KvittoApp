/**
 * OpenAI and OpenAI-compatible chat completions, as a pure `fetch` call.
 *
 * Plain `fetch` rather than an SDK: the wire format is a stable, widely-cloned
 * shape, and the compatible endpoints (OpenRouter, Groq, LM Studio, vLLM…)
 * differ from each other in small ways that are easier to accommodate
 * directly than through a vendor client.
 */

import { normalizeBaseUrl } from '../url.js';
import { RECEIPT_JSON_SCHEMA } from '../extraction.js';
import { RECEIPT_USER_PROMPT, buildSystemPrompt, jsonOnlyInstruction } from '../prompt.js';

import {
  DEFAULT_TIMEOUT_MS,
  ProviderError,
  parseModelJson,
  providerErrorForResponse,
  sendWithStructuredFallback,
  timedFetch,
  type ProviderCallResult,
  type ProviderImage,
} from './core.js';

/** Reasoning effort, mirrored from `ai-settings-ui.ts` to avoid a runtime import into a UI module. */
export type OpenAiEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface OpenAiCallParams {
  apiKey: string;
  /** No default here — the caller knows whether it means `openai` or a compatible endpoint. */
  baseUrl: string;
  model: string;
  image: ProviderImage;
  maxOutputTokens: number;
  /** Sent as `reasoning_effort`. Omitted (or `auto`) leaves it up to the model — the only safe default across models that reject the field entirely. */
  effort?: OpenAiEffort;
  structuredOutput: boolean;
  extraInstructions?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function endpoint(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

export async function callOpenAi(params: OpenAiCallParams): Promise<ProviderCallResult> {
  const started = Date.now();
  const dataUrl = `data:${params.image.mediaType};base64,${params.image.base64}`;
  const system = buildSystemPrompt(params.extraInstructions);

  const body = (structured: boolean): Record<string, unknown> => ({
    model: params.model,
    max_completion_tokens: params.maxOutputTokens,
    messages: [
      {
        role: 'system',
        content: structured ? system : `${system}\n\n${jsonOnlyInstruction(RECEIPT_JSON_SCHEMA)}`,
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
    ...(params.effort && params.effort !== 'auto' ? { reasoning_effort: params.effort } : {}),
  });

  const send = (structured: boolean): Promise<Response> =>
    timedFetch(
      endpoint(params.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${params.apiKey}` },
        body: JSON.stringify(body(structured)),
      },
      { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: params.signal },
    );

  const { response, structuredOutputFallback } = await sendWithStructuredFallback(params.structuredOutput, send);
  if (!response.ok) {
    throw await providerErrorForResponse(response, {
      notFound: 'Endpointen eller modellen hittades inte. Kontrollera bas-URL och modellnamn.',
    });
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };

  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'length') {
    throw new ProviderError('Svaret klipptes av. Höj "Max tokens" och försök igen.', {
      retryable: true,
      kind: 'invalid-response',
    });
  }

  const raw = parseModelJson(choice?.message?.content ?? '');

  return {
    raw,
    model: payload.model ?? params.model,
    inputTokens: payload.usage?.prompt_tokens ?? null,
    outputTokens: payload.usage?.completion_tokens ?? null,
    structuredOutputFallback,
    durationMs: Date.now() - started,
  };
}

export interface OpenAiModelsParams {
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function listOpenAiModels(params: OpenAiModelsParams): Promise<string[]> {
  const response = await timedFetch(
    endpoint(params.baseUrl, '/models'),
    { headers: { authorization: `Bearer ${params.apiKey}` } },
    { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: params.signal },
  );
  if (!response.ok) throw await providerErrorForResponse(response);
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return (payload.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string');
}
