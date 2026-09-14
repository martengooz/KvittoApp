/**
 * End-to-end tests against a real server instance backed by a temporary
 * SQLite file, so the storage layer and the HTTP surface are both exercised.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'kvitto-test-'));
process.env['KVITTO_DATA_DIR'] = dataDir;
process.env['LOG_LEVEL'] = 'silent';
process.env['KVITTO_PULL_PAGE_SIZE'] = '3';

// Imported after the environment is set: `env.ts` reads it at module load.
const { buildServer } = await import('../dist/index.js');
const { ensureDefaultAccount, createPairingCode } = await import('../dist/db/accounts.js');
const { closeDatabase, getConnection } = await import('../dist/db/index.js');

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let token: string;
let accountId: string;

const DEVICE_ID = randomUUID();

function receipt(id: string, updatedAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    updatedAt,
    deletedAt: 0,
    rev: 0,
    dirty: 0,
    merchant: { name: 'ICA Kvantum', orgNumber: null, vatNumber: null, address: null,
      postalCode: null, city: 'Malmö', country: null, phone: null, storeId: null },
    purchasedAt: '2024-03-15T14:22:00',
    currency: 'SEK',
    total: 389.5,
    subtotal: null,
    discountTotal: null,
    roundingAmount: null,
    depositTotal: null,
    vatLines: [],
    paymentMethod: 'Kontokort',
    cardLast4: null,
    receiptNumber: null,
    terminalId: null,
    cashier: null,
    categoryId: null,
    notes: null,
    source: 'camera',
    imageId: null,
    originalImageId: null,
    thumbId: null,
    status: 'parsed',
    extraction: null,
    itemCount: 0,
    ...overrides,
  };
}

before(async () => {
  getConnection();
  accountId = ensureDefaultAccount();
  app = await buildServer();
  await app.ready();

  const { code } = createPairingCode(accountId);
  const response = await app.inject({
    method: 'POST',
    url: '/auth/pair',
    payload: { code, deviceId: DEVICE_ID, deviceName: 'Testenhet' },
  });
  assert.equal(response.statusCode, 200);
  token = response.json().token as string;
});

after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

function auth() {
  return { authorization: `Bearer ${token}` };
}

/**
 * Pulls every receipt, paging until the server says there is no more.
 *
 * This suite pins the page size to 3, so a single pull only ever sees a slice.
 * Tests that assert on a specific record must page, or they pass by accident
 * while the record happens to land on the first page.
 */
async function pullAllReceipts(): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor = 0;
  for (let page = 0; page < 50; page += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/sync/pull?since=${cursor}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    rows.push(...((body.changes.receipts ?? []) as Record<string, unknown>[]));
    cursor = body.cursor;
    if (!body.hasMore) break;
  }
  return rows;
}

function findReceipt(rows: Record<string, unknown>[], id: string): Record<string, unknown> {
  const found = rows.find((row) => row['id'] === id);
  assert.ok(found, `receipt ${id} was returned by pull`);
  return found;
}

test('health reports the protocol version without authentication', async () => {
  const response = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().protocolVersion, 2);
});

test('debug log captures complete redacted HTTP exchanges', async () => {
  const request = await app.inject({
    method: 'POST',
    url: '/blobs/status',
    headers: { ...auth(), 'x-debug-test': 'visible' },
    payload: { ids: ['not-a-blob-id'] },
  });
  assert.equal(request.statusCode, 200);

  const response = await app.inject({ method: 'GET', url: '/debug/logs', headers: auth() });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.capacity, 500);
  const entry = body.entries.find((candidate: { message: string }) => candidate.message === 'POST /blobs/status');
  assert.ok(entry);
  assert.equal(entry.details.request.method, 'POST');
  assert.equal(entry.details.request.url, '/blobs/status');
  assert.equal(entry.details.request.headers.authorization, '[redacted]');
  assert.equal(entry.details.request.headers['x-debug-test'], 'visible');
  assert.deepEqual(entry.details.request.body, { ids: ['not-a-blob-id'] });
  assert.equal(entry.details.response.status, 200);
  assert.deepEqual(entry.details.response.body, { present: [], missing: ['not-a-blob-id'] });
});

test('server dashboard serves its shell and assets without exposing account data', async () => {
  const page = await app.inject({ method: 'GET', url: '/server' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'] ?? '', /^text\/html/);
  assert.match(page.headers['content-security-policy'] ?? '', /default-src 'self'/);
  assert.match(page.body, /KvittoApp server/);
  assert.match(page.body, /id="create-pairing-code"/);
  assert.match(page.body, /id="ai-settings"/);
  assert.match(page.body, /src="\/server\/app.js" type="module"/);
  assert.doesNotMatch(page.body, /id="pair-code"/);
  assert.doesNotMatch(page.body, new RegExp(accountId));

  const [styles, script, aiSettings] = await Promise.all([
    app.inject({ method: 'GET', url: '/server/styles.css' }),
    app.inject({ method: 'GET', url: '/server/app.js' }),
    app.inject({ method: 'GET', url: '/server/ai-settings.js' }),
  ]);
  assert.equal(styles.statusCode, 200);
  assert.match(styles.headers['content-type'] ?? '', /^text\/css/);
  assert.equal(script.statusCode, 200);
  assert.match(script.headers['content-type'] ?? '', /^text\/javascript/);
  assert.doesNotMatch(script.body, /__PAIR_SERVER_URL__/);
  assert.match(script.body, /pair-server-url'\)\.value = "https?:\/\//);
  assert.equal(aiSettings.statusCode, 200);
  assert.match(aiSettings.headers['content-type'] ?? '', /^text\/javascript/);
  assert.match(aiSettings.body, /createAiSettingsView/);
});

test('server dashboard mints pairing codes for clients', async () => {
  const dashboardId = randomUUID();
  const session = await app.inject({
    method: 'POST',
    url: '/auth/dashboard',
    payload: { deviceId: dashboardId, deviceName: 'Serverdashboard' },
  });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().deviceId, dashboardId);

  const pairingCode = await app.inject({
    method: 'POST',
    url: '/auth/pairing-code',
    headers: { authorization: `Bearer ${session.json().token}` },
    payload: { serverUrl: 'https://kvitto.test' },
  });
  assert.equal(pairingCode.statusCode, 200);
  assert.match(pairingCode.json().code, /^(?:[A-Z0-9]{3}-){2}[A-Z0-9]{3}$/);
  assert.ok(pairingCode.json().expiresAt > Date.now());
  assert.match(pairingCode.json().qrImage, /^data:image\/png;base64,/);
  assert.deepEqual(JSON.parse(pairingCode.json().pairingPayload), {
    type: 'kvitto-pair',
    version: 1,
    serverUrl: 'https://kvitto.test',
    code: pairingCode.json().code,
  });

  const client = await app.inject({
    method: 'POST',
    url: '/auth/pair',
    payload: {
      code: pairingCode.json().code,
      deviceId: randomUUID(),
      deviceName: 'Klient',
    },
  });
  assert.equal(client.statusCode, 200);
});

test('server AI configuration uses dashboard settings and synchronized secrets', async () => {
  const configured = await app.inject({
    method: 'PUT',
    url: '/server/config',
    headers: auth(),
    payload: {
      ai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1',
        maxOutputTokens: 8000,
        effort: 'auto',
        structuredOutput: true,
        extraInstructions: 'Use Swedish merchant names.',
      },
    },
  });
  assert.equal(configured.statusCode, 200);
  assert.deepEqual(configured.json().ai, {
    provider: 'openai',
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    maxOutputTokens: 8000,
    effort: 'auto',
    structuredOutput: true,
    extraInstructions: 'Use Swedish merchant names.',
    apiKeyConfigured: false,
  });

  const secret = await app.inject({
    method: 'PUT',
    url: '/secrets/aiApiKey',
    headers: auth(),
    payload: { value: 'configured-proxy-key' },
  });
  assert.equal(secret.statusCode, 200);

  const identity = await app.inject({ method: 'GET', url: '/auth/me', headers: auth() });
  assert.equal(identity.statusCode, 200);
  assert.equal(identity.json().aiProxyEnabled, true);
  assert.deepEqual(identity.json().aiProxyModels, ['gpt-4o-mini']);

  const readBack = await app.inject({ method: 'GET', url: '/server/config', headers: auth() });
  assert.equal(readBack.statusCode, 200);
  assert.equal(readBack.body.includes('configured-proxy-key'), false);

  await app.inject({
    method: 'PUT',
    url: '/secrets/aiApiKey',
    headers: auth(),
    payload: { value: '' },
  });
  await app.inject({
    method: 'PUT',
    url: '/server/config',
    headers: auth(),
    payload: {
      ai: {
        provider: 'none',
        model: 'claude-opus-5',
        baseUrl: '',
        maxOutputTokens: 16000,
        effort: 'auto',
        structuredOutput: true,
        extraInstructions: '',
      },
    },
  });
});

test('secrets sync in both directions and are encrypted at rest', async () => {
  const serverValue = 'server-secret-value';
  const saved = await app.inject({
    method: 'PUT',
    url: '/secrets/aiApiKey',
    headers: auth(),
    payload: { value: serverValue },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().configured, true);
  assert.equal(saved.json().value, undefined, 'admin responses never echo a secret');

  let cursor = 0;
  let pulledSecret: Record<string, unknown> | undefined;
  for (let page = 0; page < 10 && !pulledSecret; page += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/sync/pull?since=${cursor}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    pulledSecret = (body.changes.secrets as Record<string, unknown>[] | undefined)?.find(
      (secret) => secret['id'] === 'aiApiKey',
    );
    cursor = body.cursor;
    if (!body.hasMore) break;
  }
  assert.equal(pulledSecret?.['value'], serverValue, 'server changes reach a device pull');

  const clientValue = 'client-secret-value';
  const pushed = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: {
      deviceId: DEVICE_ID,
      protocolVersion: 2,
      changes: {
        secrets: [{
          id: 'companyApiKey',
          value: clientValue,
          updatedAt: Date.now() + 1_000,
          deletedAt: 0,
          rev: 0,
          dirty: 0,
        }],
      },
    },
  });
  assert.equal(pushed.statusCode, 200);
  assert.equal(pushed.json().results[0].outcome, 'applied');

  const listed = await app.inject({ method: 'GET', url: '/secrets', headers: auth() });
  assert.equal(listed.statusCode, 200);
  const company = listed.json().secrets.find((secret: { id: string }) => secret.id === 'companyApiKey');
  assert.equal(company.configured, true, 'device changes reach the admin endpoint');
  assert.equal(company.value, undefined);

  const stored = getConnection()
    .prepare('SELECT payload FROM secrets WHERE id IN (?, ?)')
    .all('aiApiKey', 'companyApiKey') as { payload: string }[];
  assert.equal(stored.length, 2);
  for (const row of stored) {
    assert.match(row.payload, /^enc:v1:/);
    assert.doesNotMatch(row.payload, /server-secret-value|client-secret-value/);
  }
});

test('protected endpoints reject a missing or bogus token', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/sync/pull?since=0' });
  assert.equal(anonymous.statusCode, 401);

  const bogus = await app.inject({
    method: 'GET',
    url: '/sync/pull?since=0',
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(bogus.statusCode, 401);
});

test('debug log exposes bounded request metadata only to paired devices', async () => {
  await app.inject({ method: 'GET', url: '/health' });

  const anonymous = await app.inject({ method: 'GET', url: '/debug/logs' });
  assert.equal(anonymous.statusCode, 401);

  const response = await app.inject({
    method: 'GET',
    url: '/debug/logs?limit=20',
    headers: auth(),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.ok(Array.isArray(body.entries));
  assert.ok(body.entries.length <= 20);
  assert.ok(body.entries.some((entry: { message: string }) => entry.message === 'GET /health'));
  assert.equal(response.body.includes(token), false);
  assert.equal(response.body.includes(`Bearer ${token}`), false);
  for (const entry of body.entries) {
    const authorization = entry.details?.request?.headers?.authorization;
    if (authorization !== undefined) assert.equal(authorization, '[redacted]');
  }
});

test('a pairing code cannot be redeemed twice', async () => {
  const { code } = createPairingCode(accountId);
  const first = await app.inject({
    method: 'POST',
    url: '/auth/pair',
    payload: { code, deviceId: randomUUID(), deviceName: 'Andra enheten' },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: 'POST',
    url: '/auth/pair',
    payload: { code, deviceId: randomUUID(), deviceName: 'Tredje enheten' },
  });
  assert.equal(second.statusCode, 400);
});

test('push then pull round-trips a receipt', async () => {
  const id = randomUUID();
  const push = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, protocolVersion: 2, changes: { receipts: [receipt(id, 1000)] } },
  });
  assert.equal(push.statusCode, 200);
  assert.equal(push.json().results[0].outcome, 'applied');

  const pulled = findReceipt(await pullAllReceipts(), id);
  assert.equal((pulled['merchant'] as { name: string }).name, 'ICA Kvantum');
  assert.ok((pulled['rev'] as number) > 0, 'the server assigned a revision');
});

test('an older version of a record is reported stale, not applied', async () => {
  const id = randomUUID();
  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt(id, 5000, { notes: 'nyare' })] } },
  });

  const older = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt(id, 1000, { notes: 'äldre' })] } },
  });
  assert.equal(older.json().results[0].outcome, 'stale');

  const stored = findReceipt(await pullAllReceipts(), id);
  assert.equal(stored['notes'], 'nyare', 'the newer version survived');
});

test('a newer version overwrites an older one', async () => {
  const id = randomUUID();
  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt(id, 1000, { notes: 'först' })] } },
  });
  const newer = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt(id, 9000, { notes: 'sedan' })] } },
  });
  assert.equal(newer.json().results[0].outcome, 'applied');

  const stored = findReceipt(await pullAllReceipts(), id);
  assert.equal(stored['notes'], 'sedan');
});

test('invalid records are rejected without failing the whole batch', async () => {
  const good = randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: {
      deviceId: DEVICE_ID,
      changes: {
        receipts: [receipt(good, 2000), { id: '', updatedAt: 1, deletedAt: 0 }],
      },
    },
  });

  const outcomes = response.json().results.map((result: { outcome: string }) => result.outcome);
  assert.ok(outcomes.includes('applied'));
  assert.ok(outcomes.includes('rejected'));
});

test('pull pages through changes without losing any', async () => {
  // The page size is pinned to 3 for this suite, so five records need two pages.
  const ids = Array.from({ length: 5 }, () => randomUUID());
  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: {
      deviceId: DEVICE_ID,
      changes: { receipts: ids.map((id, index) => receipt(id, 20_000 + index)) },
    },
  });

  const seen = new Set((await pullAllReceipts()).map((row) => row['id'] as string));
  for (const id of ids) assert.ok(seen.has(id), `pulled ${id}`);
});

test('pull pages globally by revision without skipping secrets', async () => {
  const before = await app.inject({ method: 'GET', url: '/sync/status', headers: auth() });
  const cursor = before.json().cursor as number;
  const secretValue = `page-secret-${randomUUID()}`;

  await app.inject({
    method: 'PUT',
    url: '/secrets/aiApiKey',
    headers: auth(),
    payload: { value: secretValue },
  });

  const ids = Array.from({ length: 3 }, () => randomUUID());
  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: {
      deviceId: DEVICE_ID,
      changes: { receipts: ids.map((id, index) => receipt(id, 30_000 + index)) },
    },
  });

  const pulledSecrets: Record<string, unknown>[] = [];
  let pageCursor = cursor;
  for (let page = 0; page < 10; page += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/sync/pull?since=${pageCursor}`,
      headers: auth(),
    });
    const body = response.json();
    pulledSecrets.push(...((body.changes.secrets ?? []) as Record<string, unknown>[]));
    pageCursor = body.cursor;
    if (!body.hasMore) break;
  }

  assert.equal(
    pulledSecrets.find((secret) => secret['id'] === 'aiApiKey')?.['value'],
    secretValue,
  );
});

test('a tombstone propagates', async () => {
  const id = randomUUID();
  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt(id, 1000)] } },
  });
  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt(id, 2000, { deletedAt: 2000 })] } },
  });

  const stored = findReceipt(await pullAllReceipts(), id);
  assert.equal(stored['deletedAt'], 2000);
});

test('blobs round-trip and are addressed by their own digest', async () => {
  // A one-pixel PNG, so the upload passes the media-type check.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const digest = createHash('sha256').update(png).digest('hex');

  const before = await app.inject({
    method: 'POST',
    url: '/blobs/status',
    headers: auth(),
    payload: { ids: [digest] },
  });
  assert.deepEqual(before.json().missing, [digest]);

  const upload = await app.inject({
    method: 'PUT',
    url: `/blobs/${digest}`,
    headers: { ...auth(), 'content-type': 'image/png' },
    payload: png,
  });
  assert.equal(upload.statusCode, 201);

  const after = await app.inject({
    method: 'POST',
    url: '/blobs/status',
    headers: auth(),
    payload: { ids: [digest] },
  });
  assert.deepEqual(after.json().present, [digest]);

  const download = await app.inject({ method: 'GET', url: `/blobs/${digest}`, headers: auth() });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'image/png');
  assert.ok(download.rawPayload.equals(png), 'the bytes come back unchanged');
});

test('a blob whose contents do not match its id is refused', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const wrongDigest = 'a'.repeat(64);

  const response = await app.inject({
    method: 'PUT',
    url: `/blobs/${wrongDigest}`,
    headers: { ...auth(), 'content-type': 'image/png' },
    payload: png,
  });
  assert.equal(response.statusCode, 409);
});

test('a blob id that is not a digest is rejected before touching the filesystem', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/blobs/..%2F..%2Fetc%2Fpasswd',
    headers: auth(),
  });
  assert.equal(response.statusCode, 400);
});

test('the AI proxy reports that it is disabled rather than failing obscurely', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/ai/parse',
    headers: { ...auth(), 'content-type': 'multipart/form-data; boundary=x' },
    payload: '--x--\r\n',
  });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().error, 'ai_disabled');
});

test('a protocol version mismatch is reported explicitly', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: auth(),
    payload: { deviceId: DEVICE_ID, protocolVersion: 99, changes: {} },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().protocolVersion, 2);
});

// --- the change probe and the epoch ---------------------------------------

test('the status probe reports what is waiting without sending any of it', async () => {
  const before = (await app.inject({
    method: 'GET',
    url: '/sync/status',
    headers: { authorization: `Bearer ${token}` },
  })).json() as { cursor: number; epoch: string; hasChanges: boolean };

  assert.ok(before.epoch, 'every response carries the revision history it belongs to');

  // Nothing new since the current cursor.
  const caughtUp = (await app.inject({
    method: 'GET',
    url: `/sync/status?since=${before.cursor}`,
    headers: { authorization: `Bearer ${token}` },
  })).json() as { hasChanges: boolean; pendingTotal: number };

  assert.equal(caughtUp.hasChanges, false);
  assert.equal(caughtUp.pendingTotal, 0);

  await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: DEVICE_ID, changes: { receipts: [receipt('probe-1', Date.now())] } },
  });

  const afterPush = (await app.inject({
    method: 'GET',
    url: `/sync/status?since=${before.cursor}`,
    headers: { authorization: `Bearer ${token}` },
  })).json() as { hasChanges: boolean; pendingTotal: number; pending: Record<string, number> };

  assert.equal(afterPush.hasChanges, true);
  assert.equal(afterPush.pendingTotal, 1);
  assert.equal(afterPush.pending['receipts'], 1);
});

test('a cursor ahead of the server is reported as a divergence, not as "nothing new"', async () => {
  // What a client holds after the server has been restored from an older backup.
  const body = (await app.inject({
    method: 'GET',
    url: '/sync/status?since=999999',
    headers: { authorization: `Bearer ${token}` },
  })).json() as { diverged?: boolean; hasChanges: boolean };

  assert.equal(body.diverged, true);
  assert.equal(body.hasChanges, true, 'a diverged client must not be told it is up to date');
});

test('the epoch is stable across calls and travels with every sync response', async () => {
  const auth = { authorization: `Bearer ${token}` };
  const status = (await app.inject({ method: 'GET', url: '/sync/status', headers: auth })).json() as { epoch: string };
  const pulled = (await app.inject({ method: 'GET', url: '/sync/pull?since=0', headers: auth })).json() as { epoch: string };
  const pushed = (await app.inject({
    method: 'POST', url: '/sync/push', headers: auth,
    payload: { deviceId: DEVICE_ID, changes: {} },
  })).json() as { epoch: string };

  assert.equal(pulled.epoch, status.epoch);
  assert.equal(pushed.epoch, status.epoch);
});
