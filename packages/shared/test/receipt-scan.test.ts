import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanReceiptText } from '../dist/index.js';

/** Transcribed from fixtures/receipts/IMG_2403.jpeg (BAUHAUS). */
const BAUHAUS = [
  'Gamla Nynasvagen 600',
  'S-142 51 Skogas',
  'ORG.NR: 969630-6944',
  '',
  '2 GRALUMPPAPP',
  'A 99,00              198,00',
  '1 SPANPLATTESKRUV     69,95',
  '1 STICKSAGB.T101 BIF 159,00',
  '',
  'TOTAL               426,95',
  'Bankkort            426,95',
  '',
  'Moms%    Moms      Brutto',
  '25%      85,39     426,95',
  '',
  'Betjanad av: Sjalvscanning',
  '26 07 26  12:53',
  '',
  'Villkor/garantier',
  'www.BAUHAUS.se',
].join('\n');

/** Transcribed from fixtures/receipts/IMG_1930.jpeg (BILTEMA). */
const BILTEMA = [
  'BILTEMA',
  'BILTEMA SWEDEN AB/HANINGE 125',
  'ORGANISATIONSNR: 556297-3320',
  'OPPETTIDER: MAN-FRE 7-20 LOR-SON 9-18',
  'TELEFONNUMMER: 077-520 00 00',
  '',
  '48109 ARBETSLAMPA/FICKLAMPA.340/70LM',
  '  1 * 199.00            199.00',
  '',
  'Totalt (SEK):          2231.60',
  'Kort:                  2231.60',
  'MS Handelsban SE',
  'TERM: 14314539-352298/ 30559082',
  '2026-05-23 11:13        PERIOD:131',
  'VISA Contactless   ***********8618-0',
  'AID: A0000000031010',
  'Kvittonr: 151322       Term.nr: 0202',
  'Datum: 23.05.2026      Tid: 11:13:46',
].join('\n');

const TODAY = new Date('2026-09-13T12:00:00Z');

test('finds the organisation number on the BAUHAUS receipt', () => {
  const found = scanReceiptText(BAUHAUS, { today: TODAY });
  assert.equal(found.orgNumber?.formatted, '969630-6944');
  assert.equal(found.orgNumber?.labelled, true);
  assert.equal(found.orgNumber?.legalForm, 'Handelsbolag eller kommanditbolag');
});

test('finds the organisation number on the BILTEMA receipt', () => {
  const found = scanReceiptText(BILTEMA, { today: TODAY });
  assert.equal(found.orgNumber?.formatted, '556297-3320');
  assert.equal(found.orgNumber?.legalForm, 'Aktiebolag');
});

test('does not mistake the phone number or terminal id for an org number', () => {
  const found = scanReceiptText(BILTEMA, { today: TODAY });
  assert.equal(found.orgNumbers.length, 1, JSON.stringify(found.orgNumbers.map((o) => o.raw)));
});

test('finds the purchase date on the BILTEMA receipt', () => {
  const found = scanReceiptText(BILTEMA, { today: TODAY });
  assert.equal(found.purchasedAt?.value.slice(0, 10), '2026-05-23');
});

test('prefers a dated line with a time over a bare date', () => {
  const text = 'Giltig 2026-12-31\nDatum: 2026-05-23 11:13';
  const found = scanReceiptText(text, { today: TODAY });
  assert.equal(found.purchasedAt?.value, '2026-05-23T11:13:00');
});

test('ignores a best-before date', () => {
  const text = 'Bast fore 2027-01-15\nDatum 2026-05-23';
  const found = scanReceiptText(text, { today: TODAY });
  assert.equal(found.purchasedAt?.value.slice(0, 10), '2026-05-23');
  assert.ok(
    !found.dates.some((d) => d.value.startsWith('2027-01-15')),
    'the best-before date is excluded entirely',
  );
});

test('scores a future date below a past one', () => {
  const text = 'Kort giltigt 2029-04-01\n2026-05-23 11:13';
  const found = scanReceiptText(text, { today: TODAY });
  assert.equal(found.purchasedAt?.value.slice(0, 10), '2026-05-23');
});

test('returns nulls rather than throwing on text with nothing in it', () => {
  const found = scanReceiptText('inget av intresse här', { today: TODAY });
  assert.equal(found.orgNumber, null);
  assert.equal(found.purchasedAt, null);
  assert.deepEqual(found.orgNumbers, []);
});

test('survives empty input', () => {
  const found = scanReceiptText('', { today: TODAY });
  assert.equal(found.orgNumber, null);
  assert.equal(found.purchasedAt, null);
});
