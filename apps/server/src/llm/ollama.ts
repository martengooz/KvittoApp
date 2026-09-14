/**
 * A minimal Ollama client — the inference host for the local model.
 *
 * Ollama rather than a bundled runtime because the requirement is "works on
 * Linux and macOS with a 4B vision model", and Ollama is the only option that
 * ships one binary covering CUDA, ROCm, Metal and plain CPU without this
 * project growing a native build step. Everything here is plain `fetch`
 * against its HTTP API: no SDK, no dependency.
 *
 * Only four calls are needed — is it there, what does it have, fetch a model,
 * run one image — so they are written out rather than pulled in.
 */

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
  system: string;
  prompt: string;
  /** Base64-encoded image bytes, without a data: prefix. */
  images: string[];
  /** JSON Schema the response must satisfy. */
  schema?: unknown;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  text: string;
  model: string;
  promptTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
}

function baseUrl(): string {
  return config.llm.baseUrl.replace(/\/+$/, '');
}

/** Whether Ollama is answering. Cheap; used by the health endpoint. */
export async function ping(timeoutMs = 2000): Promise<{ ok: boolean; version: string | null }> {
  try {
    const response = await withTimeout(
      (signal) => fetch(`${baseUrl()}/api/version`, { signal }),
      timeoutMs,
    );
    if (!response.ok) return { ok: false, version: null };
    const body = (await response.json()) as { version?: string };
    return { ok: true, version: body.version ?? null };
  } catch {
    return { ok: false, version: null };
  }
}

/** Models the local instance already holds. */
export async function listModels(timeoutMs = 5000): Promise<OllamaModel[]> {
  const response = await withTimeout((signal) => fetch(`${baseUrl()}/api/tags`, { signal }), timeoutMs).catch(
    () => {
      throw new LlmError('unreachable', `Ingen Ollama-instans svarar på ${baseUrl()}.`, true);
    },
  );
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
 * Runs one image through the model and returns its raw text.
 *
 * `format` carries the JSON Schema. Ollama constrains generation to it at the
 * sampler, which is a far stronger guarantee than asking a 4B model to please
 * return JSON — small models comply with prose instructions unreliably, and
 * this one has to produce a fixed shape every time.
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();

  let response: Response;
  try {
    response = await withTimeout(
      (signal) =>
        fetch(`${baseUrl()}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify({
            model: options.model,
            stream: false,
            ...(options.schema ? { format: options.schema } : {}),
            options: {
              num_predict: options.maxOutputTokens,
              // Deterministic: the same receipt must not extract differently on
              // a retry, or the merge below cannot tell a correction from noise.
              temperature: 0,
              // A receipt plus a schema plus the answer needs the room.
              num_ctx: config.llm.contextTokens,
            },
            messages: [
              { role: 'system', content: options.system },
              { role: 'user', content: options.prompt, images: options.images },
            ],
          }),
        }),
      options.timeoutMs,
      options.signal,
    );
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw new LlmError('unreachable', `Ingen Ollama-instans svarar på ${baseUrl()}.`, true);
  }

  if (response.status === 404) {
    throw new LlmError(
      'model-missing',
      `Modellen "${options.model}" finns inte lokalt. Kör "ollama pull ${options.model}".`,
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new LlmError('failed', detail.slice(0, 300) || `Ollama svarade ${response.status}.`, response.status >= 500);
  }

  const body = (await response.json()) as {
    message?: { content?: string };
    model?: string;
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  if (body.error) throw new LlmError('failed', body.error, true);

  const text = body.message?.content ?? '';
  if (!text.trim()) throw new LlmError('bad-output', 'Modellen svarade tomt.', true);

  return {
    text,
    model: body.model ?? options.model,
    promptTokens: body.prompt_eval_count ?? null,
    outputTokens: body.eval_count ?? null,
    durationMs: Date.now() - started,
  };
}

/**
 * Runs `work` with a deadline.
 *
 * A vision model on CPU can take minutes, and a hung request would otherwise
 * hold a queue slot forever. The external signal is honoured too, so a server
 * shutdown does not wait for inference to finish.
 */
async function withTimeout(
  work: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const forward = (): void => controller.abort(external?.reason);
  external?.addEventListener('abort', forward, { once: true });

  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !external?.aborted) {
      throw new LlmError('timeout', `Modellen svarade inte inom ${Math.round(timeoutMs / 1000)} s.`, true);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forward);
  }
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
