import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeExtraction, validateExtraction } from '../dist/index.js';

test('normalizeExtraction coerces a messy model response', () => {
  const result = normalizeExtraction({
    merchant: { name: '  ICA Kvantum  ', orgnr: '5561234567', city: 'Malmö' },
    date: '15/3-24 14:22',
    total: '389,50 kr',
    items: [
      { name: 'Mjölk 3%', quantity: '2 st', totalPrice: '29,80' },
      { name: 'Äpple Royal Gala', quantity: '0,412 kg', unit: 'kg', totalPrice: '12,30', vatRate: '12 %' },
    ],
    vatLines: [{ rate: '12', net: '347,77', vat: '41,73' }],
  });

  assert.equal(result.merchant.name, 'ICA Kvantum');
  assert.equal(result.merchant.orgNumber, '556123-4567');
  assert.equal(result.merchant.city, 'Malmö');
  assert.equal(result.purchasedAt, '2024-03-15T14:22:00');
  assert.equal(result.currency, 'SEK');
  assert.equal(result.total, 389.5);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.quantity, 2);
  assert.equal(result.items[0]?.unitPrice, 14.9);
  assert.equal(result.items[1]?.unit, 'kg');
  assert.equal(result.items[1]?.vatRate, 12);
  assert.equal(result.vatLines[0]?.gross, 389.5);
});

test('normalizeExtraction recognises pant and discount lines', () => {
  const result = normalizeExtraction({
    merchant: { name: 'Coop' },
    total: 20,
    items: [
      { name: 'Läsk 33cl', totalPrice: '12,00' },
      { name: 'Pant burk', totalPrice: '2,00' },
      { name: 'Medlemsrabatt', totalPrice: '-4,00' },
      { name: 'Nedsatt vara', totalPrice: '-1,00' },
    ],
  });

  assert.equal(result.items[1]?.isDeposit, true);
  assert.equal(result.items[2]?.isDiscount, true);
  // A negative line with no discount wording is still a discount.
  assert.equal(result.items[3]?.isDiscount, true);
  assert.equal(result.depositTotal, 2);
});

test('normalizeExtraction derives a missing total from the VAT summary', () => {
  const result = normalizeExtraction({
    merchant: { name: 'Willys' },
    items: [{ name: 'Bröd', totalPrice: '25,00' }],
    vatLines: [{ rate: 12, gross: '100,00' }],
  });

  assert.equal(result.total, 100);
  assert.match(result.warnings.join(' '), /VAT summary/);
});

test('normalizeExtraction skips placeholder strings and priceless lines', () => {
  const result = normalizeExtraction({
    merchant: { name: 'N/A', city: 'okänd' },
    items: [{ name: 'Ingen prislapp' }, { name: 'Bröd', totalPrice: '25,00' }],
  });

  assert.equal(result.merchant.name, null);
  assert.equal(result.merchant.city, null);
  assert.equal(result.items.length, 1);
  assert.match(result.warnings.join(' '), /no readable price/);
});

test('normalizeExtraction never throws on garbage input', () => {
  const result = normalizeExtraction({ items: 'not an array', total: {}, merchant: 42 });
  assert.equal(result.items.length, 0);
  assert.equal(result.total, null);
  assert.equal(result.merchant.name, null);
});

test('validateExtraction flags a total that does not match the lines', () => {
  const extraction = normalizeExtraction({
    merchant: { name: 'Hemköp' },
    date: '2024-03-15',
    total: '500,00',
    items: [{ name: 'Bröd', totalPrice: '25,00' }],
  });
  const report = validateExtraction(extraction);

  assert.ok(report.issues.some((issue) => issue.code === 'total-mismatch'));
  assert.equal(report.itemsTotal, 25);
  assert.equal(report.discrepancy, 475);
  assert.equal(report.ok, false);
});

test('validateExtraction accepts a receipt that adds up, öresavrundning included', () => {
  const extraction = normalizeExtraction({
    merchant: { name: 'Hemköp' },
    date: '2024-03-15',
    total: '42,00',
    roundingAmount: '0,20',
    items: [
      { name: 'Bröd', totalPrice: '25,00' },
      { name: 'Mjölk', totalPrice: '16,80' },
    ],
  });
  const report = validateExtraction(extraction);

  assert.deepEqual(report.issues, []);
  assert.equal(report.ok, true);
});
