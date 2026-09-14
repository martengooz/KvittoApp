/**
 * Browser verification for the KvittoApp PWA.
 *
 * Two modes, because dev and production differ in ways that matter:
 *
 *   npm run verify          - against `vite preview`, i.e. the real bundle.
 *                             Drives the UI exactly as a user would.
 *   npm run verify:pipeline - against `vite dev`, where the CV modules can be
 *                             imported directly, so every fixture receipt is
 *                             pushed through the pipeline and the processed
 *                             output is written to `e2e/output/` for review.
 *
 * The pipeline mode is the useful one when tuning image processing: it reports
 * which detection strategy fired, its confidence and the timing per receipt,
 * and it fails if the pipeline quietly degrades to the canvas fallback.
 *
 * Requires Chromium. Either install Playwright's browsers
 * (`npx playwright install chromium`) or point CHROMIUM_PATH at an existing
 * Chrome/Chromium binary.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', '..', 'fixtures', 'receipts');
const OUT = join(here, 'output');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4179';
const PIPELINE = process.env.PIPELINE === '1';

const log = (...args) => console.log('[verify]', ...args);
const fail = (message) => {
  console.error(`[verify] FAILED: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error(
    '[verify] playwright-core is not installed.\n' +
      '[verify] Run: npm install --no-save playwright-core',
  );
  process.exit(2);
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // Playwright's own download location, when the browsers were installed.
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root) {
    try {
      const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name));
      if (dir) return join(root, dir, 'chrome-linux', 'chrome');
    } catch {
      // Fall through to Playwright's default resolution.
    }
  }
  return undefined;
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  viewport: { width: 414, height: 896 },
  deviceScaleFactor: 2,
  locale: 'sv-SE',
  // The dev service worker would intercept the fixture route below.
  serviceWorkers: 'block',
});

// Serve the repository's receipt photographs to the page without copying them
// into `public/`.
await context.route('**/__fixture/*', (route) => {
  const name = route.request().url().split('/').pop();
  try {
    route.fulfill({ status: 200, contentType: 'image/jpeg', body: readFileSync(join(FIXTURES, name)) });
  } catch {
    route.fulfill({ status: 404, body: 'not found' });
  }
});

const page = await context.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-nav', { timeout: 30_000 });
  log('app shell mounted');

  for (const [hash, marker] of [
    ['#/receipts', '.empty-state, .receipt-card'],
    ['#/purchases', '.empty-state, .purchase-row'],
    ['#/collections', '.stat-grid'],
    ['#/settings', '.list-group'],
    ['#/scan', '.scan-button'],
  ]) {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(marker, { timeout: 20_000 });
    log(`route ${hash} rendered`);
  }

  const categories = await page.evaluate(async () => {
    const request = indexedDB.open('kvittoapp');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve) => {
      const count = db.transaction('categories').objectStore('categories').count();
      count.onsuccess = () => resolve(count.result);
    });
  });
  if (categories < 10) fail(`expected the default categories to be seeded, found ${categories}`);
  log(`seeded categories: ${categories}`);

  const fixtures = readdirSync(FIXTURES).filter((name) => name.endsWith('.jpeg')).sort();
  if (fixtures.length === 0) fail('no fixture receipts found');

  if (PIPELINE) await runPipelineSweep(page, fixtures);
  await runScanFlow(page, fixtures[0]);

  if (errors.length > 0) fail(`page reported errors:\n${errors.join('\n')}`);
  log('OK');
} finally {
  writeFileSync(join(OUT, 'console-errors.json'), JSON.stringify(errors, null, 2));
  await browser.close();
}

/** Pushes every fixture through the CV pipeline and saves the output. */
async function runPipelineSweep(page, fixtures) {
  await page.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scan-button');

  const warm = await page.evaluate(async () => {
    const { cvClient } = await import('/src/cv/client.ts');
    const ready = await cvClient.warmup();
    return { ready, status: cvClient.status };
  });
  if (!warm.ready) fail(`OpenCV did not load: ${warm.status.error}`);
  log('OpenCV runtime ready');

  const summary = [];
  for (const name of fixtures) {
    const result = await page.evaluate(async (fixtureName) => {
      const { cvClient, decodeImage } = await import('/src/cv/client.ts');
      const source = await (await fetch(`/__fixture/${fixtureName}`)).blob();
      const bitmap = await decodeImage(source);
      const sourceSize = { width: bitmap.width, height: bitmap.height };

      const processed = await cvClient.process(bitmap, {
        detectEdges: true,
        enhance: 'grayscale',
        maxDimension: 1568,
        quality: 0.9,
        rotate: 0,
      });

      const bytes = new Uint8Array(await processed.blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return {
        sourceSize,
        width: processed.width,
        height: processed.height,
        bytes: processed.blob.size,
        detection: processed.detection,
        confidence: Number(processed.detectionConfidence.toFixed(3)),
        engine: processed.engine,
        durationMs: processed.durationMs,
        notes: processed.notes,
        base64: btoa(binary),
      };
    }, name);

    // Assert on the engine, not just that an image came back. The pipeline
    // degrades to a canvas fallback when an OpenCV call is unavailable, and a
    // test that only checks for output passes straight through that.
    if (result.engine !== 'opencv') {
      fail(`${name}: expected the OpenCV engine, got "${result.engine}" — ${result.notes.join('; ')}`);
    }

    writeFileSync(join(OUT, name.replace(/\.jpeg$/, '.processed.jpg')), Buffer.from(result.base64, 'base64'));
    const { base64, ...rest } = result;
    summary.push({ name, ...rest });
    log(
      `${name}: ${rest.sourceSize.width}x${rest.sourceSize.height} -> ${rest.width}x${rest.height}, ` +
        `${rest.detection} (confidence ${rest.confidence}), ${rest.durationMs} ms, ` +
        `${Math.round(rest.bytes / 1024)} kB`,
    );
  }

  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));

  const detected = summary.filter((row) => row.detection !== 'full-frame').length;
  log(`receipt outline found on ${detected}/${summary.length} photos`);
  if (detected < summary.length) {
    log('note: photos without an outline still scan, using the whole frame');
  }
  if (detected === 0) fail('document detection found nothing on any fixture');

  const slowest = Math.max(...summary.map((row) => row.durationMs));
  log(`slowest receipt: ${slowest} ms`);
  // A phone is several times slower than a desktop; anything approaching this
  // on a desktop would be unusable on the target device.
  if (slowest > 8000) fail(`pipeline is too slow: ${slowest} ms on the slowest fixture`);
}

/** Walks the capture -> review -> save flow the way a user would. */
async function runScanFlow(page, fixture) {
  await page.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scan-button');

  const chooser = page.waitForEvent('filechooser');
  await page.click('button:has-text("Välj bild från galleriet")');
  await (await chooser).setFiles(join(FIXTURES, fixture));

  await page.waitForSelector('.preview-image', { timeout: 90_000 });
  const caption = await page.textContent('.faint');
  log(`review screen: ${caption?.trim()}`);
  if (caption && caption.includes('canvas')) {
    fail(`the built app fell back to the canvas pipeline: ${caption.trim()}`);
  }
  await page.screenshot({ path: join(OUT, 'screen-review.png') });

  await page.click('button:has-text("Spara utan tolkning")');
  await page.waitForSelector('.receipt-paper', { timeout: 20_000 });
  log('receipt saved, detail view opened');
  await page.screenshot({ path: join(OUT, 'screen-detail.png'), fullPage: true });

  await page.goto(`${BASE}/#/receipts`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.receipt-card', { timeout: 20_000 });
  log('receipt appears in the list');
  await page.screenshot({ path: join(OUT, 'screen-list.png') });
}
