import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeOrgNumber,
  normalizeSearchName,
  normalizeVatNumber,
  parseAmount,
  parseLocalDateTime,
  parseQuantity,
  tokenizeQuery,
} from '../dist/index.js';

test('parseAmount reads Swedish money formats', () => {
  assert.equal(parseAmount('89,90'), 89.9);
  assert.equal(parseAmount('89,90 kr'), 89.9);
  assert.equal(parseAmount('1 234,50'), 1234.5);
  assert.equal(parseAmount('1 234,50 kr'), 1234.5);
  assert.equal(parseAmount('1.234,50'), 1234.5);
  assert.equal(parseAmount('12:-'), 12);
  assert.equal(parseAmount('0,00'), 0);
});

test('parseAmount reads English money formats', () => {
  assert.equal(parseAmount('1,234.50'), 1234.5);
  assert.equal(parseAmount('89.90'), 89.9);
  assert.equal(parseAmount(89.905), 89.91);
});

test('parseAmount handles the sign conventions cash registers print', () => {
  assert.equal(parseAmount('-25,00'), -25);
  assert.equal(parseAmount('25,00-'), -25);
  assert.equal(parseAmount('−25,00'), -25);
  assert.equal(parseAmount('(12,50)'), -12.5);
});

test('parseAmount treats a lone three-digit group as thousands', () => {
  assert.equal(parseAmount('1,234'), 1234);
  assert.equal(parseAmount('1.234'), 1234);
  assert.equal(parseAmount('1,234,567'), 1234567);
});

test('parseAmount rejects input without digits', () => {
  assert.equal(parseAmount('kr'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
});

test('parseQuantity splits amount and unit', () => {
  assert.deepEqual(parseQuantity('2 st'), { quantity: 2, unit: 'st' });
  assert.deepEqual(parseQuantity('0,412 kg'), { quantity: 0.412, unit: 'kg' });
  assert.deepEqual(parseQuantity('1,5 l'), { quantity: 1.5, unit: 'l' });
  assert.deepEqual(parseQuantity('3 frp'), { quantity: 3, unit: 'förp' });
  assert.deepEqual(parseQuantity(''), { quantity: 1, unit: 'st' });
  assert.deepEqual(parseQuantity(2), { quantity: 2, unit: 'st' });
});

test('parseLocalDateTime reads the formats Swedish receipts use', () => {
  assert.equal(parseLocalDateTime('2024-03-15'), '2024-03-15');
  assert.equal(parseLocalDateTime('2024-03-15 14:22'), '2024-03-15T14:22:00');
  assert.equal(parseLocalDateTime('2024-03-15T14:22:33'), '2024-03-15T14:22:33');
  assert.equal(parseLocalDateTime('15/3-24'), '2024-03-15');
  assert.equal(parseLocalDateTime('15.03.2024'), '2024-03-15');
  assert.equal(parseLocalDateTime('15 mars 2024'), '2024-03-15');
  assert.equal(parseLocalDateTime('240315'), '2024-03-15');
});

test('parseLocalDateTime rejects impossible dates', () => {
  assert.equal(parseLocalDateTime('2024-02-31'), null);
  assert.equal(parseLocalDateTime('inget datum'), null);
  assert.equal(parseLocalDateTime(''), null);
});

test('parseLocalDateTime keeps wall-clock time rather than converting to UTC', () => {
  // A 23:50 purchase must stay on the same calendar day whatever the host timezone.
  assert.equal(parseLocalDateTime('2024-06-30 23:50'), '2024-06-30T23:50:00');
});

test('normalizeOrgNumber formats Swedish organisationsnummer', () => {
  assert.equal(normalizeOrgNumber('5561234567'), '556123-4567');
  assert.equal(normalizeOrgNumber('556123-4567'), '556123-4567');
  assert.equal(normalizeOrgNumber('165561234567'), '556123-4567');
  assert.equal(normalizeOrgNumber('12345'), null);
});

test('normalizeVatNumber pads a bare org number to a VAT number', () => {
  assert.equal(normalizeVatNumber('SE556123456701'), 'SE556123456701');
  assert.equal(normalizeVatNumber('5561234567'), 'SE556123456701');
  assert.equal(normalizeVatNumber('abc'), null);
});

test('normalizeSearchName keeps Swedish letters and drops punctuation', () => {
  assert.equal(normalizeSearchName('ÄPPLE Röd, 1kg'), 'äpple röd 1kg');
  assert.equal(normalizeSearchName('  Mjölk 3%  '), 'mjölk 3');
});

test('tokenizeQuery honours quoted phrases', () => {
  assert.deepEqual(tokenizeQuery('mjölk "röda äpplen"'), ['mjölk', 'röda äpplen']);
  assert.deepEqual(tokenizeQuery('   '), []);
});
