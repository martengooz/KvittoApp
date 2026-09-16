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

/**
 * Console lines that are not faults.
 *
 * Tesseract reports what it inferred about the page — resolution, diacritics —
 * through `console.error`, so a successful reading looks like a failure here.
 * The scan flow now runs a reading on every imported image, which would make
 * every run "fail" on a library's chatter.
 */
const CONSOLE_NOISE = [/^Estimating resolution as /, /^Detected \d+ diacritics/];

const errors = [];
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (CONSOLE_NOISE.some((pattern) => pattern.test(text))) return;
  errors.push(`console: ${text}`);
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
    ['#/scan', '.scan-shutter'],
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
  await runScanFlow(page, fixtures);
  await runCameraFlow();
  await runAutoCaptureFlow(page, fixtures);
  await runSearchFlow(page);
  await runSwipeFlow(page);

  if (errors.length > 0) fail(`page reported errors:\n${errors.join('\n')}`);
  log('OK');
} finally {
  writeFileSync(join(OUT, 'console-errors.json'), JSON.stringify(errors, null, 2));
  await browser.close();
}

/** Pushes every fixture through the CV pipeline and saves the output. */
async function runPipelineSweep(page, fixtures) {
  await page.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scan-shutter');

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

/**
 * Walks both ways in: the camera path, which still reviews one capture, and
 * the gallery path, which takes several images and files them unattended.
 *
 * Headless Chromium has no camera, so `getUserMedia` rejects and the shutter
 * falls back to the native picker — which is exactly the fallback the scan
 * screen promises, so driving the shutter here tests the real code path.
 */
async function runScanFlow(page, fixtures) {
  await page.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scan-shutter');

  // --- camera: one capture, reviewed before it is saved --------------------
  const cameraChooser = page.waitForEvent('filechooser');
  await page.click('.scan-shutter');
  const camera = await cameraChooser;
  if (camera.isMultiple()) fail('the camera picker must take a single frame');
  await camera.setFiles(join(FIXTURES, fixtures[0]));

  await page.waitForSelector('.preview-image', { timeout: 90_000 });
  const notes = await page.locator('.banner--info').allTextContents();
  log(`review screen: ${await page.textContent('.scan-review__image-copy span')}`);
  const degraded = notes.find((note) => note.includes('OpenCV'));
  if (degraded) fail(`the built app fell back to the canvas pipeline: ${degraded.trim()}`);
  await page.screenshot({ path: join(OUT, 'screen-review.png') });

  await page.click('button:has-text("Senare")');
  await page.waitForSelector('.receipt-paper', { timeout: 20_000 });
  log('capture reviewed and saved, detail view opened');
  await page.screenshot({ path: join(OUT, 'screen-detail.png'), fullPage: true });

  // --- gallery: several images, each its own receipt, no prompts -----------
  const batch = fixtures.slice(1, 3);
  if (batch.length < 2) fail('need at least three fixtures to test a multi-image upload');

  await page.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.scan-shutter');
  const galleryChooser = page.waitForEvent('filechooser');
  await page.click('button:has-text("Galleri")');
  const gallery = await galleryChooser;
  if (!gallery.isMultiple()) fail('the gallery picker must accept several images');
  await gallery.setFiles(batch.map((name) => join(FIXTURES, name)));

  await page.waitForSelector('.scan-import', { timeout: 30_000 });
  await page.screenshot({ path: join(OUT, 'screen-import.png') });
  // The import sends the user to the list itself once every image is filed.
  await page.waitForFunction(() => location.hash.startsWith('#/receipts'), null, { timeout: 180_000 });
  log(`${batch.length} images imported without a review prompt`);

  await page.waitForSelector('.receipt-card', { timeout: 20_000 });
  const cards = await page.locator('.receipt-card').count();
  const expected = 1 + batch.length;
  if (cards !== expected) fail(`expected ${expected} receipts in the list, found ${cards}`);
  log(`receipts in the list: ${cards}`);
  await page.screenshot({ path: join(OUT, 'screen-list.png') });
}

/**
 * Swipe-to-delete, on the list the scan flow has just filled.
 *
 * Driven with real pointer events rather than by calling the handlers, because
 * what is worth checking here is what the browser decides: that a sideways drag
 * is not taken for a scroll, that the click it leaves behind never reaches the
 * card underneath, and that the delete it fires can be taken back.
 */
async function runSwipeFlow(page) {
  await page.goto(`${BASE}/#/receipts`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.swipe-row');
  const cards = () => page.locator('.receipt-card').count();
  const before = await cards();
  if (before < 2) fail(`the swipe checks need a list to work on, found ${before} receipts`);

  // An upright drag belongs to the list, which has to keep scrolling.
  await swipe(page, -14, -90);
  if ((await page.locator('.swipe-row--open').count()) !== 0) fail('an upright drag opened a row');

  await swipe(page, -80);
  const opened = await page.locator('.swipe-row--open').count();
  if (opened !== 1) fail(`a swipe left ${opened} rows open, expected exactly 1`);
  if (!page.url().includes('#/receipts')) fail(`the swipe opened the receipt: ${page.url()}`);
  log('swipe uncovers the delete, and does not follow the card it was made on');

  await page.click('.swipe-row__action');
  await page.waitForFunction((count) => document.querySelectorAll('.receipt-card').length === count, before - 1);
  if (!(await page.isVisible('.toast__action'))) fail('the swipe delete offered no undo');
  log('the uncovered action deletes, and offers an undo');

  await page.click('.toast:last-child .toast__action');
  await page.waitForFunction((count) => document.querySelectorAll('.receipt-card').length === count, before);
  log('undo brings the receipt back');

  // Carried across the row, the delete fires on release without stopping open.
  const box = await page.locator('.swipe-row').first().boundingBox();
  await swipe(page, -box.width);
  await page.waitForFunction((count) => document.querySelectorAll('.receipt-card').length === count, before - 1);
  log('a full swipe deletes on release');

  await page.click('.toast:last-child .toast__action');
  await page.waitForFunction((count) => document.querySelectorAll('.receipt-card').length === count, before);
}

/** Drags the first row of the list, in steps, the way a finger moves. */
async function swipe(page, dx, dy = 0) {
  const box = await page.locator('.swipe-row').first().boundingBox();
  const fromX = box.x + box.width - 30;
  const y = box.y + box.height / 2;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(fromX + (dx * step) / 10, y + (dy * step) / 10);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  // Long enough for the row to settle, which is when the outcome is readable.
  await page.waitForTimeout(400);
}

/**
 * The capture screen in a browser that has a camera.
 *
 * The main browser deliberately has none — that absence is what exercises the
 * file-picker fallback above — so this opens a second one with Chromium's fake
 * device. What it checks is the part nothing else can see: that the live
 * preview takes exactly the box the placeholder had, so the shutter neither
 * moves nor leaves the screen the moment the stream arrives, and that one press
 * of it takes the photograph rather than merely opening a camera.
 */
async function runCameraFlow() {
  const withCamera = await chromium.launch({
    executablePath: chromiumPath(),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

  try {
    const context = await withCamera.newContext({
      viewport: { width: 414, height: 896 },
      locale: 'sv-SE',
      serviceWorkers: 'block',
      permissions: ['camera'],
    });
    const cameraPage = await context.newPage();
    cameraPage.on('pageerror', (error) => errors.push(`pageerror (camera): ${error.message}`));

    await cameraPage.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
    await cameraPage.waitForSelector('.scan-viewfinder', { timeout: 30_000 });
    const placeholder = await captureGeometry(cameraPage);

    await cameraPage.waitForSelector('.scan-viewfinder--live', { timeout: 30_000 });
    const live = await captureGeometry(cameraPage);
    await cameraPage.screenshot({ path: join(OUT, 'screen-camera.png') });

    if (JSON.stringify(placeholder) !== JSON.stringify(live)) {
      fail(
        `the live preview resized the screen: ${JSON.stringify(placeholder)} -> ${JSON.stringify(live)}`,
      );
    }
    if (live.scrollHeight > live.viewportHeight + 1) {
      fail(`the capture screen overflows: ${live.scrollHeight} > ${live.viewportHeight}`);
    }
    log('camera: the preview takes the placeholder\'s box, and the screen still fits');

    // Live, the shutter is the shutter — not a button that opens a camera.
    await cameraPage.click('.scan-shutter');
    await cameraPage.waitForSelector('.scan-review', { timeout: 90_000 });
    log('camera: one shutter press goes straight to the review screen');
  } finally {
    await withCamera.close();
  }
}

/**
 * The shutter that fires by itself, pointed at things that should and should
 * not set it off.
 *
 * Chromium will play a Y4M file as if it were the camera, so a fixture
 * photograph becomes a receipt held in front of the lens — the only way to
 * exercise the watcher end to end, detector and all. The scenes are built from
 * that same fixture in the browser (there is no image tooling to assume here),
 * and a wooden desk is painted alongside it, because what the feature must do
 * is as much about the picture it refuses to take as the one it takes.
 */
async function runAutoCaptureFlow(page, fixtures) {
  const scenes = await writeCameraScenes(page, fixtures[0]);

  // A receipt in shot: traced, and photographed without anyone pressing anything.
  await withCameraScene(scenes.receipt, async (scanPage) => {
    await scanPage.waitForSelector('.scan-outline--found', { timeout: 30_000 });
    const corners = await scanPage.$eval('.scan-outline__shape', (node) => node.getAttribute('points'));
    if ((corners ?? '').split(' ').length !== 4) fail(`the outline is not a quadrilateral: ${corners}`);

    await scanPage.waitForSelector('.scan-review', { timeout: 60_000 });
    await scanPage.screenshot({ path: join(OUT, 'screen-auto-capture.png') });
    log('auto: a receipt held still is traced and photographed unprompted');
  });

  // A desk in shot: nothing traced, nothing taken, and the screen says so.
  await withCameraScene(scenes.desk, async (scanPage) => {
    await scanPage.waitForTimeout(9000);
    const state = await scanPage.evaluate(() => ({
      review: document.querySelector('.scan-review') !== null,
      outline: document.querySelector('.scan-outline--found') !== null,
      hint: document.querySelector('.scan-viewfinder__hint')?.textContent ?? '',
    }));
    if (state.review) fail('the shutter fired at a wooden desk');
    if (state.outline) fail('a wooden desk was traced as a receipt');
    if (!/tryck på knappen/i.test(state.hint)) {
      fail(`a fruitless search never handed back to the button: "${state.hint}"`);
    }
    log('auto: a desk is neither traced nor photographed, and the screen says so');
  });
}

/** Runs `body` against the scan screen of a browser whose camera plays `clip`. */
async function withCameraScene(clip, body) {
  const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${clip}`,
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 414, height: 896 },
      locale: 'sv-SE',
      serviceWorkers: 'block',
      permissions: ['camera'],
    });
    const scanPage = await context.newPage();
    scanPage.on('pageerror', (error) => errors.push(`pageerror (auto): ${error.message}`));
    await scanPage.goto(`${BASE}/#/scan`, { waitUntil: 'domcontentloaded' });
    await scanPage.waitForSelector('.scan-viewfinder--live', { timeout: 30_000 });
    await body(scanPage);
  } finally {
    await browser.close();
  }
}

/**
 * Writes the two camera scenes as Y4M clips and returns their paths.
 *
 * The conversion runs in the page because that is where an image decoder is:
 * the fixture is drawn to a canvas, read back as RGBA and converted to the
 * I420 planes a Y4M frame carries. Chromium loops the file, so one frame is a
 * scene that holds perfectly still — which is exactly the thing being tested.
 */
async function writeCameraScenes(page, fixtureName) {
  const width = 480;
  const height = 640;
  const paths = {};

  for (const scene of ['receipt', 'desk']) {
    const planes = await page.evaluate(
      async ({ name, width, height, scene }) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        // A wooden table, under both scenes: it is the background in one and
        // the whole of the other.
        context.fillStyle = '#6d5238';
        context.fillRect(0, 0, width, height);
        if (scene === 'receipt') {
          const bitmap = await createImageBitmap(await (await fetch(`/__fixture/${name}`)).blob(), {
            imageOrientation: 'from-image',
          });
          const scale = Math.min((width * 0.72) / bitmap.width, (height * 0.82) / bitmap.height);
          const drawWidth = bitmap.width * scale;
          const drawHeight = bitmap.height * scale;
          context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        } else {
          for (let row = 0; row < 30; row += 1) {
            context.fillStyle = row % 2 ? '#5d4228' : '#7a5f45';
            context.fillRect(0, row * 22, width, 11);
          }
        }

        const { data } = context.getImageData(0, 0, width, height);
        const luma = new Uint8Array(width * height);
        const blue = new Uint8Array((width / 2) * (height / 2));
        const red = new Uint8Array((width / 2) * (height / 2));
        for (let row = 0; row < height; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const offset = (row * width + column) * 4;
            const r = data[offset];
            const g = data[offset + 1];
            const b = data[offset + 2];
            luma[row * width + column] = Math.max(16, Math.min(235, Math.round(0.257 * r + 0.504 * g + 0.098 * b + 16)));
            if (row % 2 === 0 && column % 2 === 0) {
              const index = (row / 2) * (width / 2) + column / 2;
              blue[index] = Math.max(16, Math.min(240, Math.round(-0.148 * r - 0.291 * g + 0.439 * b + 128)));
              red[index] = Math.max(16, Math.min(240, Math.round(0.439 * r - 0.368 * g - 0.071 * b + 128)));
            }
          }
        }
        return { luma: [...luma], blue: [...blue], red: [...red] };
      },
      { name: fixtureName, width, height, scene },
    );

    const frame = Buffer.concat([
      Buffer.from('FRAME\n', 'ascii'),
      Buffer.from(planes.luma),
      Buffer.from(planes.blue),
      Buffer.from(planes.red),
    ]);
    const file = join(OUT, `camera-${scene}.y4m`);
    writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(`YUV4MPEG2 W${width} H${height} F15:1 Ip A1:1 C420mpeg2\n`, 'ascii'),
        ...Array.from({ length: 15 }, () => frame),
      ]),
    );
    paths[scene] = file;
  }
  return paths;
}

/** The capture screen's measurements, as the layout has to keep them. */
function captureGeometry(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)];
    };
    return {
      viewfinder: box('.scan-viewfinder'),
      shutter: box('.scan-shutter'),
      tools: box('.scan-capture__tools'),
      scrollHeight: document.scrollingElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
}

/**
 * Searching, which is typing — so the screen must hold still around it.
 *
 * The field is checked by node identity rather than by selector: the bug this
 * guards against replaced the whole view between keystrokes, which looks fine
 * in a screenshot and costs the caret, the focus and (on iOS) the keyboard.
 */
async function runSearchFlow(page) {
  await page.goto(`${BASE}/#/receipts`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.receipt-card', { timeout: 20_000 });
  const before = await page.locator('.receipt-card').count();

  // Marks on the live nodes; a rebuild of either loses its mark.
  await page.evaluate(() => {
    document.querySelector('.search-field input').dataset.probe = 'original';
    document.querySelector('#view-outlet').firstElementChild.dataset.probe = 'original';
  });

  await page.click('.search-field input');
  for (const character of 'zvv') {
    await page.keyboard.type(character, { delay: 60 });
    // Past the debounce, which is when the screen used to be rebuilt.
    await page.waitForTimeout(320);
    const state = await page.evaluate(() => {
      const input = document.querySelector('.search-field input');
      return {
        sameInput: input?.dataset.probe === 'original',
        sameView: document.querySelector('#view-outlet').firstElementChild?.dataset.probe === 'original',
        focused: document.activeElement === input,
        value: input?.value,
        caret: input?.selectionStart,
      };
    });
    if (!state.sameInput) fail(`the search field was rebuilt while "${state.value}" was being typed`);
    if (!state.sameView) fail(`the screen was rebuilt while "${state.value}" was being typed`);
    if (!state.focused) fail(`the search field lost focus while "${state.value}" was being typed`);
    if (state.caret !== state.value.length) fail(`the caret moved: ${state.caret} in "${state.value}"`);
  }

  await page.waitForSelector('.empty-state', { timeout: 10_000 });
  if (!page.url().includes('q=zvv')) fail(`the query never reached the URL: ${page.url()}`);
  log('search: the field keeps focus and its caret while the results narrow');

  // And clearing it brings the list back, without a reload.
  await page.fill('.search-field input', '');
  await page.waitForFunction((count) => document.querySelectorAll('.receipt-card').length === count, before, {
    timeout: 10_000,
  });
  log('search: clearing the query brings the list back');
}
