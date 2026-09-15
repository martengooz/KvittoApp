/**
 * Shared plumbing for calling a vision-capable LLM provider over `fetch`.
 *
 * Anthropic, OpenAI(-compatible) and Ollama were each implemented twice — once
 * for the phone, once for the server — and the six implementations agreed on
 * everything around the wire format: a timeout, the structured-output
 * fallback retry, the status→message mapping, and the "not valid JSON"
 * failure. This module is that agreement, written once.
 *
 * Dependency-free and built only on `fetch`/`AbortController`/`DOMException`,
 * which both a browser and Node 18+ provide, so it runs unchanged on the
 * phone and on the server.
 */

import { extractJsonObject } from '../prompt.js';

/** Why a {@link ProviderError} happened, for callers that want to react to it. */
export type ProviderErrorKind =
  /** `fetch` itself threw — offline, DNS failure, a CORS rejection. */
  | 'network'
  /** The request's deadline elapsed. */
  | 'timeout'
  /** An external `AbortSignal` fired. */
  | 'aborted'
  /** The provider answered with a non-2xx status. */
  | 'http'
  /** A 2xx response that was not a usable result (bad JSON, a refusal, a truncation). */
  | 'invalid-response'
  | 'other';

/**
 * Raised for any provider failure a caller can show to a user.
 *
 * Every adapter (`ExtractionError` on the phone, `ProxyError` on the server)
 * wraps one of these, keeping its `message`, `status` and `retryable` — this
 * is the one place those get decided.
 */
export class ProviderError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly kind: ProviderErrorKind;

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean; kind?: ProviderErrorKind; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.kind = options.kind ?? 'other';
  }
}

/** Applied to a call that does not name its own deadline. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** The one message every provider used for "the model's output was not JSON". */
export const JSON_INVALID_MESSAGE = 'Modellen svarade inte med giltig JSON.';

/** The base64 image payload every provider call needs. */
export interface ProviderImage {
  /** Base64-encoded bytes, without a `data:` prefix. */
  base64: string;
  mediaType: string;
}

/** What every provider call function hands back, before `normalizeExtraction`. */
export interface ProviderCallResult {
  /** The model's parsed JSON response. */
  raw: Record<string, unknown>;
  /** The model the provider actually used — can differ from what was requested. */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when structured output was requested but the provider refused it. */
  structuredOutputFallback: boolean;
  durationMs: number;
}

/** CORS and DNS failures both surface as an opaque `TypeError` from `fetch`. */
export function describeNetworkError(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return 'Avbruten.';
  if (error instanceof TypeError) {
    return (
      'Kunde inte nå servern. Kontrollera adressen, och att den tillåter anrop ' +
      'från webbläsaren (CORS).'
    );
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one `fetch` with a deadline, folding a network failure or an expired
 * timer into a {@link ProviderError} — the only timeout discipline anywhere
 * in this codebase used to live in one place (the server's local-model
 * client); every provider call goes through this now.
 */
export async function timedFetch(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const forward = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', forward, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ProviderError('Avbruten.', { kind: 'aborted', cause: error });
    }
    if (controller.signal.aborted) {
      throw new ProviderError(`Tidsgränsen (${Math.round(timeoutMs / 1000)} s) överskreds.`, {
        kind: 'timeout',
        retryable: true,
        cause: error,
      });
    }
    throw new ProviderError(describeNetworkError(error), { kind: 'network', retryable: true, cause: error });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forward);
  }
}

export interface RetryOptions {
  /** Total attempts, first try included — 3 means "2 retries". */
  attempts: number;
  isRetryable: (response: Response) => boolean;
  /** Delay before attempt `n` (1-based; attempt 1 never delays). Exponential by default. */
  backoffMs?: (attempt: number) => number;
  signal?: AbortSignal;
}

function defaultBackoff(attempt: number): number {
  return 300 * 2 ** (attempt - 1);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Avbruten.', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Retries a `fetch` call for retryable failures only, with backoff.
 *
 * Replaces the Anthropic SDK's `maxRetries: 2`, lost when `@anthropic-ai/sdk`
 * was dropped from the browser bundle in favour of calling `fetch` directly —
 * the same wire call the server already made by hand.
 */
export async function withRetry(send: () => Promise<Response>, options: RetryOptions): Promise<Response> {
  let lastResponse: Response | undefined;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (attempt > 1) await delay(options.backoffMs?.(attempt) ?? defaultBackoff(attempt), options.signal);
    const response = await send();
    if (response.ok || attempt === options.attempts || !options.isRetryable(response)) return response;
    lastResponse = response;
  }
  // Unreachable in practice (the loop always returns on its last iteration),
  // but keeps the return type honest without a non-null assertion at the call site.
  return lastResponse ?? (await send());
}

/** True for the status codes worth retrying: rate limits and server errors. */
export function isRetryableStatus(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

/**
 * Sends the structured request; if the provider rejects the schema (400/422)
 * on a structured attempt, retries once with plain-prompt JSON instead.
 *
 * Not every model, and not every OpenAI-compatible endpoint, accepts a JSON
 * Schema — this turns that into one retry instead of a raw error, the same
 * way for every provider.
 */
export async function sendWithStructuredFallback(
  structuredOutput: boolean,
  send: (structured: boolean) => Promise<Response>,
): Promise<{ response: Response; structuredOutputFallback: boolean }> {
  const response = await send(structuredOutput);
  if (!response.ok && structuredOutput && (response.status === 400 || response.status === 422)) {
    return { response: await send(false), structuredOutputFallback: true };
  }
  return { response, structuredOutputFallback: false };
}

/** Best-effort extraction of a provider's own error message from its body. */
export async function readErrorDetail(response: Response): Promise<string> {
  let detail = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.clone().json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const message = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message);
    if (message) detail = message.slice(0, 300);
    return detail;
  } catch {
    // Not JSON; fall through to plain text.
  }
  try {
    const text = (await response.text()).trim();
    if (text) detail = text.slice(0, 300);
  } catch {
    // Body already consumed or unreadable — the status line stands.
  }
  return detail;
}

export interface StatusMessageOptions {
  /** Override for 404 — providers describe "model missing" differently. */
  notFound?: string;
}

/**
 * Turns a failed HTTP response into a {@link ProviderError} with a Swedish,
 * user-facing message — written once for the status codes every provider
 * shares (401/403/413/429/5xx). 404 takes an override because Ollama can name
 * the exact `ollama pull` command while a cloud API cannot.
 */
export async function providerErrorForResponse(
  response: Response,
  options: StatusMessageOptions = {},
): Promise<ProviderError> {
  const detail = await readErrorDetail(response);
  switch (response.status) {
    case 401:
      return new ProviderError('API-nyckeln avvisades. Kontrollera att den är korrekt.', {
        status: 401,
        kind: 'http',
      });
    case 403:
      return new ProviderError('Nyckeln saknar behörighet till den här modellen.', { status: 403, kind: 'http' });
    case 404:
      return new ProviderError(
        options.notFound ?? 'Modellen eller endpointen hittades inte. Kontrollera modellnamn och adress.',
        { status: 404, kind: 'http' },
      );
    case 413:
      return new ProviderError('Bilden var för stor. Sänk maxupplösningen i inställningarna.', {
        status: 413,
        kind: 'http',
      });
    case 429:
      return new ProviderError('Hastighetsbegränsad. Försök igen om en stund.', {
        status: 429,
        retryable: true,
        kind: 'http',
      });
    default:
      if (response.status >= 500) {
        return new ProviderError('Tjänsten svarade med ett serverfel. Försök igen.', {
          status: response.status,
          retryable: true,
          kind: 'http',
        });
      }
      return new ProviderError(detail, { status: response.status, kind: 'http' });
  }
}

/** Parses the model's text output as JSON, failing the same way everywhere. */
export function parseModelJson(text: string): Record<string, unknown> {
  const raw = extractJsonObject(text);
  if (!raw) throw new ProviderError(JSON_INVALID_MESSAGE, { kind: 'invalid-response' });
  return raw;
}
