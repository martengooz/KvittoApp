/**
 * Renders the KvittoApp icon set to PNG without any image dependencies.
 *
 * The icon is described as a signed-distance-ish `colorAt(x, y)` function over
 * normalised coordinates, sampled 3x3 per pixel for antialiasing, then encoded
 * as a bare RGBA PNG (IHDR/IDAT/IEND with filter byte 0 per scanline).
 *
 * Run with `node scripts/generate-icons.mjs`. Output is committed, so a normal
 * build never needs to run it.
 */
import { deflateSync } from 'node:zlib';

import { launchScreenVariants } from './launch-screens.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');

const NAVY = [16, 42, 74, 255];
const NAVY_LIGHT = [26, 62, 105, 255];
const PAPER = [250, 250, 247, 255];
const INK = [150, 158, 170, 255];
const ACCENT = [255, 200, 60, 255];
const TRANSPARENT = [0, 0, 0, 0];

/** Blends `over` onto `under` using `over`'s alpha. */
function blend(under, over) {
  const alpha = over[3] / 255;
  if (alpha === 0) return under;
  if (alpha === 1) return over;
  return [
    Math.round(under[0] * (1 - alpha) + over[0] * alpha),
    Math.round(under[1] * (1 - alpha) + over[1] * alpha),
    Math.round(under[2] * (1 - alpha) + over[2] * alpha),
    Math.max(under[3], over[3]),
  ];
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Builds the icon sampler.
 *
 * @param {number} inset  Fraction of the canvas to keep clear around the art.
 *                        Maskable icons need the content inside the middle 80 %.
 * @param {number} bgRadius Corner radius of the background plate, 0 for full bleed.
 * @param {boolean} [plate=true] Draw the coloured plate behind the receipt.
 *   Launch screens set this false: the plate is the same navy as the screen
 *   they sit on, so drawing it would only produce a faint invisible square.
 */
function makeIcon({ inset, bgRadius, plate = true }) {
  // Receipt body, in normalised canvas coordinates.
  const scale = 1 - inset * 2;
  const map = (value) => inset + value * scale;
  const left = map(0.26);
  const right = map(0.74);
  const top = map(0.14);
  const bodyBottom = map(0.78);
  const teeth = 6;
  const toothHeight = 0.045 * scale;

  return (x, y) => {
    let pixel = TRANSPARENT;

    if (plate) {
      // Background plate.
      if (bgRadius === 0) {
        pixel = NAVY;
      } else if (insideRoundedRect(x, y, 0, 0, 1, 1, bgRadius)) {
        pixel = NAVY;
      }
      if (pixel[3] === 0) return pixel;

      // Smooth diagonal lift so the plate is not a flat slab.
      const lift = Math.max(0, Math.min(1, 1 - (x + y) / 1.6));
      pixel = blend(pixel, [...NAVY_LIGHT.slice(0, 3), Math.round(lift * 150)]);
    }

    // Torn bottom edge: a triangular wave under the receipt body.
    const width = right - left;
    const local = (x - left) / (width / teeth);
    const phase = Math.abs((local % 1) - 0.5) * 2;
    const bottom = bodyBottom + phase * toothHeight;

    const inBody = x >= left && x <= right && y >= top && y <= bottom;
    if (!inBody) return pixel;

    pixel = blend(pixel, PAPER);

    // Printed lines. The last one is the total, in the accent colour.
    const lines = [
      { y: 0.28, from: 0.10, to: 0.90, color: INK, weight: 0.055 },
      { y: 0.42, from: 0.10, to: 0.72, color: INK, weight: 0.04 },
      { y: 0.52, from: 0.10, to: 0.84, color: INK, weight: 0.04 },
      { y: 0.62, from: 0.10, to: 0.64, color: INK, weight: 0.04 },
      { y: 0.78, from: 0.10, to: 0.90, color: ACCENT, weight: 0.07 },
    ];
    const height = bodyBottom - top;
    for (const line of lines) {
      const centre = top + line.y * height;
      const half = (line.weight * height) / 2;
      if (Math.abs(y - centre) > half) continue;
      if (x < left + line.from * width || x > left + line.to * width) continue;
      pixel = blend(pixel, line.color);
    }
    return pixel;
  };
}

const SUPERSAMPLE = 3;

function render(size, sampler) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SUPERSAMPLE);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px * SUPERSAMPLE + sx + 0.5) * step;
          const y = (py * SUPERSAMPLE + sy + 0.5) * step;
          const [cr, cg, cb, ca] = sampler(x, y);
          const weight = ca / 255;
          r += cr * weight;
          g += cg * weight;
          b += cb * weight;
          a += ca;
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const alpha = a / samples;
      const coverage = alpha === 0 ? 0 : a / 255;
      const offset = (py * size + px) * 4;
      pixels[offset] = coverage === 0 ? 0 : Math.round(r / coverage);
      pixels[offset + 1] = coverage === 0 ? 0 : Math.round(g / coverage);
      pixels[offset + 2] = coverage === 0 ? 0 : Math.round(b / coverage);
      pixels[offset + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type "None"
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const standard = makeIcon({ inset: 0.06, bgRadius: 0.22 });
const maskable = makeIcon({ inset: 0.14, bgRadius: 0 });

const outputs = [
  ['icons/icon-192.png', 192, standard],
  ['icons/icon-512.png', 512, standard],
  ['icons/maskable-512.png', 512, maskable],
  ['apple-touch-icon.png', 180, standard],
];

await mkdir(join(publicDir, 'icons'), { recursive: true });
for (const [name, size, sampler] of outputs) {
  const png = encodePng(size, render(size, sampler));
  await writeFile(join(publicDir, name), png);
  console.log(`[icons] ${name} (${size}x${size}, ${(png.length / 1024).toFixed(1)} kB)`);
}

// --- iOS launch screens ---------------------------------------------------
//
// Geometry comes from `launch-screens.mjs`, which the Vite build also reads to
// emit the matching `<link>` tags — one table, so images and tags cannot drift.

/** Draws the receipt glyph centred on the launch background. */
function launchSampler(width, height, iconPx) {
  const glyph = makeIcon({ inset: 0.06, bgRadius: 0.22, plate: false });
  const left = (width - iconPx) / 2;
  const top = (height - iconPx) / 2;

  return (x, y) => {
    const px = x * width;
    const py = y * height;
    if (px < left || px >= left + iconPx || py < top || py >= top + iconPx) {
      return NAVY;
    }
    // Composite over the ground rather than returning the glyph's own
    // transparency, or the launch screen shows through to white at the edges.
    return blend(NAVY, glyph((px - left) / iconPx, (py - top) / iconPx));
  };
}

/** Renders a non-square canvas by sampling in normalised coordinates. */
function renderRect(width, height, sampler) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      // One sample per pixel: launch screens are a flat ground plus a rounded
      // icon, so the supersampling the icons need buys nothing here.
      const [r, g, b, a] = sampler((px + 0.5) / width, (py + 0.5) / height);
      const offset = (py * width + px) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = a;
    }
  }
  return pixels;
}

function encodePngRect(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir(join(publicDir, 'launch'), { recursive: true });
let launchBytes = 0;

for (const variant of launchScreenVariants()) {
  const iconPx = Math.round(Math.min(variant.width, variant.height) * 0.26);
  const pixels = renderRect(variant.width, variant.height, launchSampler(variant.width, variant.height, iconPx));
  const png = encodePngRect(variant.width, variant.height, pixels);
  await writeFile(join(publicDir, variant.file), png);
  launchBytes += png.length;
}

console.log(
  `[icons] ${launchScreenVariants().length} launch screens ` +
    `(${(launchBytes / 1024 / 1024).toFixed(2)} MB total)`,
);
