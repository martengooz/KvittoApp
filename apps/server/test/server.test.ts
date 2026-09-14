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
  assert.equal(response.json().protocolVersion, 1);
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
    payload: { deviceId: DEVICE_ID, protocolVersion: 1, changes: { receipts: [receipt(id, 1000)] } },
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
  assert.equal(response.json().protocolVersion, 1);
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
