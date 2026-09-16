import assert from 'node:assert/strict';
import { test } from 'node:test';

import { listParam, numberParam } from '../src/views/filter-params.ts';

void test('listParam splits a comma-joined value', () => {
  const params = new URLSearchParams({ cat: 'a,b,c' });
  assert.deepEqual(listParam(params, 'cat'), ['a', 'b', 'c']);
});

void test('listParam drops empty entries from a trailing comma', () => {
  const params = new URLSearchParams({ cat: 'a,,b,' });
  assert.deepEqual(listParam(params, 'cat'), ['a', 'b']);
});

void test('listParam is undefined for a missing or empty key', () => {
  const params = new URLSearchParams({ cat: '' });
  assert.equal(listParam(params, 'cat'), undefined);
  assert.equal(listParam(params, 'missing'), undefined);
});

void test('numberParam parses a finite number', () => {
  const params = new URLSearchParams({ min: '12.5' });
  assert.equal(numberParam(params, 'min'), 12.5);
});

void test('numberParam is undefined for a missing key', () => {
  const params = new URLSearchParams();
  assert.equal(numberParam(params, 'min'), undefined);
});

void test('numberParam is undefined for a non-numeric value', () => {
  const params = new URLSearchParams({ min: 'not-a-number' });
  assert.equal(numberParam(params, 'min'), undefined);
});

void test('numberParam accepts zero, which is falsy but valid', () => {
  const params = new URLSearchParams({ min: '0' });
  assert.equal(numberParam(params, 'min'), 0);
});
