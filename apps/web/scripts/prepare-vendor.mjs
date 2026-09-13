/**
 * Stages the two large runtimes into `public/vendor/` so they load from stable,
 * unhashed URLs the service worker can cache.
 *
 * Neither is bundled. Together they are ~20 MB, and bundling would push them
 * into the precache, making a first page load download all of it before the
 * user has scanned anything. Instead both are fetched on demand and cached
 * with a CacheFirst rule, so they cost nothing until the first scan and are
 * then available offline forever.
 *
 * The Tesseract language data is not shipped in any npm package, so it is
 * downloaded once and committed-adjacent (gitignored, re-fetched by
 * `npm install`/build). A build with no network still succeeds — OCR simply
 * degrades to unavailable, and the app keeps working without it.
 */
import { createRequire } from 'node:module';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'public', 'vendor');
const require = createRequire(import.meta.url);

/** Language models to make available offline. */
const LANGUAGES = ['swe', 'eng'];

/**
 * The `_fast` tessdata models, not the standard ones.
 *
 * Standard `swe` + `eng` is 17 MB; fast is 4.5 MB for the same two. The
 * accuracy difference shows up on unusual fonts and layouts, and matters far
 * less here than it would for full-document OCR: what this pipeline reads is
 * an organisation number verified by its own checksum, a date validated by a
 * calendar, and a company name compared with fuzzy matching. All three
 * tolerate the odd wrong character; a 12 MB larger first scan does not.
 */
const TESSDATA_BASE = 'https://tessdata.projectnaptha.com/4.0.0_fast';

/**
 * WASM cores to stage.
 *
 * Only the LSTM builds: the non-LSTM ones carry Tesseract's legacy engine,
 * which this app never selects. Only the `.wasm.js` files, because those embed
 * the binary — the sibling `.wasm` files are for callers who want streaming
 * instantiation and are dead weight here.
 *
 * Two variants rather than one so a browser without WASM SIMD still works;
 * the OCR worker feature-detects and asks for the right file by name.
 */
const TESSERACT_CORES = ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'];

await mkdir(vendorDir, { recursive: true });

await copyOpenCv();
await copyTesseractRuntime();
await downloadLanguages();

async function fileSize(path) {
  return stat(path).then((info) => info.size).catch(() => null);
}

/** Copies a file only when the destination differs in size. */
async function stage(source, target, label) {
  const [sourceStat, targetSize] = await Promise.all([stat(source), fileSize(target)]);
  if (targetSize === sourceStat.size) return false;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  console.log(`[vendor] ${label} (${(sourceStat.size / 1024 / 1024).toFixed(1)} MB)`);
  return true;
}

async function copyOpenCv() {
  let source;
  try {
    source = require.resolve('@techstark/opencv-js/dist/opencv.js');
  } catch {
    console.error('[vendor] @techstark/opencv-js is missing; the canvas fallback will be used.');
    return;
  }
  const changed = await stage(source, join(vendorDir, 'opencv.js'), 'opencv.js');
  if (!changed) console.log('[vendor] opencv.js is up to date');
}

/**
 * Copies Tesseract's worker script and its WASM cores.
 *
 * All core variants are staged rather than one: tesseract.js picks between the
 * plain, SIMD and relaxed-SIMD builds at runtime based on what the browser
 * supports, and a missing variant is a hard failure on that browser.
 */
async function copyTesseractRuntime() {
  let workerSource;
  try {
    workerSource = require.resolve('tesseract.js/dist/worker.min.js');
  } catch {
    console.error('[vendor] tesseract.js is missing; OCR will be unavailable.');
    return;
  }
  await stage(workerSource, join(vendorDir, 'tesseract', 'worker.min.js'), 'tesseract worker');

  const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));
  const targetDir = join(vendorDir, 'tesseract', 'core');
  let copied = 0;
  for (const name of TESSERACT_CORES) {
    if (await stage(join(coreDir, name), join(targetDir, name), `tesseract ${name}`)) copied += 1;
  }
  if (copied === 0) console.log('[vendor] tesseract core is up to date');
}

/**
 * Downloads the language models.
 *
 * A failure here is not fatal: the build continues and the app reports OCR as
 * unavailable rather than refusing to build on a machine that is offline.
 */
async function downloadLanguages() {
  const targetDir = join(vendorDir, 'tessdata');
  await mkdir(targetDir, { recursive: true });

  for (const language of LANGUAGES) {
    const target = join(targetDir, `${language}.traineddata.gz`);
    if (((await fileSize(target)) ?? 0) > 0) {
      console.log(`[vendor] ${language}.traineddata.gz is present`);
      continue;
    }
    try {
      const response = await fetch(`${TESSDATA_BASE}/${language}.traineddata.gz`);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(target, bytes);
      console.log(`[vendor] ${language}.traineddata.gz (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
    } catch (error) {
      console.error(
        `[vendor] could not download ${language}.traineddata.gz: ${String(error)}\n` +
          '[vendor] OCR will report itself unavailable until this is fetched.',
      );
    }
  }
}
