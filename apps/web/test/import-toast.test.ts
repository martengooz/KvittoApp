import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeImportOutcome, type ImportToast } from '../src/scan/import-toast.ts';
import type { ImportOutcome } from '../src/scan/import.ts';

function outcome(overrides: Partial<ImportOutcome>): ImportOutcome {
  return { receiptIds: [], uncropped: 0, failures: [], parsing: false, ...overrides };
}

void test('a batch that saved nothing reports the first failure as the only toast', () => {
  const toasts = describeImportOutcome(
    outcome({ failures: [{ name: 'a.jpg', message: 'trasig fil' }, { name: 'b.jpg', message: 'okänt fel' }] }),
  );
  const expected: ImportToast[] = [{ message: 'Bilden kunde inte läsas: trasig fil', kind: 'error' }];
  assert.deepEqual(toasts, expected);
});

void test('a batch that saved nothing and has no failure detail falls back to a generic message', () => {
  const toasts = describeImportOutcome(outcome({}));
  assert.deepEqual(toasts, [{ message: 'Inga kvitton kunde sparas.', kind: 'error' }]);
});

void test('one saved receipt is singular and mentions parsing when it started', () => {
  const toasts = describeImportOutcome(outcome({ receiptIds: ['r1'], parsing: true }));
  assert.deepEqual(toasts, [{ message: 'Ett kvitto tillagt — tolkas nu med AI.', kind: 'success' }]);
});

void test('several saved receipts are plural, and parsing is omitted when it did not start', () => {
  const toasts = describeImportOutcome(outcome({ receiptIds: ['r1', 'r2', 'r3'], parsing: false }));
  assert.deepEqual(toasts, [{ message: '3 kvitton tillagda.', kind: 'success' }]);
});

void test('a partial batch adds a singular failure toast', () => {
  const toasts = describeImportOutcome(
    outcome({ receiptIds: ['r1'], failures: [{ name: 'b.jpg', message: 'trasig fil' }] }),
  );
  assert.deepEqual(toasts, [
    { message: 'Ett kvitto tillagt.', kind: 'success' },
    { message: 'b.jpg kunde inte läsas.', kind: 'error' },
  ]);
});

void test('several failures are counted rather than named', () => {
  const toasts = describeImportOutcome(
    outcome({
      receiptIds: ['r1'],
      failures: [
        { name: 'a.jpg', message: 'x' },
        { name: 'b.jpg', message: 'y' },
      ],
    }),
  );
  assert.deepEqual(toasts, [
    { message: 'Ett kvitto tillagt.', kind: 'success' },
    { message: '2 bilder kunde inte läsas.', kind: 'error' },
  ]);
});

void test('an uncropped save adds a singular info note', () => {
  const toasts = describeImportOutcome(outcome({ receiptIds: ['r1'], uncropped: 1 }));
  assert.deepEqual(toasts, [
    { message: 'Ett kvitto tillagt.', kind: 'success' },
    { message: 'Ett kvitto sparades obeskuret — kanterna gick inte att hitta.', kind: 'info' },
  ]);
});

void test('several uncropped saves are counted', () => {
  const toasts = describeImportOutcome(outcome({ receiptIds: ['r1', 'r2'], uncropped: 2 }));
  assert.deepEqual(toasts, [
    { message: '2 kvitton tillagda.', kind: 'success' },
    { message: '2 kvitton sparades obeskurna — kanterna gick inte att hitta.', kind: 'info' },
  ]);
});

void test('failures and uncropped notes can both appear, in that order', () => {
  const toasts = describeImportOutcome(
    outcome({ receiptIds: ['r1'], uncropped: 1, failures: [{ name: 'b.jpg', message: 'x' }] }),
  );
  assert.deepEqual(toasts, [
    { message: 'Ett kvitto tillagt.', kind: 'success' },
    { message: 'b.jpg kunde inte läsas.', kind: 'error' },
    { message: 'Ett kvitto sparades obeskuret — kanterna gick inte att hitta.', kind: 'info' },
  ]);
});
