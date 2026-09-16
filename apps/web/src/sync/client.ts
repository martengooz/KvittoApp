/** Thin HTTP client for the companion server. */

import type {
  BlobStatusResponse,
  ChangeSet,
  PairResponse,
  PullResponse,
  PushResponse,
  SyncStatusResponse,
  WhoAmIResponse,
} from '@kvitto/shared';
import { describeError, SYNC_PROTOCOL_VERSION } from '@kvitto/shared';

import { appendClientDebug, type DebugEntry, type DebugValue } from '../core/debug-log.js';
import { getDeviceId, getDeviceName, getDeviceToken } from './identity.js';

export class SyncError extends Error {
  readonly status: number | null;
  /** True when retrying later could plausibly succeed. */
  readonly retryable: boolean;
  /** Delay the server asked for, in ms, when it sent a `Retry-After`. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = 'SyncError';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are accepted. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) throw new SyncError('Ingen server-URL angiven.');
  return trimmed;
}

async function request<T>(
  serverUrl: string,
  path: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, headers, ...rest } = init;
  const finalHeaders = new Headers(headers);
  const method = rest.method ?? 'GET';
  const safePath = path.split('?')[0] ?? path;
  const started = performance.now();

  if (auth) {
    const token = await getDeviceToken();
    if (!token) throw new SyncError('Enheten är inte parkopplad.', { status: 401 });
    finalHeaders.set('authorization', `Bearer ${token}`);
  }
  if (rest.body && typeof rest.body === 'string' && !finalHeaders.has('content-type')) {
    finalHeaders.set('content-type', 'application/json');
  }

  const targetUrl = `${normalizeBase(serverUrl)}${path}`;
  const requestDetails = {
    method,
    url: redactUrl(targetUrl),
    headers: headersToDebug(finalHeaders),
    body: requestBodyToDebug(rest.body, finalHeaders.get('content-type'), safePath),
  };
  const mixedContent = location.protocol === 'https:' && new URL(targetUrl).protocol === 'http:';
  if (mixedContent) {
    appendClientDebug('error', `${method} ${safePath}`, {
      outcome: 'blocked-mixed-content',
      durationMs: Math.round(performance.now() - started),
      request: requestDetails,
      response: emptyResponse(),
      browser: browserContext(targetUrl),
      error: {
        name: 'SecurityError',
        message: 'HTTPS-sidan får inte anropa en HTTP-server.',
      },
    });
    throw new SyncError(
      'Appen kör HTTPS men serveradressen använder HTTP. Ange serverns HTTPS-adress i QR-koden.',
    );
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, { ...rest, headers: finalHeaders });
  } catch (error) {
    appendClientDebug('error', `${method} ${safePath}`, {
      outcome: 'network-error',
      durationMs: Math.round(performance.now() - started),
      request: requestDetails,
      response: emptyResponse(),
      browser: browserContext(targetUrl),
      error: errorToDebug(error),
    });
    // Offline, DNS failure or a CORS rejection all land here indistinguishably.
    throw new SyncError(networkErrorMessage(targetUrl), { retryable: true });
  }

  const responseBody = await responseBodyToDebug(response.clone(), safePath);
  appendClientDebug(response.ok ? 'info' : response.status >= 500 ? 'error' : 'warn', `${method} ${safePath}`, {
    outcome: response.ok ? 'success' : 'http-error',
    status: response.status,
    durationMs: Math.round(performance.now() - started),
    request: requestDetails,
    response: {
      status: response.status,
      statusText: response.statusText,
      url: redactUrl(response.url),
      redirected: response.redirected,
      headers: headersToDebug(response.headers),
      body: responseBody,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    const detail = body.message ?? body.error ?? `${response.status} ${response.statusText}`;
    throw new SyncError(detail, {
      status: response.status,
      // 5xx and 429 are worth retrying; a 401 or a 400 will fail identically.
      retryable: response.status >= 500 || response.status === 429,
      // A server under load says how long to wait; obeying it beats guessing.
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    });
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function headersToDebug(headers: Headers): Record<string, DebugValue> {
  return Object.fromEntries(headers.entries());
}

function requestBodyToDebug(body: BodyInit | null | undefined, contentType: string | null, path: string): DebugValue {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return redactHttpBody(parseDebugText(body, contentType), path);
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (body instanceof Blob) {
    return { type: body.type || contentType || 'application/octet-stream', byteLength: body.size, content: '[binary]' };
  }
  if (body instanceof FormData) {
    return Object.fromEntries(Array.from(body.entries(), ([key, value]) => [
      key,
      typeof value === 'string'
        ? value
        : { name: value.name, type: value.type, byteLength: value.size, content: '[binary]' },
    ]));
  }
  if (body instanceof ArrayBuffer) return { type: contentType ?? 'application/octet-stream', byteLength: body.byteLength, content: '[binary]' };
  if (ArrayBuffer.isView(body)) return { type: contentType ?? 'application/octet-stream', byteLength: body.byteLength, content: '[binary]' };
  return `[${body.constructor.name}]`;
}

async function responseBodyToDebug(response: Response, path: string): Promise<DebugValue> {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  const contentLength = Number(response.headers.get('content-length'));
  if (contentType.startsWith('image/') || contentType === 'application/octet-stream') {
    return {
      type: contentType || 'application/octet-stream',
      byteLength: Number.isFinite(contentLength) ? contentLength : null,
      content: '[binary]',
    };
  }
  try {
    const text = await response.text();
    return redactHttpBody(parseDebugText(text, contentType), path);
  } catch (error) {
    return { content: '[unavailable]', error: describeError(error) };
  }
}

function redactHttpBody(value: DebugValue, path: string, withinSecrets = false): DebugValue {
  if (Array.isArray(value)) return value.map((item) => redactHttpBody(item, path, withinSecrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const nestedInSecrets = withinSecrets || key.toLowerCase() === 'secrets';
    const secretValue = key.toLowerCase() === 'value' && (nestedInSecrets || path.startsWith('/secrets'));
    return [key, secretValue ? '[redacted]' : redactHttpBody(child, path, nestedInSecrets)];
  }));
}

function parseDebugText(text: string, contentType: string | null): DebugValue {
  if (!text) return null;
  if (contentType?.includes('json')) {
    try {
      return JSON.parse(text) as DebugValue;
    } catch {
      // Keep malformed JSON visible as text.
    }
  }
  return text;
}

function emptyResponse(): Record<string, DebugValue> {
  return { status: null, statusText: '', url: '', redirected: false, headers: {}, body: null };
}

function browserContext(targetUrl: string): Record<string, DebugValue> {
  const target = new URL(targetUrl);
  return {
    online: navigator.onLine,
    origin: location.origin,
    secureContext: window.isSecureContext,
    targetOrigin: target.origin,
    crossOrigin: target.origin !== location.origin,
    mixedContent: location.protocol === 'https:' && target.protocol === 'http:',
    userAgent: navigator.userAgent,
  };
}

function errorToDebug(error: unknown): Record<string, DebugValue> {
  if (!(error instanceof Error)) return { name: 'UnknownError', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    cause: error.cause === undefined ? null : String(error.cause),
  };
}

function networkErrorMessage(targetUrl: string): string {
  const hostname = new URL(targetUrl).hostname;
  if (isLoopbackHost(hostname) && !isLoopbackHost(location.hostname)) {
    return 'QR-koden pekar på serverns localhost. Skapa en ny kod med serverns LAN- eller HTTPS-adress.';
  }
  if (!navigator.onLine) return 'Enheten är offline.';
  return 'Kunde inte nå servern. Kontrollera adressen, samma nätverk, brandvägg och CORS.';
}

function redactUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of url.searchParams.keys()) {
    if (/code|token|key|secret/i.test(key)) url.searchParams.set(key, '[redacted]');
  }
  return url.href;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export async function pairDevice(serverUrl: string, code: string): Promise<PairResponse> {
  return request<PairResponse>(serverUrl, '/auth/pair', {
    auth: false,
    method: 'POST',
    body: JSON.stringify({
      code: code.trim().toUpperCase(),
      deviceId: await getDeviceId(),
      deviceName: await getDeviceName(),
    }),
  });
}

export async function whoAmI(serverUrl: string): Promise<WhoAmIResponse> {
  return request<WhoAmIResponse>(serverUrl, '/auth/me');
}

export async function serverHealth(serverUrl: string): Promise<{ protocolVersion: number }> {
  return request(serverUrl, '/health', { auth: false });
}

export async function pushChanges(serverUrl: string, changes: ChangeSet): Promise<PushResponse> {
  return request<PushResponse>(serverUrl, '/sync/push', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: await getDeviceId(),
      protocolVersion: SYNC_PROTOCOL_VERSION,
      changes,
    }),
  });
}

export async function pullChanges(serverUrl: string, since: number, limit = 500): Promise<PullResponse> {
  const params = new URLSearchParams({ since: String(since), limit: String(limit) });
  return request<PullResponse>(serverUrl, `/sync/pull?${params.toString()}`);
}

/**
 * Asks what is waiting without downloading it.
 *
 * One small response instead of a page of records the device may already have,
 * which is what most heartbeats turn out to be.
 */
export async function syncStatus(serverUrl: string, since?: number): Promise<SyncStatusResponse> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set('since', String(since));
  const query = params.toString();
  return request<SyncStatusResponse>(serverUrl, `/sync/status${query ? `?${query}` : ''}`);
}

/** What the companion server's local model is doing, if it has one. */
export interface LlmStatusResponse {
  enabled: boolean;
  runtime: {
    state: 'off' | 'missing' | 'starting' | 'no-model' | 'pulling' | 'ready';
    model: string;
    version: string | null;
    managed: boolean;
    platform: string;
    pull: { status: string; percent: number } | null;
    detail: string | null;
    installHint: string | null;
  };
  models: string[];
  queue: { pending: number; running: number; done: number; failed: number; skipped: number; waiting: number };
  lastPass: { claimed: number; extracted: number; failed: number; durationMs: number } | null;
  failures: { receiptId: string; attempts: number; nextAttemptAt: number; error: string | null }[];
  serverTime: number;
}

export async function llmStatus(serverUrl: string): Promise<LlmStatusResponse> {
  return request<LlmStatusResponse>(serverUrl, '/llm/status');
}

export async function llmStart(serverUrl: string): Promise<void> {
  await request<void>(serverUrl, '/llm/start', { method: 'POST' });
}

/** Asks the server to read whatever is queued, now. */
export async function llmScan(serverUrl: string, size?: number): Promise<{ extracted: number; failed: number; skipped: number; blocked: string | null }> {
  return request(serverUrl, '/llm/scan', {
    method: 'POST',
    body: JSON.stringify(size === undefined ? {} : { size }),
  });
}

/** Starts the model download. Progress shows up in {@link llmStatus}. */
export async function llmPull(serverUrl: string): Promise<void> {
  await request<void>(serverUrl, '/llm/pull', { method: 'POST', body: '{}' });
}

/** Requeues one receipt, or every parked one when `receiptId` is omitted. */
export async function llmRequeue(serverUrl: string, receiptId?: string): Promise<{ requeued: number }> {
  return request(serverUrl, '/llm/requeue', {
    method: 'POST',
    body: JSON.stringify(receiptId ? { receiptId } : {}),
  });
}

export interface ServerDebugResponse {
  entries: DebugEntry[];
  capacity: number;
  serverTime: number;
}

export async function serverDebugLog(serverUrl: string, limit = 500): Promise<ServerDebugResponse> {
  return request<ServerDebugResponse>(serverUrl, `/debug/logs?limit=${limit}`);
}

export async function clearServerDebugLog(serverUrl: string): Promise<void> {
  await request<void>(serverUrl, '/debug/logs', { method: 'DELETE' });
}

export async function blobStatus(serverUrl: string, ids: string[]): Promise<BlobStatusResponse> {
  return request<BlobStatusResponse>(serverUrl, '/blobs/status', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

export async function uploadBlob(serverUrl: string, id: string, data: Blob): Promise<void> {
  await request<void>(serverUrl, `/blobs/${id}`, {
    method: 'PUT',
    headers: { 'content-type': data.type || 'application/octet-stream' },
    body: data,
  });
}

export async function downloadBlob(serverUrl: string, id: string): Promise<Blob> {
  const token = await getDeviceToken();
  if (!token) throw new SyncError('Enheten är inte parkopplad.', { status: 401 });

  let response: Response;
  try {
    response = await fetch(`${normalizeBase(serverUrl)}/blobs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SyncError('Kunde inte nå servern.', { retryable: true });
  }
  if (!response.ok) {
    throw new SyncError(`Kunde inte hämta bilden (${response.status}).`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }
  return response.blob();
}
