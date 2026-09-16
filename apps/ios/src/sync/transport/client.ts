import { type BlobStatusResponse, type PairRequest, type PairResponse, type PullQuery, type PullResponse, type PushRequest, type PushResponse, type SyncStatusResponse, type WhoAmIResponse } from '@kvitto/shared/domain';
import type { CredentialsPort, Logger, SyncTransportPort } from '@kvitto/client-core/ports';

export interface SyncTransportError extends Error {
  status: number | null;
  retryable: boolean;
  retryAfterMs: number | null;
}

export class HttpSyncTransportError extends Error implements SyncTransportError {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = 'HttpSyncTransportError';
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export interface BlobUploadDescriptor {
  id: string;
  mimeType: string;
  filePath: string;
}

export interface BlobDownloadRequest {
  id: string;
}

export interface BlobFilePort {
  getUploadDescriptor(id: string): Promise<BlobUploadDescriptor | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeDownloadedBlob(input: { id: string; mimeType: string; bytes: Uint8Array }): Promise<void>;
}

export interface DeviceIdentityPort {
  getDeviceId(): Promise<string>;
  getDeviceName(): Promise<string>;
}

export interface ProtocolV2TransportOptions {
  serverUrl: string;
  credentials: CredentialsPort;
  deviceIdentity: DeviceIdentityPort;
  blobFiles: BlobFilePort;
  logger?: Logger;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class ProtocolV2Transport implements SyncTransportPort {
  readonly #serverUrl: string;
  readonly #credentials: CredentialsPort;
  readonly #identity: DeviceIdentityPort;
  readonly #blobFiles: BlobFilePort;
  readonly #logger?: Logger;
  readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;

  constructor(options: ProtocolV2TransportOptions) {
    this.#serverUrl = normalizeBaseUrl(options.serverUrl);
    this.#credentials = options.credentials;
    this.#identity = options.deviceIdentity;
    this.#blobFiles = options.blobFiles;
    this.#logger = options.logger;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async pair(request: PairRequest, options: { signal?: AbortSignal } = {}): Promise<PairResponse> {
    const response = await this.#requestJson<PairResponse>('/auth/pair', {
      method: 'POST',
      auth: false,
      signal: options.signal,
      body: {
        code: request.code.trim().toUpperCase(),
        deviceId: request.deviceId,
        deviceName: request.deviceName,
      },
    });

    await this.#credentials.set({
      deviceId: response.deviceId,
      token: response.token,
      accountId: response.accountId,
    });

    return response;
  }

  async whoAmI(options: { signal?: AbortSignal } = {}): Promise<WhoAmIResponse> {
    return this.#requestJson<WhoAmIResponse>('/auth/me', {
      method: 'GET',
      auth: true,
      signal: options.signal,
    });
  }

  async status(since: number, options: { signal?: AbortSignal } = {}): Promise<SyncStatusResponse> {
    const params = new URLSearchParams({ since: String(Math.max(0, since)) });
    return this.#requestJson<SyncStatusResponse>(`/sync/status?${params.toString()}`, {
      method: 'GET',
      auth: true,
      signal: options.signal,
    });
  }

  async push(request: PushRequest, options: { signal?: AbortSignal } = {}): Promise<PushResponse> {
    return this.#requestJson<PushResponse>('/sync/push', {
      method: 'POST',
      auth: true,
      signal: options.signal,
      body: {
        deviceId: request.deviceId,
        protocolVersion: request.protocolVersion,
        changes: request.changes,
      },
    });
  }

  async pull(query: PullQuery, options: { signal?: AbortSignal } = {}): Promise<PullResponse> {
    const params = new URLSearchParams({
      since: String(Math.max(0, query.since)),
      limit: String(Math.max(1, query.limit ?? 500)),
    });
    return this.#requestJson<PullResponse>(`/sync/pull?${params.toString()}`, {
      method: 'GET',
      auth: true,
      signal: options.signal,
    });
  }

  async uploadBlobs(ids: string[], options: { signal?: AbortSignal } = {}): Promise<void> {
    if (ids.length === 0) return;

    const status = await this.#requestJson<BlobStatusResponse>('/blobs/status', {
      method: 'POST',
      auth: true,
      signal: options.signal,
      body: { ids },
    });

    for (const id of status.missing) {
      const descriptor = await this.#blobFiles.getUploadDescriptor(id);
      if (!descriptor) {
        this.#logger?.warn('sync.transport.blob-missing-local', { id });
        continue;
      }

      const data = await this.#blobFiles.readFile(descriptor.filePath);
      await this.#request('/blobs/' + encodeURIComponent(id), {
        method: 'PUT',
        auth: true,
        signal: options.signal,
        headers: {
          'content-type': descriptor.mimeType || 'application/octet-stream',
        },
        body: data,
      });
    }
  }

  async downloadBlobs(ids: string[], options: { signal?: AbortSignal } = {}): Promise<void> {
    for (const id of ids) {
      const response = await this.#request('/blobs/' + encodeURIComponent(id), {
        method: 'GET',
        auth: true,
        signal: options.signal,
      });

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      const bytes = new Uint8Array(await response.arrayBuffer());
      await this.#blobFiles.writeDownloadedBlob({
        id,
        mimeType: contentType,
        bytes,
      });
    }
  }

  async pairCurrentDevice(code: string, options: { signal?: AbortSignal } = {}): Promise<PairResponse> {
    return this.pair({
      code,
      deviceId: await this.#identity.getDeviceId(),
      deviceName: await this.#identity.getDeviceName(),
    }, options);
  }

  async #requestJson<T>(
    path: string,
    options: {
      method: string;
      auth: boolean;
      signal?: AbortSignal;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const response = await this.#request(path, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async #request(
    path: string,
    options: {
      method: string;
      auth: boolean;
      signal?: AbortSignal;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    if (options.auth) {
      const credentials = await this.#credentials.get();
      if (!credentials.token) {
        throw new HttpSyncTransportError('Device is not paired.', {
          status: 401,
          retryable: false,
        });
      }
      headers.set('authorization', `Bearer ${credentials.token}`);
    }

    this.#logger?.debug('sync.transport.request', {
      path,
      method: options.method,
      headers: redactHeaders(headers),
      body: redactBodyForLog(options.body),
    });

    let response: Response;
    try {
      response = await this.#fetch(this.#serverUrl + path, {
        method: options.method,
        headers,
        signal: options.signal,
        body: serializeBody(options.body, headers.get('content-type')),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new HttpSyncTransportError('Sync cancelled.', {
          status: null,
          retryable: false,
        });
      }
      this.#logger?.error('sync.transport.network-error', {
        path,
        method: options.method,
        error: describeError(error),
      });
      throw new HttpSyncTransportError('Network error while contacting sync server.', {
        status: null,
        retryable: true,
      });
    }

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.clone().json()) as { message?: string; error?: string };
        message = body.message ?? body.error ?? message;
      } catch {
        // Keep status text fallback.
      }

      this.#logger?.warn('sync.transport.http-error', {
        path,
        method: options.method,
        status: response.status,
        retryAfterMs,
        message: redactText(message),
      });

      throw new HttpSyncTransportError(message, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
        retryAfterMs,
      });
    }

    this.#logger?.debug('sync.transport.ok', {
      path,
      method: options.method,
      status: response.status,
    });
    return response;
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Missing sync server URL.');
  return trimmed.replace(/\/+$/, '');
}

function serializeBody(body: unknown, contentType: string | null): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (body instanceof Uint8Array) return body as unknown as BodyInit;
  if (typeof body === 'string') return body;
  if (contentType?.includes('json')) return JSON.stringify(body);
  return JSON.stringify(body);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const numeric = Number(header);
  if (Number.isFinite(numeric)) return Math.max(0, Math.round(numeric * 1000));
  const parsedDate = Date.parse(header);
  if (!Number.isFinite(parsedDate)) return null;
  return Math.max(0, parsedDate - Date.now());
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'name' in error && (error as { name: string }).name === 'AbortError');
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function redactBodyForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactBodyForLog);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|authorization|api[_-]?key|password|code/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    if (/receipt|changes|text|notes/i.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactBodyForLog(child);
  }
  return out;
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (/authorization|cookie|set-cookie|token|api[_-]?key/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/[A-Z0-9]{4,8}/g, '[redacted]');
}
