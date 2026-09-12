/**
 * Copies the OpenCV.js build into `public/vendor/` so the CV worker can pull it
 * from a stable, unhashed URL at runtime.
 *
 * It is deliberately *not* bundled: the file is ~11 MB, and bundling it would
 * push it into the service worker's precache, making the very first page load
 * download all of it. Instead the worker loads it on demand and Workbox caches
 * it with a CacheFirst rule, so it costs nothing until the first scan and is
 * available offline forever after.
 */
import { createRequire } from 'node:module';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'public', 'vendor', 'opencv.js');

const require = createRequire(import.meta.url);
let source;
try {
  source = require.resolve('@techstark/opencv-js/dist/opencv.js');
} catch {
  console.error(
    '[opencv] @techstark/opencv-js is not installed. Run `npm install` at the repo root.\n' +
      '[opencv] The app still builds without it and falls back to the canvas-only pipeline.',
  );
  process.exit(0);
}

const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target).catch(() => null)]);
if (targetStat && targetStat.size === sourceStat.size) {
  console.log('[opencv] public/vendor/opencv.js is up to date');
  process.exit(0);
}

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log(`[opencv] copied ${(sourceStat.size / 1024 / 1024).toFixed(1)} MB to public/vendor/opencv.js`);
