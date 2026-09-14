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
import { SYNC_PROTOCOL_VERSION } from '@kvitto/shared';

import { appendClientDebug, type DebugEntry } from '../core/debug-log.js';
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

  let response: Response;
  try {
    response = await fetch(`${normalizeBase(serverUrl)}${path}`, { ...rest, headers: finalHeaders });
  } catch {
    appendClientDebug('error', `${method} ${safePath}`, {
      outcome: 'network-error',
      durationMs: Math.round(performance.now() - started),
    });
    // Offline, DNS failure or a CORS rejection all land here indistinguishably.
    throw new SyncError('Kunde inte nå servern.', { retryable: true });
  }

  appendClientDebug(response.ok ? 'info' : response.status >= 500 ? 'error' : 'warn', `${method} ${safePath}`, {
    status: response.status,
    durationMs: Math.round(performance.now() - started),
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

export async function serverDebugLog(serverUrl: string, limit = 200): Promise<ServerDebugResponse> {
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
