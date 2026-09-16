/**
 * A minimal Ollama client, as a pure `fetch` call.
 *
 * Shared by the phone (talking to a local Ollama over the LAN, browser-side)
 * and the server's local-model worker (talking to the instance it manages).
 * `format` carries the JSON Schema when structured output is requested —
 * Ollama constrains generation to it at the sampler, a far stronger guarantee
 * than asking a model to please return JSON.
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
  parseModelJson,
  sendWithStructuredFallback,
  timedFetch,
  type ProviderCallResult,
} from './core.js';

export interface OllamaCallParams {
  /** Defaults to `http://localhost:11434`. */
  baseUrl?: string;
  model: string;
  /** Base64-encoded image bytes, without a `data:` prefix. One per receipt scan today. */
  images: string[];
  maxOutputTokens: number;
  /** The model's context window. Omitted for the phone, which has no opinion on it. */
  contextTokens?: number;
  structuredOutput: boolean;
  extraInstructions?: string | null;
  /** The compact system prompt tuned for small local models (the server's worker). */
  compactPrompt?: boolean;
  userPrompt?: string;
  /** When set, runs the correcting pass instead of a plain transcription. */
  correction?: CorrectionContext | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function endpoint(baseUrl: string | undefined): string {
  return normalizeBaseUrl(baseUrl || 'http://localhost:11434');
}

export async function callOllama(params: OllamaCallParams): Promise<ProviderCallResult> {
  const started = Date.now();
  // A correcting pass needs the reasoning the compact prompt deliberately drops,
  // so it always uses the full one even on a small local model.
  const system = buildSystemPrompt(params.extraInstructions, {
    compact: params.compactPrompt && !params.correction,
    correction: Boolean(params.correction),
  });

  const body = (structured: boolean): Record<string, unknown> => ({
    model: params.model,
    stream: false,
    ...(structured ? { format: RECEIPT_JSON_SCHEMA } : {}),
    options: {
      num_predict: params.maxOutputTokens,
      // Deterministic: the same receipt must not extract differently on a
      // retry, or a caller merging results cannot tell a correction from noise.
      temperature: 0,
      ...(params.contextTokens ? { num_ctx: params.contextTokens } : {}),
    },
    messages: [
      {
        role: 'system',
        content: structured ? system : `${system}\n\n${jsonOnlyInstruction(RECEIPT_JSON_SCHEMA)}`,
      },
      { role: 'user', content: params.userPrompt ?? buildUserPrompt(params.correction), images: params.images },
    ],
  });

  const send = (structured: boolean): Promise<Response> =>
    timedFetch(
      `${endpoint(params.baseUrl)}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(structured)),
      },
      { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: params.signal },
    );

  const { response, structuredOutputFallback } = await sendWithStructuredFallback(params.structuredOutput, send);

  if (response.status === 404) {
    throw new ProviderError(`Modellen "${params.model}" finns inte i Ollama. Kör "ollama pull ${params.model}".`, {
      status: 404,
      kind: 'http',
    });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(detail || `${response.status} ${response.statusText}`, {
      status: response.status,
      retryable: response.status >= 500,
      kind: 'http',
    });
  }

  const payload = (await response.json()) as {
    message?: { content?: string };
    model?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  if (payload.error) throw new ProviderError(payload.error, { kind: 'invalid-response' });

  const raw = parseModelJson(payload.message?.content ?? '');

  return {
    raw,
    model: payload.model ?? params.model,
    inputTokens: payload.prompt_eval_count ?? null,
    outputTokens: payload.eval_count ?? null,
    structuredOutputFallback,
    durationMs: Date.now() - started,
  };
}

export interface OllamaTagsParams {
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Models the instance already holds — the `/api/tags` listing. */
export async function listOllamaModels(params: OllamaTagsParams = {}): Promise<string[]> {
  const response = await timedFetch(
    `${endpoint(params.baseUrl)}/api/tags`,
    {},
    { timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: params.signal },
  );
  if (!response.ok) throw new ProviderError(`Ollama svarade ${response.status}.`, { status: response.status, kind: 'http' });
  const payload = (await response.json()) as { models?: { name?: string }[] };
  return (payload.models ?? []).map((model) => model.name).filter((name): name is string => typeof name === 'string');
}
