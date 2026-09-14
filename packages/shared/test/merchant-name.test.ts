import assert from 'node:assert/strict';
import { test } from 'node:test';

import { looksSearchable, merchantNameCandidates } from '../dist/index.js';

/** Queries offered for a registry search, best first. */
function searchable(text: string): string[] {
  return merchantNameCandidates(text)
    .filter((candidate) => candidate.searchable)
    .map((candidate) => candidate.query);
}

test('the shop name at the top of a receipt is the first candidate', () => {
  const text = [
    'BILTEMA',
    'BILTEMA SWEDEN AB',
    'Hangövägen 25',
    '115 41 STOCKHOLM',
    'Org.nr 556297-3320',
  ].join('\n');

  assert.equal(searchable(text)[0], 'BILTEMA');
});

test('the footer web address rescues a logo the OCR mangled', () => {
  // Exactly what the BAUHAUS fixtures produce: the wordmark comes back as
  // noise, and the plain-text URL in the footer reads perfectly.
  const text = [
    'AO0UHANE',
    'Gamla Nynäsvägen 600',
    'S-142 51 Skogås',
    'ORG.NR: 969630-6944',
    'SURFORM HOBBYBL             69,95',
    'www . BAUHAUS. se',
  ].join('\n');

  const queries = searchable(text);
  assert.ok(queries.includes('BAUHAUS'), `expected BAUHAUS among ${JSON.stringify(queries)}`);
  assert.ok(!queries.includes('AO0UHANE'), 'a digit inside a word marks OCR noise');
});

test('a long domain label is also offered without its trailing noun', () => {
  const text = 'Scandic Continental\nwww.scandichotels.com';
  const queries = searchable(text);
  assert.ok(queries.includes('scandichotels'));
  // The registry matches on substrings of the real name, and
  // `Scandic Hotels AB` does not contain `scandichotels`.
  assert.ok(queries.includes('scandic'));
});

test('addresses, phone numbers and registry lines are not names', () => {
  const text = [
    '115 41 STOCKHOLM',
    'Gamla Nynäsvägen 600',
    'S-142 51 Skogås',
    'Tel 08-123 45 67',
    'Org.nr 556297-3320',
    'www.example.se',
    'KVITTO 12345',
  ].join('\n');

  for (const query of searchable(text)) {
    assert.ok(
      !/stockholm|nynäsvägen|skogås|08-|556297|kvitto/i.test(query),
      `"${query}" should not have been offered`,
    );
  }
});

test('a priced line is a product, not a shop', () => {
  const text = 'CASCO HUSFIX RAPID        579,00\nFRESH KÖKS/VENTILAT       249,00';
  assert.deepEqual(searchable(text), []);
});

test('legal-form suffixes are dropped from the query but not the display text', () => {
  const [first] = merchantNameCandidates('Clas Ohlson AB\nInsjön');
  assert.equal(first?.text, 'Clas Ohlson AB');
  assert.equal(first?.query, 'Clas Ohlson');
});

test('a name repeated across the receipt survives an unreadable header', () => {
  const text = ['~~ ###', 'Delsumma 100,00', 'Willys Hemma', 'Tack för besöket', 'Willys Hemma'].join('\n');
  assert.ok(searchable(text).some((query) => /willys/i.test(query)));
});

test('OCR noise is rejected before it can spend a search', () => {
  for (const noise of ['AO0UHANE', 'iLLV S', 'tkas5e', 'BCDFGHJ', 'aeiouae']) {
    assert.equal(looksSearchable(noise), false, `${noise} should not be searchable`);
  }
  for (const real of ['BAUHAUS', 'Clas Ohlson', 'Elgiganten', 'ICA Kvantum', 'Systembolaget']) {
    assert.equal(looksSearchable(real), true, `${real} should be searchable`);
  }
});
