/** Thin HTTP client for the companion server. */

import type {
  BlobStatusResponse,
  ChangeSet,
  PairResponse,
  PullResponse,
  PushResponse,
  WhoAmIResponse,
} from '@kvitto/shared';
import { SYNC_PROTOCOL_VERSION } from '@kvitto/shared';

import { getDeviceId, getDeviceName, getDeviceToken } from './identity.js';

export class SyncError extends Error {
  readonly status: number | null;
  /** True when retrying later could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
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
  } catch (error) {
    // Offline, DNS failure or a CORS rejection all land here indistinguishably.
    throw new SyncError('Kunde inte nå servern.', { retryable: true });
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    const detail = body.message ?? body.error ?? `${response.status} ${response.statusText}`;
    throw new SyncError(detail, {
      status: response.status,
      // 5xx and 429 are worth retrying; a 401 or a 400 will fail identically.
      retryable: response.status >= 500 || response.status === 429,
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
