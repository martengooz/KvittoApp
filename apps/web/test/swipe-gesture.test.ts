import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampOffset, resolveSwipe, swipeAxis, SWIPE_SLOP } from '../src/components/swipe-gesture.ts';

/** A phone-width receipt card with a "Ta bort" button behind it. */
const row = { rowWidth: 360, actionWidth: 92 };

void test('a drag that has barely moved commits to neither axis', () => {
  assert.equal(swipeAxis(0, 0), 'undecided');
  assert.equal(swipeAxis(SWIPE_SLOP, SWIPE_SLOP - 1), 'undecided');
});

void test('a mostly-sideways drag is a swipe and a mostly-upright one is a scroll', () => {
  assert.equal(swipeAxis(-40, 6), 'horizontal');
  assert.equal(swipeAxis(6, -40), 'vertical');
});

void test('the row follows the finger left as far as its own width, and no further', () => {
  assert.equal(clampOffset(-92, row), -92);
  assert.equal(clampOffset(-500, row), -360);
});

void test('pulling a closed row the wrong way goes slack instead of following', () => {
  assert.equal(clampOffset(40, row), 10);
  assert.equal(clampOffset(400, row), 24);
});

void test('letting go before half the action springs the row back', () => {
  assert.equal(resolveSwipe(0, row), 'closed');
  assert.equal(resolveSwipe(-45, row), 'closed');
});

void test('letting go past half the action leaves it open, up to most of the row', () => {
  assert.equal(resolveSwipe(-46, row), 'open');
  assert.equal(resolveSwipe(-190, row), 'open');
});

void test('carrying the row across most of its width deletes without stopping open', () => {
  assert.equal(resolveSwipe(-200, row), 'action');
  assert.equal(resolveSwipe(-360, row), 'action');
});

void test('a row narrow enough for its action to fill it still has all three outcomes', () => {
  const narrow = { rowWidth: 160, actionWidth: 92 };
  assert.equal(resolveSwipe(-40, narrow), 'closed');
  assert.equal(resolveSwipe(-60, narrow), 'open');
  assert.equal(resolveSwipe(-140, narrow), 'action');
});
