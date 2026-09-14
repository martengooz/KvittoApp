/**
 * The local-model pipeline, exercised against a stand-in Ollama.
 *
 * A real qwen3-vl:4b is a 3 GB download and minutes of CPU per receipt, so the
 * model is replaced by an HTTP server that speaks the same three endpoints.
 * What is under test is everything around it: the queue, the backoff, the merge
 * rules, and — the part that actually matters — that a receipt the model reads
 * reaches a device through the ordinary pull with no new protocol.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'kvitto-llm-test-'));

/** A one-pixel JPEG. Enough for the pipeline; the model is fake anyway. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);
const IMAGE_ID = createHash('sha256').update(JPEG).digest('hex');

/** What the fake model returns, and how it should behave this call. */
let modelBehaviour: 'ok' | 'fail' | 'garbage' = 'ok';
let modelCalls = 0;
let ollama: Server;
let ollamaPort = 0;

const EXTRACTION = {
  merchant: {
    name: 'BAUHAUS Skogås', orgNumber: '969630-6944', vatNumber: null, address: null,
    postalCode: null, city: 'Skogås', country: null, phone: null, storeId: null,
  },
  purchasedAt: '2026-08-05 14:12',
  currency: 'SEK',
  total: '1 234,50',
  subtotal: null, discountTotal: null, roundingAmount: '0,50', depositTotal: null,
  vatLines: [{ rate: '25', net: '987,60', vat: '246,90', gross: '1 234,50' }],
  paymentMethod: 'kort', cardLast4: '8618', receiptNumber: null, terminalId: null, cashier: null,
  items: [
    { name: 'Casco Husfix', rawName: 'CASCO HUSFIX RAPID', quantity: '1', unit: 'st',
      unitPrice: null, totalPrice: '579,00', discount: null, vatRate: '25', ean: null, deposit: null },
    { name: 'Pant', rawName: 'PANT', quantity: '1', unit: 'st',
      unitPrice: null, totalPrice: '2,00', discount: null, vatRate: '25', ean: null, deposit: null },
  ],
  confidence: 0.82,
};

before(async () => {
  await new Promise<void>((resolve) => {
    ollama = createServer((request, response) => {
      const send = (code: number, body: unknown): void => {
        response.writeHead(code, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (request.url === '/api/version') return send(200, { version: '0.5.0-fake' });
      if (request.url === '/api/tags') return send(200, { models: [{ name: 'qwen3-vl:4b', size: 1 }] });
      if (request.url === '/api/chat') {
        modelCalls += 1;
        // Drain the request body; Ollama would.
        request.resume();
        if (modelBehaviour === 'fail') return send(500, { error: 'out of memory' });
        const content = modelBehaviour === 'garbage' ? 'sorry, I cannot' : JSON.stringify(EXTRACTION);
        return send(200, { model: 'qwen3-vl:4b', message: { content } });
      }
      send(404, { error: 'not found' });
    });
    ollama.listen(0, '127.0.0.1', () => {
      ollamaPort = (ollama.address() as { port: number }).port;
      resolve();
    });
  });

  process.env['KVITTO_DATA_DIR'] = dataDir;
  process.env['LOG_LEVEL'] = 'silent';
  process.env['KVITTO_LLM_ENABLED'] = '1';
  process.env['KVITTO_LLM_BASE_URL'] = `http://127.0.0.1:${ollamaPort}`;
  // Never spawn a real binary from a test.
  process.env['KVITTO_LLM_MANAGE_PROCESS'] = '0';
  process.env['KVITTO_LLM_MAX_ATTEMPTS'] = '2';
  process.env['KVITTO_LLM_RETRY_BASE_MS'] = '10';
});

after(async () => {
  const { closeDatabase } = await import('../dist/db/index.js');
  closeDatabase();
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

function receipt(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    updatedAt: Date.now(),
    deletedAt: 0,
    rev: 0,
    dirty: 0,
    merchant: {
      name: null, orgNumber: null, vatNumber: null, address: null,
      postalCode: null, city: null, country: null, phone: null, storeId: null,
    },
    purchasedAt: null,
    currency: 'SEK',
    total: null, subtotal: null, discountTotal: null, roundingAmount: null, depositTotal: null,
    vatLines: [],
    paymentMethod: null, cardLast4: null, receiptNumber: null, terminalId: null, cashier: null,
    categoryId: null, companyId: null, notes: null,
    source: 'camera',
    imageId: IMAGE_ID,
    originalImageId: null,
    thumbId: null,
    status: 'draft',
    extraction: null,
    ocr: null,
    itemCount: 0,
    ...overrides,
  };
}

async function harness() {
  const { buildServer } = await import('../dist/index.js');
  const { ensureDefaultAccount, createPairingCode } = await import('../dist/db/accounts.js');
  const app = await buildServer();
  const accountId = ensureDefaultAccount();
  const { code } = createPairingCode(accountId);

  const paired = await app.inject({
    method: 'POST',
    url: '/auth/pair',
    payload: { code, deviceId: randomUUID(), deviceName: 'test' },
  });
  const token = (paired.json() as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  return { app, accountId, auth };
}

test('a receipt pushed without an extraction is read and merged, and arrives on the next pull', async () => {
  modelBehaviour = 'ok';
  const { app, accountId, auth } = await harness();

  await app.inject({ method: 'PUT', url: `/blobs/${IMAGE_ID}`, headers: { ...auth, 'content-type': 'image/jpeg' }, payload: JPEG });
  await app.inject({
    method: 'POST', url: '/sync/push', headers: auth,
    payload: { deviceId: 'd1', changes: { receipts: [receipt('r-ok')] } },
  });

  // The cursor a device would hold after that push.
  const before = (await app.inject({ method: 'GET', url: '/sync/status', headers: auth })).json() as { cursor: number };

  const { runPass } = await import('../dist/llm/worker.js');
  const report = await runPass(accountId, { size: 5 });
  assert.equal(report.blocked, null, `pass was blocked: ${report.blocked}`);
  assert.equal(report.extracted, 1, JSON.stringify(report));

  // Nothing new to subscribe to: the ordinary delta pull carries it.
  const pulled = (await app.inject({
    method: 'GET', url: `/sync/pull?since=${before.cursor}`, headers: auth,
  })).json() as { changes: { receipts?: Record<string, unknown>[]; items?: Record<string, unknown>[] } };

  const updated = pulled.changes.receipts?.find((row) => row['id'] === 'r-ok');
  assert.ok(updated, 'the extracted receipt must appear in the delta');
  assert.equal(updated['total'], 1234.5, 'the printed "1 234,50" is normalised to a number');
  assert.equal(updated['status'], 'parsed');
  assert.equal((updated['merchant'] as { name: string }).name, 'BAUHAUS Skogås');
  assert.equal((updated['extraction'] as { provider: string }).provider, 'local-llm');
  assert.equal(updated['itemCount'], 2);

  assert.equal(pulled.changes.items?.length, 2, 'the line items come with it');
  const pant = pulled.changes.items?.find((item) => item['rawName'] === 'PANT');
  assert.equal(pant?.['isDeposit'], true, 'a pant row is recognised, not folded into the line above');

  await app.close();
});

test('a receipt a human confirmed is left alone', async () => {
  modelBehaviour = 'ok';
  const { app, accountId, auth } = await harness();

  await app.inject({
    method: 'POST', url: '/sync/push', headers: auth,
    payload: { deviceId: 'd1', changes: { receipts: [receipt('r-confirmed', { status: 'confirmed' })] } },
  });

  const callsBefore = modelCalls;
  const report = await (await import('../dist/llm/worker.js')).runPass(accountId, { size: 5 });
  assert.equal(report.extracted, 0);
  assert.equal(modelCalls, callsBefore, 'a confirmed receipt must not even reach the model');

  await app.close();
});

test('a value the user already filled in is not overwritten', async () => {
  modelBehaviour = 'ok';
  const { app, accountId, auth } = await harness();

  await app.inject({ method: 'PUT', url: `/blobs/${IMAGE_ID}`, headers: { ...auth, 'content-type': 'image/jpeg' }, payload: JPEG });
  await app.inject({
    method: 'POST', url: '/sync/push', headers: auth,
    payload: { deviceId: 'd1', changes: { receipts: [receipt('r-partial', { total: 42, notes: 'min egen siffra' })] } },
  });

  await (await import('../dist/llm/worker.js')).runPass(accountId, { size: 5 });

  const { readRecord } = await import('../dist/db/sync.js');
  const stored = readRecord(accountId, 'receipts', 'r-partial') as { total: number; notes: string; purchasedAt: string };
  assert.equal(stored.total, 42, "the user's total must survive");
  assert.equal(stored.notes, 'min egen siffra');
  // A field that was blank is still filled.
  assert.ok(stored.purchasedAt, 'blank fields are still populated');

  await app.close();
});

test('a receipt whose image has not synced yet waits instead of failing permanently', async () => {
  const { app, accountId, auth } = await harness();
  await app.inject({
    method: 'POST', url: '/sync/push', headers: auth,
    payload: { deviceId: 'd1', changes: { receipts: [receipt('r-noimage', { imageId: 'a'.repeat(64) })] } },
  });

  const before = Date.now();
  await (await import('../dist/llm/worker.js')).runPass(accountId, { size: 5 });
  const after = Date.now();

  const jobs = await import('../dist/llm/jobs.js');
  const job = jobs.get('r-noimage');
  assert.equal(job?.state, 'pending', 'a missing image is temporary, so the job stays queued');
  assert.equal(job?.attempts, 1);

  // The retry is scheduled inside the first backoff window. Asserted as a range
  // rather than "later than now" because the backoff uses *full* jitter — a
  // uniform draw from [0, ceiling] — so a legitimate delay of zero exists and
  // an assertion that excluded it would fail about one run in five.
  const ceiling = Number(process.env['KVITTO_LLM_RETRY_BASE_MS']);
  assert.ok(
    job && job.nextAttemptAt >= before && job.nextAttemptAt <= after + ceiling,
    `expected a retry scheduled within ${ceiling} ms of the attempt, got ${job?.nextAttemptAt} vs [${before}, ${after + ceiling}]`,
  );

  await app.close();
});

test('a failing model backs off and eventually parks the job', async () => {
  modelBehaviour = 'fail';
  const { app, accountId, auth } = await harness();

  await app.inject({ method: 'PUT', url: `/blobs/${IMAGE_ID}`, headers: { ...auth, 'content-type': 'image/jpeg' }, payload: JPEG });
  await app.inject({
    method: 'POST', url: '/sync/push', headers: auth,
    payload: { deviceId: 'd1', changes: { receipts: [receipt('r-fail')] } },
  });

  const jobs = await import('../dist/llm/jobs.js');
  const { runPass } = await import('../dist/llm/worker.js');

  await runPass(accountId, { size: 5 });
  assert.equal(jobs.get('r-fail')?.attempts, 1);
  assert.equal(jobs.get('r-fail')?.state, 'pending', 'the first failure is retryable');

  // Wait out the (tiny, in tests) backoff and try again.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await runPass(accountId, { size: 5 });

  const parked = jobs.get('r-fail');
  assert.equal(parked?.attempts, 2);
  assert.equal(parked?.state, 'failed', 'KVITTO_LLM_MAX_ATTEMPTS=2, so it stops here');
  assert.equal(parked?.nextAttemptAt, 0, 'a parked job carries no retry time at all');
  assert.match(parked?.lastError ?? '', /out of memory/);

  // And an operator can put it back. Other jobs from earlier tests may be
  // parked too, so the guarantee is about this one, not about the count.
  assert.ok(jobs.retryFailed(accountId) >= 1);
  assert.equal(jobs.get('r-fail')?.state, 'pending');
  assert.equal(jobs.get('r-fail')?.attempts, 0, 'a requeue starts the budget over');

  await app.close();
});

test('the status endpoint reports the queue and the runtime', async () => {
  const { app, auth } = await harness();
  const body = (await app.inject({ method: 'GET', url: '/llm/status', headers: auth })).json() as {
    enabled: boolean;
    runtime: { state: string; model: string };
    queue: Record<string, number>;
  };

  assert.equal(body.enabled, true);
  assert.equal(body.runtime.model, 'qwen3-vl:4b');
  assert.equal(typeof body.queue.pending, 'number');

  await app.close();
});
