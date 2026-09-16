import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECEIPT_CORRECTION_SYSTEM_PROMPT,
  RECEIPT_SYSTEM_PROMPT,
  RECEIPT_USER_PROMPT,
  buildCorrectionUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  isBetterReading,
} from '../dist/index.js';

test('a correcting pass gets a different system prompt from a first pass', () => {
  const first = buildSystemPrompt(null);
  const correcting = buildSystemPrompt(null, { correction: true });

  assert.equal(first, RECEIPT_SYSTEM_PROMPT);
  assert.equal(correcting, RECEIPT_CORRECTION_SYSTEM_PROMPT);
  assert.notEqual(first, correcting);
});

test('the correcting prompt lifts the two rules it means to lift', () => {
  // The first pass forbids computing and forbids reformatting the date. The
  // correcting pass exists precisely to allow both, so if this wording ever
  // drifts back to "never calculate" the feature silently stops working.
  assert.match(RECEIPT_SYSTEM_PROMPT, /Transcribe, do not calculate/);
  assert.match(RECEIPT_CORRECTION_SYSTEM_PROMPT, /You may reconcile/);
  assert.match(RECEIPT_CORRECTION_SYSTEM_PROMPT, /YYYY-MM-DD/);
});

test('the correcting prompt forbids inventing a number to force a balance', () => {
  // The whole risk of this feature: "make it add up" is satisfiable by editing
  // a number, and a silently balanced receipt is worse than a flagged one
  // because the user never learns to check it.
  assert.match(RECEIPT_CORRECTION_SYSTEM_PROMPT, /NEVER change a number just to make the arithmetic work/);
  assert.match(RECEIPT_CORRECTION_SYSTEM_PROMPT, /leave it not adding up/);
});

test('user-configured extra instructions still apply to a correcting pass', () => {
  const prompt = buildSystemPrompt('Coop prints pant on the line above.', { correction: true });
  assert.match(prompt, /Coop prints pant on the line above\./);
  assert.match(prompt, /You may reconcile/);
});

test('a correcting pass never uses the compact prompt, even on a local model', () => {
  // The compact prompt drops the reasoning a small model cannot generalise
  // from — but a correction pass is entirely reasoning, so compact would gut
  // it. `buildSystemPrompt` must let `correction` win over `compact`.
  const prompt = buildSystemPrompt(null, { compact: true, correction: true });
  assert.equal(prompt, RECEIPT_CORRECTION_SYSTEM_PROMPT);
});

test('the user turn carries the problems and the previous attempt', () => {
  const prompt = buildCorrectionUserPrompt({
    problems: ['The line items add up to 245.00 but the total says 285.00 (off by 40.00).'],
    previous: { total: '285,00', items: [{ name: 'Mjölk', totalPrice: '245,00' }] },
  });

  assert.match(prompt, /off by 40\.00/);
  assert.match(prompt, /"total": "285,00"/);
  assert.match(prompt, /Mjölk/);
});

test('buildUserPrompt returns the plain instruction when not correcting', () => {
  assert.equal(buildUserPrompt(), RECEIPT_USER_PROMPT);
  assert.equal(buildUserPrompt(null), RECEIPT_USER_PROMPT);
  assert.notEqual(buildUserPrompt({ problems: ['x'], previous: {} }), RECEIPT_USER_PROMPT);
});

test('every problem reaches the prompt as its own bullet', () => {
  const prompt = buildCorrectionUserPrompt({
    problems: ['No purchase date was found.', 'No total was found.'],
    previous: {},
  });
  assert.match(prompt, /- No purchase date was found\./);
  assert.match(prompt, /- No total was found\./);
});

// --- isBetterReading -------------------------------------------------------

/** A validation report with the given issue mix, for comparison tests. */
function report(options: { errors?: number; warnings?: number; discrepancy?: number | null }) {
  const issues = [
    ...Array.from({ length: options.errors ?? 0 }, (_, i) => ({
      code: `e${i}`,
      severity: 'error' as const,
      message: 'error',
    })),
    ...Array.from({ length: options.warnings ?? 0 }, (_, i) => ({
      code: `w${i}`,
      severity: 'warning' as const,
      message: 'warning',
    })),
  ];
  return {
    issues,
    itemsTotal: 0,
    linesTotal: 0,
    discrepancy: options.discrepancy ?? null,
    ok: issues.length === 0,
  };
}

test('fewer errors wins, even at the cost of more warnings', () => {
  const next = report({ errors: 0, warnings: 5 });
  const previous = report({ errors: 1, warnings: 0 });
  assert.equal(isBetterReading(next, previous), true);
});

test('more errors loses, however few warnings come with it', () => {
  assert.equal(isBetterReading(report({ errors: 2 }), report({ errors: 1, warnings: 9 })), false);
});

test('with errors tied, fewer warnings wins', () => {
  assert.equal(isBetterReading(report({ warnings: 1 }), report({ warnings: 3 })), true);
  assert.equal(isBetterReading(report({ warnings: 3 }), report({ warnings: 1 })), false);
});

test('with issues tied, a narrower arithmetic gap wins', () => {
  const next = report({ warnings: 1, discrepancy: 0.6 });
  const previous = report({ warnings: 1, discrepancy: 40 });
  assert.equal(isBetterReading(next, previous), true);
});

test('the sign of the discrepancy does not matter, only its size', () => {
  assert.equal(
    isBetterReading(report({ warnings: 1, discrepancy: -0.6 }), report({ warnings: 1, discrepancy: 40 })),
    true,
  );
  assert.equal(
    isBetterReading(report({ warnings: 1, discrepancy: -40 }), report({ warnings: 1, discrepancy: 0.6 })),
    false,
  );
});

test('an identical reading is not better, so the first one stands', () => {
  // Equal must not count as better: a correcting pass that merely swapped one
  // problem for another has not improved the receipt, and the original was at
  // least not produced by a prompt told to change something.
  const same = report({ warnings: 2, discrepancy: 5 });
  assert.equal(isBetterReading(same, report({ warnings: 2, discrepancy: 5 })), false);
});

test('trading one warning for another is not an improvement', () => {
  const next = report({ warnings: 1, discrepancy: 12 });
  const previous = report({ warnings: 1, discrepancy: 12 });
  assert.equal(isBetterReading(next, previous), false);
});

test('a clean reading beats one with any problem at all', () => {
  assert.equal(isBetterReading(report({}), report({ warnings: 1 })), true);
  assert.equal(isBetterReading(report({}), report({ errors: 1 })), true);
});
