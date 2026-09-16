/** @jest-environment node */

import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ENTITY_KINDS, SYNC_PROTOCOL_VERSION, type AnyEntity, type ChangeSet } from '@kvitto/shared/domain';

import { createCredentialsAdapter, getOrCreateDeviceId, type IdentityStateStore, type TokenVault, unpairDevice } from '../src/sync/identity/index';
import { withRetry } from '../src/sync/retry/index';
import { ProtocolV2Transport, type BlobFilePort, type BlobUploadDescriptor } from '../src/sync/transport/client';

class TestHeaders {
  #map = new Map<string, string>();

  constructor(input: Record<string, string | string[] | undefined>) {
    for (const [key, value] of Object.entries(input)) {
      if (Array.isArray(value)) this.#map.set(key.toLowerCase(), value.join(', '));
      else if (value !== undefined) this.#map.set(key.toLowerCase(), value);
    }
  }

  get(name: string): string | null {
    return this.#map.get(name.toLowerCase()) ?? null;
  }
}

class TestResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: TestHeaders;
  readonly url: string;
  readonly redirected = false;
  #body: Buffer;

  constructor(input: { status: number; statusText: string; headers: Record<string, string | string[] | undefined>; url: string; body: Buffer }) {
    this.status = input.status;
    this.statusText = input.statusText;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new TestHeaders(input.headers);
    this.url = input.url;
    this.#body = input.body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.#body.toString('utf8'));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const view = Uint8Array.from(this.#body);
    return view.buffer;
  }

  clone(): TestResponse {
    return new TestResponse({
      status: this.status,
      statusText: this.statusText,
      headers: Object.fromEntries(this.headersEntries()),
      url: this.url,
      body: Buffer.from(this.#body),
    });
  }

  private headersEntries(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const key of ['content-type', 'retry-after']) {
      const value = this.headers.get(key);
      if (value !== null) out.push([key, value]);
    }
    return out;
  }
}

async function nodeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(String(input));
  const options: RequestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    method: init.method ?? 'GET',
    headers: toHeaderObject(init.headers),
  };

  const body = toBodyBuffer(init.body);

  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        resolve(new TestResponse({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
          url: target.href,
          body: Buffer.concat(chunks),
        }) as unknown as Response);
      });
    });

    request.on('error', (error) => {
      reject(error);
    });

    const onAbort = (): void => {
      const abortError = new Error('Sync cancelled.');
      abortError.name = 'AbortError';
      request.destroy(abortError);
    };
    init.signal?.addEventListener('abort', onAbort, { once: true });

    if (body) request.write(body);
    request.end();
  });
}

function toHeaderObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, String(value)]));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}

function toBodyBuffer(body: BodyInit | null | undefined): Buffer | null {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(String(body));
}

class MemoryStateStore implements IdentityStateStore {
  readonly map = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class MemoryTokenVault implements TokenVault {
  token: string | null = null;

  async get(): Promise<string | null> {
    return this.token;
  }

  async set(token: string): Promise<void> {
    this.token = token;
  }

  async clear(): Promise<void> {
    this.token = null;
  }
}

class TempBlobFiles implements BlobFilePort {
  readonly uploads = new Map<string, BlobUploadDescriptor>();
  readonly downloads = new Map<string, { mimeType: string; bytes: Uint8Array; path: string }>();

  constructor(private readonly dir: string) {}

  async stageUpload(id: string, mimeType: string, bytes: Uint8Array): Promise<void> {
    const path = join(this.dir, `${id}.upload`);
    await writeFile(path, Buffer.from(bytes));
    this.uploads.set(id, { id, mimeType, filePath: path });
  }

  async getUploadDescriptor(id: string): Promise<BlobUploadDescriptor | null> {
    return this.uploads.get(id) ?? null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const data = await readFile(path);
    return new Uint8Array(data);
  }

  async writeDownloadedBlob(input: { id: string; mimeType: string; bytes: Uint8Array }): Promise<void> {
    const path = join(this.dir, `${input.id}.download`);
    await writeFile(path, Buffer.from(input.bytes));
    this.downloads.set(input.id, { mimeType: input.mimeType, bytes: input.bytes, path });
  }
}

type DeviceContext = {
  deviceId: string;
  deviceName: string;
  accountId: string;
};

type ServerState = {
  cursor: number;
  epoch: string;
  push429Left: number;
  statusDelayMs: number;
  records: Map<string, Map<string, AnyEntity>>;
  tokens: Map<string, DeviceContext>;
  blobs: Map<string, { mimeType: string; bytes: Buffer }>;
  pairCounter: Map<string, number>;
};

async function startServer(): Promise<{ baseUrl: string; state: ServerState; close: () => Promise<void> }> {
  const state: ServerState = {
    cursor: 0,
    epoch: 'epoch-1',
    push429Left: 0,
    statusDelayMs: 0,
    records: new Map(ENTITY_KINDS.map((kind) => [kind, new Map()])),
    tokens: new Map(),
    blobs: new Map(),
    pairCounter: new Map(),
  };

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, state);
    } catch (error) {
      sendJson(res, 500, {
        error: 'server_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to start test server.');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function route(req: IncomingMessage, res: ServerResponse, state: ServerState): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (method === 'POST' && url.pathname === '/auth/pair') {
    const body = (await readJson(req)) as { code: string; deviceId: string; deviceName: string };
    if (body.code !== 'PAIR-OK') {
      return sendJson(res, 400, { error: 'pairing_failed', message: 'Bad pairing code.' });
    }

    const count = (state.pairCounter.get(body.deviceId) ?? 0) + 1;
    state.pairCounter.set(body.deviceId, count);

    const token = `token-${body.deviceId}-${count}`;
    const context: DeviceContext = {
      deviceId: body.deviceId,
      deviceName: body.deviceName,
      accountId: 'acc-1',
    };
    state.tokens.set(token, context);

    return sendJson(res, 200, {
      token,
      ...context,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      serverTime: Date.now(),
    });
  }

  const context = requireAuth(req, res, state);
  if (!context) return;

  if (method === 'GET' && url.pathname === '/auth/me') {
    return sendJson(res, 200, {
      deviceId: context.deviceId,
      deviceName: context.deviceName,
      accountId: context.accountId,
      protocolVersion: SYNC_PROTOCOL_VERSION,
      serverTime: Date.now(),
      aiProxyEnabled: false,
      aiProxyModels: [],
    });
  }

  if (method === 'GET' && url.pathname === '/sync/status') {
    if (state.statusDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, state.statusDelayMs));
    }
    const since = Number(url.searchParams.get('since') ?? '0');
    const hasChanges = since < state.cursor;
    return sendJson(res, 200, {
      cursor: state.cursor,
      epoch: state.epoch,
      hasChanges,
      diverged: since > state.cursor,
      serverTime: Date.now(),
    });
  }

  if (method === 'POST' && url.pathname === '/sync/push') {
    if (state.push429Left > 0) {
      state.push429Left -= 1;
      res.statusCode = 429;
      res.setHeader('retry-after', '1');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'too_busy', message: 'Try again shortly.' }));
      return;
    }

    const body = (await readJson(req)) as { protocolVersion: number; changes: ChangeSet };
    if (body.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      return sendJson(res, 409, {
        error: 'protocol_mismatch',
        message: 'Wrong protocol version.',
        protocolVersion: SYNC_PROTOCOL_VERSION,
      });
    }

    const results: Array<{ kind: string; id: string; rev: number; outcome: 'applied' | 'stale' }> = [];

    for (const kind of ENTITY_KINDS) {
      const rows = body.changes[kind] ?? [];
      const table = state.records.get(kind)!;
      for (const row of rows) {
        const existing = table.get(row.id);
        if (existing && existing.updatedAt > row.updatedAt) {
          results.push({ kind, id: row.id, rev: existing.rev, outcome: 'stale' });
          continue;
        }

        state.cursor += 1;
        const next = { ...row, rev: state.cursor, dirty: 0 } as AnyEntity;
        table.set(row.id, next);
        results.push({ kind, id: row.id, rev: state.cursor, outcome: 'applied' });
      }
    }

    return sendJson(res, 200, {
      results,
      cursor: state.cursor,
      serverTime: Date.now(),
    });
  }

  if (method === 'GET' && url.pathname === '/sync/pull') {
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '500');

    const entries: Array<{ kind: string; row: AnyEntity }> = [];
    for (const kind of ENTITY_KINDS) {
      for (const row of state.records.get(kind)!.values()) {
        if (row.rev > since) entries.push({ kind, row });
      }
    }
    entries.sort((a, b) => a.row.rev - b.row.rev);

    const page = entries.slice(0, limit);
    const hasMore = entries.length > limit;
    const changes: ChangeSet = {};
    for (const entry of page) {
      const current = ((changes as Record<string, AnyEntity[]>)[entry.kind] ?? []) as AnyEntity[];
      current.push(entry.row);
      (changes as Record<string, AnyEntity[]>)[entry.kind] = current;
    }

    return sendJson(res, 200, {
      changes,
      cursor: hasMore ? page[page.length - 1]?.row.rev ?? since : state.cursor,
      hasMore,
      epoch: state.epoch,
      serverTime: Date.now(),
    });
  }

  if (method === 'POST' && url.pathname === '/blobs/status') {
    const body = (await readJson(req)) as { ids: string[] };
    const present = body.ids.filter((id) => state.blobs.has(id));
    const missing = body.ids.filter((id) => !state.blobs.has(id));
    return sendJson(res, 200, { present, missing });
  }

  if (url.pathname.startsWith('/blobs/')) {
    const id = decodeURIComponent(url.pathname.split('/')[2] ?? '');
    if (method === 'PUT') {
      const mimeType = String(req.headers['content-type'] ?? 'application/octet-stream');
      const bytes = await readRaw(req);
      state.blobs.set(id, { mimeType, bytes });
      return sendJson(res, 201, { id, byteSize: bytes.length });
    }

    if (method === 'GET') {
      const record = state.blobs.get(id);
      if (!record) return sendJson(res, 404, { error: 'not_found', message: 'Missing blob.' });
      res.statusCode = 200;
      res.setHeader('content-type', record.mimeType);
      res.end(record.bytes);
      return;
    }
  }

  sendJson(res, 404, { error: 'not_found', message: 'Unknown route.' });
}

function requireAuth(req: IncomingMessage, res: ServerResponse, state: ServerState): DeviceContext | null {
  const raw = String(req.headers.authorization ?? '');
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  const context = state.tokens.get(token) ?? null;
  if (context) return context;
  sendJson(res, 401, { error: 'unauthorized', message: 'Missing token.' });
  return null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

describe('ProtocolV2Transport', () => {
  test('pairs, resolves whoAmI, and rotates token on re-pair', async () => {
    const server = await startServer();
    const dir = await mkdtemp(join(tmpdir(), 'kvitto-sync-'));

    try {
      const state = new MemoryStateStore();
      const vault = new MemoryTokenVault();
      const credentials = createCredentialsAdapter({ state, tokenVault: vault });
      const transport = new ProtocolV2Transport({
        serverUrl: server.baseUrl,
        credentials,
        fetchImpl: nodeFetch,
        blobFiles: new TempBlobFiles(dir),
        deviceIdentity: {
          getDeviceId: async () => getOrCreateDeviceId({ state, tokenVault: vault, idFactory: () => 'device-1' }),
          getDeviceName: async () => 'iPhone Test',
        },
      });

      const first = await transport.pairCurrentDevice('PAIR-OK');
      expect(first.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
      expect((await credentials.get()).token).toBe('token-device-1-1');

      const who = await transport.whoAmI();
      expect(who.deviceId).toBe('device-1');
      expect(who.accountId).toBe('acc-1');

      await transport.pairCurrentDevice('PAIR-OK');
      expect((await credentials.get()).token).toBe('token-device-1-2');
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('push/pull handle stale rows and global pagination across kinds', async () => {
    const server = await startServer();
    const dir = await mkdtemp(join(tmpdir(), 'kvitto-sync-'));

    try {
      const state = new MemoryStateStore();
      const vault = new MemoryTokenVault();
      const credentials = createCredentialsAdapter({ state, tokenVault: vault });
      const transport = new ProtocolV2Transport({
        serverUrl: server.baseUrl,
        credentials,
        fetchImpl: nodeFetch,
        blobFiles: new TempBlobFiles(dir),
        deviceIdentity: {
          getDeviceId: async () => 'device-2',
          getDeviceName: async () => 'iPad Test',
        },
      });

      await transport.pairCurrentDevice('PAIR-OK');

      const firstPush = await transport.push({
        deviceId: 'device-2',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        changes: {
          receipts: [{ id: 'r1', updatedAt: 100, deletedAt: 0, dirty: 0, rev: 0 }] as unknown as ChangeSet['receipts'],
        } as ChangeSet,
      });
      expect(firstPush.results[0]?.outcome).toBe('applied');

      const stalePush = await transport.push({
        deviceId: 'device-2',
        protocolVersion: SYNC_PROTOCOL_VERSION,
        changes: {
          receipts: [{ id: 'r1', updatedAt: 50, deletedAt: 0, dirty: 0, rev: 0 }] as unknown as ChangeSet['receipts'],
        } as ChangeSet,
      });
      expect(stalePush.results[0]?.outcome).toBe('stale');

      server.state.cursor += 1;
      server.state.records.get('tags')!.set('t1', {
        id: 't1',
        name: 'food',
        color: '#112233',
        updatedAt: 200,
        deletedAt: 0,
        dirty: 0,
        rev: server.state.cursor,
      } as unknown as AnyEntity);

      server.state.cursor += 1;
      server.state.records.get('secrets')!.set('openaiApiKey', {
        id: 'openaiApiKey',
        value: 'secret',
        updatedAt: 201,
        deletedAt: 0,
        dirty: 0,
        rev: server.state.cursor,
      } as unknown as AnyEntity);

      const page1 = await transport.pull({ since: 0, limit: 2 });
      expect(page1.hasMore).toBe(true);

      const page2 = await transport.pull({ since: page1.cursor, limit: 2 });
      expect(page2.hasMore).toBe(false);
      expect((page2.changes.secrets ?? []).some((row) => row.id === 'openaiApiKey')).toBe(true);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('blob upload and download use file-backed descriptors', async () => {
    const server = await startServer();
    const dir = await mkdtemp(join(tmpdir(), 'kvitto-sync-'));

    try {
      const state = new MemoryStateStore();
      const vault = new MemoryTokenVault();
      const blobFiles = new TempBlobFiles(dir);
      const credentials = createCredentialsAdapter({ state, tokenVault: vault });
      const transport = new ProtocolV2Transport({
        serverUrl: server.baseUrl,
        credentials,
        fetchImpl: nodeFetch,
        blobFiles,
        deviceIdentity: {
          getDeviceId: async () => 'device-3',
          getDeviceName: async () => 'iPhone Test',
        },
      });

      await transport.pairCurrentDevice('PAIR-OK');
      await blobFiles.stageUpload('blob-a', 'image/jpeg', new Uint8Array([1, 2, 3, 4]));

      await transport.uploadBlobs(['blob-a', 'blob-missing']);
      expect(server.state.blobs.has('blob-a')).toBe(true);

      server.state.blobs.set('blob-b', {
        mimeType: 'image/png',
        bytes: Buffer.from([9, 8, 7]),
      });

      await transport.downloadBlobs(['blob-b']);
      const downloaded = blobFiles.downloads.get('blob-b');
      expect(downloaded?.mimeType).toBe('image/png');
      expect(Array.from(downloaded?.bytes ?? [])).toEqual([9, 8, 7]);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('withRetry honors Retry-After from server errors', async () => {
    const server = await startServer();
    const dir = await mkdtemp(join(tmpdir(), 'kvitto-sync-'));

    try {
      server.state.push429Left = 1;

      const state = new MemoryStateStore();
      const vault = new MemoryTokenVault();
      const credentials = createCredentialsAdapter({ state, tokenVault: vault });
      const transport = new ProtocolV2Transport({
        serverUrl: server.baseUrl,
        credentials,
        fetchImpl: nodeFetch,
        blobFiles: new TempBlobFiles(dir),
        deviceIdentity: {
          getDeviceId: async () => 'device-4',
          getDeviceName: async () => 'iPhone Test',
        },
      });

      await transport.pairCurrentDevice('PAIR-OK');
      const delays: number[] = [];

      await withRetry(
        () => transport.push({
          deviceId: 'device-4',
          protocolVersion: SYNC_PROTOCOL_VERSION,
          changes: {
            categories: [{ id: 'c1', name: 'Mat', updatedAt: 123, deletedAt: 0, dirty: 0, rev: 0 }] as unknown as ChangeSet['categories'],
          } as ChangeSet,
        }),
        {
          policy: { attempts: 2, baseMs: 1, maxMs: 10 },
          onRetry: (_attempt, delayMs) => delays.push(delayMs),
        },
      );

      expect(delays.length).toBe(1);
      expect(delays[0]).toBeGreaterThanOrEqual(1000);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('cancellation aborts in-flight request', async () => {
    const server = await startServer();
    const dir = await mkdtemp(join(tmpdir(), 'kvitto-sync-'));

    try {
      server.state.statusDelayMs = 250;

      const state = new MemoryStateStore();
      const vault = new MemoryTokenVault();
      const credentials = createCredentialsAdapter({ state, tokenVault: vault });
      const transport = new ProtocolV2Transport({
        serverUrl: server.baseUrl,
        credentials,
        fetchImpl: nodeFetch,
        blobFiles: new TempBlobFiles(dir),
        deviceIdentity: {
          getDeviceId: async () => 'device-5',
          getDeviceName: async () => 'iPhone Test',
        },
      });

      await transport.pairCurrentDevice('PAIR-OK');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20);

      await expect(transport.status(0, { signal: controller.signal })).rejects.toThrow('Sync cancelled.');
      clearTimeout(timer);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('unpair clears token and cursor, dirties all entities, and resets uploads', async () => {
    const server = await startServer();
    const dir = await mkdtemp(join(tmpdir(), 'kvitto-sync-'));

    try {
      const state = new MemoryStateStore();
      const vault = new MemoryTokenVault();
      const credentials = createCredentialsAdapter({ state, tokenVault: vault });
      const transport = new ProtocolV2Transport({
        serverUrl: server.baseUrl,
        credentials,
        fetchImpl: nodeFetch,
        blobFiles: new TempBlobFiles(dir),
        deviceIdentity: {
          getDeviceId: async () => getOrCreateDeviceId({ state, tokenVault: vault, idFactory: () => 'device-6' }),
          getDeviceName: async () => 'iPhone Test',
        },
      });

      await transport.pairCurrentDevice('PAIR-OK');

      let dirtyAllCalled = 0;
      let cursorReset: { cursor: number; epoch: string } | null = null;
      let resetUploadsCalled = 0;

      await unpairDevice({
        credentials,
        repo: {
          async setSyncState(next) {
            cursorReset = next;
          },
          async dirtyAllAndResetRev() {
            dirtyAllCalled += 1;
          },
        },
        resetBlobUploadState: async () => {
          resetUploadsCalled += 1;
        },
      });

      const credentialState = await credentials.get();
      expect(credentialState.token).toBeNull();
      expect(credentialState.accountId).toBeNull();
      expect(credentialState.deviceId).toBe('device-6');
      expect(cursorReset).toEqual({ cursor: 0, epoch: 'unpaired' });
      expect(dirtyAllCalled).toBe(1);
      expect(resetUploadsCalled).toBe(1);

      await transport.pairCurrentDevice('PAIR-OK');
      expect((await credentials.get()).token).toBe('token-device-6-2');
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
