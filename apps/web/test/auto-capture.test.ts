import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advance,
  coverageOf,
  IDLE_WATCH,
  inkRatio,
  isSteady,
  looksLikeReceipt,
  STEADY_READINGS,
  type FrameReading,
} from '../src/scan/auto-capture.ts';
import type { Quad } from '../src/cv/types.ts';

/** A frame the size the watcher actually measures. */
const FRAME = { width: 236, height: 420 };

function quad(x: number, y: number, width = 120, height = 240): Quad {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function reading(overrides: Partial<FrameReading> = {}): FrameReading {
  return {
    corners: quad(50, 80),
    detection: 'paper',
    coverage: 0.29,
    ink: 0.16,
    frameWidth: FRAME.width,
    frameHeight: FRAME.height,
    ...overrides,
  };
}

// --- what counts as a receipt ---------------------------------------------

void test('a printed sheet found by the paper strategy is a receipt', () => {
  assert.equal(looksLikeReceipt(reading()), true);
});

void test('the blank wall that scores a perfect detector confidence is not', () => {
  // The control that made confidence unusable: outline over the whole frame,
  // found as "paper", and no ink anywhere in it.
  assert.equal(looksLikeReceipt(reading({ coverage: 1, ink: 0 })), false);
});

void test('a desk or a hand, which only the last-resort strategy finds, is not', () => {
  assert.equal(looksLikeReceipt(reading({ detection: 'threshold' })), false);
  assert.equal(looksLikeReceipt(reading({ detection: 'full-frame', corners: null })), false);
});

void test('a frame that is mostly dark is not, however rectangular', () => {
  assert.equal(looksLikeReceipt(reading({ ink: 0.65 })), false);
});

void test('a speck too small to be a receipt is not', () => {
  assert.equal(looksLikeReceipt(reading({ coverage: 0.05 })), false);
});

void test('the whole measured fixture range counts', () => {
  // The nine hand-held photographs in `fixtures/`, as measured at probe size.
  for (const ink of [0.094, 0.125, 0.271, 0.295, 0.297, 0.394, 0.427, 0.446, 0.504]) {
    assert.equal(looksLikeReceipt(reading({ ink })), true, `ink ${ink}`);
  }
  for (const coverage of [0.33, 0.45, 0.5, 0.56, 0.57, 0.64, 0.68, 0.97, 0.99]) {
    assert.equal(looksLikeReceipt(reading({ coverage })), true, `coverage ${coverage}`);
  }
});

// --- holding still ---------------------------------------------------------

void test('a hand tremor still counts as holding still', () => {
  assert.equal(isSteady(quad(50, 80), quad(52, 83), FRAME), true);
});

void test('a receipt still being moved into place does not', () => {
  assert.equal(isSteady(quad(50, 80), quad(90, 80), FRAME), false);
});

void test('a receipt held at the same place but a different size does not', () => {
  assert.equal(isSteady(quad(50, 80), quad(50, 80, 200, 300), FRAME), false);
});

// --- the watch -------------------------------------------------------------

void test('holding a receipt still fires the shutter, and not before', () => {
  let state = IDLE_WATCH;
  const outcomes: boolean[] = [];
  for (let look = 0; look < STEADY_READINGS; look += 1) {
    const verdict = advance(state, reading({ corners: quad(50 + look, 80) }));
    state = verdict.state;
    outcomes.push(verdict.capture);
  }
  assert.deepEqual(outcomes, [...Array<boolean>(STEADY_READINGS - 1).fill(false), true]);
});

void test('the first sight of a receipt is not yet a hold', () => {
  const verdict = advance(IDLE_WATCH, reading());
  assert.equal(verdict.state.status, 'searching');
  assert.equal(verdict.capture, false);
});

void test('a second, agreeing look is worth saying something about', () => {
  const first = advance(IDLE_WATCH, reading()).state;
  assert.equal(advance(first, reading()).state.status, 'holding');
});

void test('a hold interrupted starts over rather than resuming', () => {
  let state = advance(IDLE_WATCH, reading()).state;
  state = advance(state, reading()).state;
  assert.equal(state.steady, 2);

  // The receipt leaves the frame for one look.
  state = advance(state, reading({ corners: null, detection: 'full-frame' })).state;
  assert.deepEqual(state, IDLE_WATCH);

  const back = advance(state, reading());
  assert.equal(back.state.steady, 1);
  assert.equal(back.capture, false);
});

void test('a receipt being waved about is never still enough to fire', () => {
  let state = IDLE_WATCH;
  for (let look = 0; look < 12; look += 1) {
    const verdict = advance(state, reading({ corners: quad(20 + (look % 2) * 60, 80) }));
    state = verdict.state;
    assert.equal(verdict.capture, false, `look ${look}`);
  }
});

// --- frame measurements ----------------------------------------------------

void test('coverage is the share of the frame inside the outline', () => {
  const half = coverageOf(quad(0, 0, FRAME.width, FRAME.height / 2), FRAME.width, FRAME.height);
  assert.equal(Number(half.toFixed(3)), 0.5);
});

void test('coverage of a quad wound the other way is still positive', () => {
  const reversed = [...quad(0, 0, FRAME.width, FRAME.height)].reverse() as Quad;
  assert.equal(coverageOf(reversed, FRAME.width, FRAME.height), 1);
});

/** Paints `width`×`height` of paper, with `rows` printed lines across it. */
function page(width: number, height: number, rows: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const y = Math.floor(index / width);
    const printed = rows > 0 && y % Math.max(2, Math.floor(height / rows)) === 0;
    const value = printed ? 30 : 235;
    pixels.set([value, value, value, 255], index * 4);
  }
  return pixels;
}

void test('ink measures the printing, not the paper', () => {
  const printed = inkRatio(page(160, 300, 20), 160, 300, quad(0, 0, 160, 300));
  assert.ok(printed > 0.03 && printed < 0.6, `expected a receipt-like ink ratio, got ${printed}`);
});

void test('blank paper measures no ink at all', () => {
  assert.equal(inkRatio(page(160, 300, 0), 160, 300, quad(0, 0, 160, 300)), 0);
});

void test('ink only counts what is inside the outline', () => {
  // Printed lines down the left half of the page, blank paper down the right.
  const pixels = page(160, 300, 0);
  for (let y = 0; y < 300; y += 12) {
    for (let x = 0; x < 70; x += 1) pixels.set([20, 20, 20, 255], (y * 160 + x) * 4);
  }
  assert.ok(inkRatio(pixels, 160, 300, quad(0, 10, 70, 280)) > 0.03, 'the printed half');
  assert.equal(inkRatio(pixels, 160, 300, quad(85, 10, 70, 280)), 0, 'the blank half');
});

void test('paper that is simply dark all over is not ink', () => {
  const pixels = new Uint8ClampedArray(160 * 300 * 4);
  for (let index = 0; index < 160 * 300; index += 1) pixels.set([24, 20, 18, 255], index * 4);
  assert.equal(inkRatio(pixels, 160, 300, quad(0, 0, 160, 300)), 0);
});

void test('an outline too small to sample says nothing rather than something', () => {
  assert.equal(inkRatio(page(160, 300, 20), 160, 300, quad(10, 10, 4, 4)), 0);
});
