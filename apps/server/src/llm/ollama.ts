/**
 * A minimal Ollama client — the inference host for the local model.
 *
 * Ollama rather than a bundled runtime because the requirement is "works on
 * Linux and macOS with a 4B vision model", and Ollama is the only option that
 * ships one binary covering CUDA, ROCm, Metal and plain CPU without this
 * project growing a native build step.
 *
 * `generate` calls the shared Ollama core in `@kvitto/shared` — the same code
 * the phone talks to a local Ollama with. Everything here that is genuinely
 * server-only stays: bringing the process up is {@link ./runtime.ts}'s job,
 * `ping`/`listModels`/`hasModel` are the small admin calls that back it and
 * the status endpoint, and `pullModel`'s NDJSON download stream has no
 * equivalent on the phone at all.
 */

import { ProviderError, callOllama, timedFetch } from '@kvitto/shared';

import { config } from '../env.ts';

export class LlmError extends Error {
  /** True when trying the same request again could plausibly work. */
  readonly retryable: boolean;
  /** Machine-readable cause, for the status endpoint and the worker's policy. */
  readonly kind: LlmFailure;

  constructor(kind: LlmFailure, message: string, retryable = false) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

export type LlmFailure =
  /** Nothing is listening on the Ollama port. */
  | 'unreachable'
  /** Ollama is up but does not have the model. */
  | 'model-missing'
  /** The model ran but returned something unusable. */
  | 'bad-output'
  /** The request exceeded its deadline. */
  | 'timeout'
  /** Anything else Ollama reported. */
  | 'failed';

export interface OllamaModel {
  name: string;
  size: number;
  /** Parameter count as Ollama reports it, e.g. `4.4B`. */
  parameters: string | null;
  quantization: string | null;
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  /** Base64-encoded image bytes, without a data: prefix. */
  images: string[];
  /** Constrain the response to the receipt JSON Schema at the sampler. */
  structuredOutput: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Appended to the system prompt, for store-specific quirks. */
  extraInstructions?: string | null;
  /**
   * Use the compact system prompt tuned for small local models. Defaults to
   * `true` — this client only ever talks to the local model, which is always
   * small enough to need it.
   */
  compactPrompt?: boolean;
}

export interface GenerateResult {
  /** The model's parsed JSON response. */
  raw: Record<string, unknown>;
  model: string;
  promptTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  structuredOutputFallback: boolean;
}

function baseUrl(): string {
  return config.llm.baseUrl.replace(/\/+$/, '');
}

/** Whether Ollama is answering. Cheap; used by the health endpoint. */
export async function ping(timeoutMs = 2000): Promise<{ ok: boolean; version: string | null }> {
  try {
    const response = await timedFetch(`${baseUrl()}/api/version`, {}, { timeoutMs });
    if (!response.ok) return { ok: false, version: null };
    const body = (await response.json()) as { version?: string };
    return { ok: true, version: body.version ?? null };
  } catch {
    return { ok: false, version: null };
  }
}

/** Models the local instance already holds. */
export async function listModels(timeoutMs = 5000): Promise<OllamaModel[]> {
  const response = await timedFetch(`${baseUrl()}/api/tags`, {}, { timeoutMs }).catch(() => {
    throw new LlmError('unreachable', `Ingen Ollama-instans svarar på ${baseUrl()}.`, true);
  });
  if (!response.ok) throw new LlmError('failed', `Ollama svarade ${response.status}.`, true);

  const body = (await response.json()) as {
    models?: { name?: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }[];
  };
  return (body.models ?? [])
    .filter((model): model is { name: string } & typeof model => typeof model.name === 'string')
    .map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      parameters: model.details?.parameter_size ?? null,
      quantization: model.details?.quantization_level ?? null,
    }));
}

/** True when `model` is present, tolerating the implicit `:latest` tag. */
export async function hasModel(model: string): Promise<boolean> {
  const wanted = model.includes(':') ? model : `${model}:latest`;
  return (await listModels()).some((held) => held.name === wanted || held.name === model);
}

export interface PullProgress {
  status: string;
  completed: number;
  total: number;
}

/**
 * Downloads a model, reporting progress as it goes.
 *
 * Ollama streams newline-delimited JSON for this one, and a 4B vision model is
 * roughly 3 GB, so the caller wants to know it is moving rather than hung.
 * Server-only — the phone never pulls a model on someone else's machine —
 * so it stays here rather than in the shared core.
 */
export async function pullModel(
  model: string,
  onProgress?: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal: signal ?? null,
    });
  } catch {
    throw new LlmError('unreachable', `Ingen Ollama-instans svarar på ${baseUrl()}.`, true);
  }
  if (!response.ok || !response.body) {
    throw new LlmError('failed', `Nedladdningen misslyckades (${response.status}).`, true);
  }

  for await (const line of readLines(response.body)) {
    const event = safeParse(line);
    if (!event) continue;
    if (typeof event['error'] === 'string') throw new LlmError('failed', event['error']);
    onProgress?.({
      status: typeof event['status'] === 'string' ? event['status'] : 'working',
      completed: typeof event['completed'] === 'number' ? event['completed'] : 0,
      total: typeof event['total'] === 'number' ? event['total'] : 0,
    });
  }
}

/**
 * Runs one image through the model and returns its parsed JSON response.
 *
 * Delegates the wire call to the shared Ollama core — the request shape, the
 * structured-output fallback, the "model missing" 404 and the "not valid
 * JSON" failure are all decided there now, the same way for the phone and the
 * server.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  try {
    const result = await callOllama({
      baseUrl: baseUrl(),
      model: options.model,
      images: options.images,
      maxOutputTokens: options.maxOutputTokens,
      contextTokens: config.llm.contextTokens,
      structuredOutput: options.structuredOutput,
      extraInstructions: options.extraInstructions ?? null,
      compactPrompt: options.compactPrompt ?? true,
      userPrompt: options.prompt,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });

    return {
      raw: result.raw,
      model: result.model,
      promptTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      structuredOutputFallback: result.structuredOutputFallback,
    };
  } catch (error) {
    throw toLlmError(error, options.signal);
  }
}

function toLlmError(error: unknown, signal?: AbortSignal): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof ProviderError) {
    if (error.kind === 'aborted' || (signal?.aborted && error.kind !== 'timeout')) {
      // A caller-initiated abort (e.g. server shutdown) is not a model failure.
      return new LlmError('failed', error.message, false);
    }
    if (error.kind === 'timeout') {
      return new LlmError('timeout', error.message, true);
    }
    if (error.kind === 'network') {
      return new LlmError('unreachable', `Ingen Ollama-instans svarar på ${baseUrl()}.`, true);
    }
    if (error.status === 404) {
      return new LlmError('model-missing', error.message);
    }
    if (error.kind === 'invalid-response') {
      return new LlmError('bad-output', error.message, true);
    }
    return new LlmError('failed', error.message, error.retryable);
  }
  return new LlmError('unreachable', `Ingen Ollama-instans svarar på ${baseUrl()}.`, true);
}

/** Yields newline-delimited JSON from a streaming response body. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
      newline = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest) yield rest;
}

function safeParse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
