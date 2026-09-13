import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkOrgNumber,
  findOrgNumbers,
  isValidOrgNumber,
  luhnCheckDigit,
  luhnValid,
  toTenDigits,
} from '../dist/index.js';

test('luhn accepts real organisation numbers', () => {
  // AB Volvo (confirmed against the registry API), plus the two printed on the
  // BAUHAUS and BILTEMA receipts in fixtures/.
  assert.equal(luhnValid('5560125790'), true);
  assert.equal(luhnValid('9696306944'), true);
  assert.equal(luhnValid('5562973320'), true);
});

test('luhn rejects a single-digit corruption', () => {
  assert.equal(luhnValid('5560125791'), false);
  assert.equal(luhnValid('5560125700'), false);
});

test('luhnCheckDigit recovers the final digit', () => {
  assert.equal(luhnCheckDigit('556012579'), 0);
  assert.equal(luhnCheckDigit('55616050'), null, 'wrong length');
});

test('toTenDigits strips formatting and the 16 century prefix', () => {
  assert.equal(toTenDigits('556012-5790'), '5560125790');
  assert.equal(toTenDigits('165560125790'), '5560125790');
  assert.equal(toTenDigits('5560125790'), '5560125790');
  assert.equal(toTenDigits('12345'), null);
});

test('checkOrgNumber validates all three structural rules', () => {
  const ok = checkOrgNumber('556012-5790');
  assert.equal(ok.valid, true);
  assert.equal(ok.formatted, '556012-5790');
  assert.equal(ok.legalForm, 'Aktiebolag');
});

test('checkOrgNumber rejects a personnummer', () => {
  // Digits 3-4 are "05", i.e. below 20, so this is a birth date not an org.
  const result = checkOrgNumber('8505151234');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'not-an-org-number');
});

test('checkOrgNumber rejects an impossible group digit', () => {
  const result = checkOrgNumber('0560125790');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'group-digit');
});

test('checkOrgNumber reports a checksum failure distinctly', () => {
  const result = checkOrgNumber('5560125791');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'checksum');
});

test('group digit maps to the legal form', () => {
  assert.equal(checkOrgNumber('969630-6944').legalForm, 'Handelsbolag eller kommanditbolag');
  assert.equal(checkOrgNumber('556012-5790').legalForm, 'Aktiebolag');
});

test('findOrgNumbers pulls a labelled number out of receipt text', () => {
  const text = [
    'BAUHAUS & CO KB',
    'Gamla Nynasvagen 600',
    'S-142 51 Skogas',
    'ORG.NR: 969630-6944',
    '2 GRALUMPPAPP    198,00',
  ].join('\n');

  const found = findOrgNumbers(text);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.formatted, '969630-6944');
  assert.equal(found[0]?.labelled, true);
  assert.ok((found[0]?.confidence ?? 0) > 0.9, 'a labelled valid number scores high');
});

test('findOrgNumbers ignores phone numbers and card digits', () => {
  const text = [
    'TELEFONNUMMER: 077-520 00 00',
    'VISA Contactless  ************8618-0',
    'TERM: 14314539-352298/ 30559082',
    'Kvittonr: 151322',
  ].join('\n');

  // None of these satisfy group digit + month>=20 + Luhn simultaneously.
  for (const candidate of findOrgNumbers(text)) {
    assert.fail(`unexpected match: ${candidate.formatted} from "${candidate.raw}"`);
  }
});

test('findOrgNumbers repairs a single OCR digit confusion', () => {
  // The leading 5 came back as an S.
  const text = 'Org.nr S56012-5790';
  const found = findOrgNumbers(text);
  assert.equal(found[0]?.formatted, '556012-5790');
  assert.equal(found[0]?.repaired, true);
  assert.ok((found[0]?.confidence ?? 1) < 0.9, 'a repaired number is trusted less');
});

test('findOrgNumbers will not invent a number from two corruptions', () => {
  // Two characters wrong: repairing both would be guessing, not reading.
  assert.deepEqual(findOrgNumbers('Org.nr SS6012-5790'), []);
});

test('findOrgNumbers accepts the 12-digit form', () => {
  const found = findOrgNumbers('Momsreg.nr 165560125790');
  assert.equal(found[0]?.formatted, '556012-5790');
});

test('findOrgNumbers ranks a labelled number above a bare one', () => {
  const text = 'Kundnr 556297-3320 ... ORG NR 556012-5790';
  const found = findOrgNumbers(text);
  assert.equal(found.length, 2);
  assert.equal(found[0]?.formatted, '556012-5790', 'the labelled one wins');
  assert.equal(found[0]?.labelled, true);
  assert.equal(found[1]?.labelled, false);
});

test('isValidOrgNumber is a thin boolean wrapper', () => {
  assert.equal(isValidOrgNumber('556012-5790'), true);
  assert.equal(isValidOrgNumber('123'), false);
});

test('a common legal form outranks a rare one when both pass every check', () => {
  // 5562973320 (aktiebolag) and 3062973320 (foreign trader) both satisfy Luhn
  // and every structural rule; only the leading digit differs, which is exactly
  // what a misread costs. The common form must be the one that wins.
  const common = findOrgNumbers('5562973320');
  const rare = findOrgNumbers('3062973320');

  assert.equal(common[0]?.digits, '5562973320');
  assert.equal(rare[0]?.digits, '3062973320');
  assert.ok(
    common[0]!.confidence > rare[0]!.confidence,
    `expected the aktiebolag to score higher: ${common[0]!.confidence} vs ${rare[0]!.confidence}`,
  );
});
