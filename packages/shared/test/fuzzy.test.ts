import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  foldForMatching,
  matchCompanyName,
  ocrAwareDistance,
  significantTokens,
  similarity,
} from '../dist/index.js';

test('folding removes accents, case and punctuation', () => {
  assert.equal(foldForMatching('AB Volvo (publ)'), 'ab volvo publ');
  assert.equal(foldForMatching('MJÖLK & BRÖD'), 'mjolk brod');
  assert.equal(foldForMatching('  Ikea   Svenska  AB '), 'ikea svenska ab');
});

test('significant tokens drop legal-form noise', () => {
  assert.deepEqual(significantTokens('AB Volvo (publ)'), ['volvo']);
  assert.deepEqual(significantTokens('Ikea Svenska Försäljnings AB'), [
    'ikea', 'svenska', 'forsaljnings',
  ]);
});

test('significant tokens never reduce a name to nothing', () => {
  assert.deepEqual(significantTokens('AB'), ['ab']);
});

test('OCR-confusable substitutions cost less than unrelated ones', () => {
  // K -> R is a classic Tesseract slip; K -> X is not.
  const confusable = ocrAwareDistance('ikea', 'irea');
  const unrelated = ocrAwareDistance('ikea', 'ixea');
  assert.ok(confusable < unrelated, `${confusable} should beat ${unrelated}`);
  assert.ok(confusable < 0.5);
});

test('similarity is 1 for identical strings and 0 for disjoint ones', () => {
  assert.equal(similarity('volvo', 'volvo'), 1);
  assert.ok(similarity('volvo', 'xyzzy') < 0.3);
});

test('matches a registered name against a shouted receipt header', () => {
  const result = matchCompanyName('AB Volvo (publ)', 'VOLVO\nGropegardsgatan 2\n405 08 Goteborg');
  assert.equal(result.confirmed, true);
  assert.ok(result.score > 0.9, `score was ${result.score}`);
  assert.deepEqual(result.matchedTokens, ['volvo']);
});

test('matches through the misspelling in the brief: IKEA read as IREA', () => {
  const result = matchCompanyName('Ikea Svenska Försäljnings AB', 'IREA SVENSKA\nKvitto');
  assert.equal(result.confirmed, true, `score was ${result.score}`);
});

test('matches through case and legal-suffix variation: "Ikea Ab"', () => {
  const result = matchCompanyName('IKEA Svenska Försäljnings AB', 'Ikea Ab, Kungens Kurva');
  assert.equal(result.confirmed, true, `score was ${result.score}`);
});

test('matches the real BAUHAUS receipt text', () => {
  const receipt = [
    'Gamla Nynasvagen 600',
    'S-142 51 Skogas',
    'ORG.NR: 969630-6944',
    'www.BAUHAUS.se',
  ].join('\n');
  const result = matchCompanyName('BAUHAUS & CO KB', receipt);
  assert.equal(result.confirmed, true, `score was ${result.score}`);
});

test('matches the real BILTEMA receipt text', () => {
  const receipt = 'BILTEMA SWEDEN AB/HANINGE 125\nORGANISATIONSNR: 556297-3320';
  const result = matchCompanyName('Biltema Sweden AB', receipt);
  assert.equal(result.confirmed, true, `score was ${result.score}`);
});

test('rejects a company that is simply not on the receipt', () => {
  const receipt = 'ICA KVANTUM EMPORIA\nMalmo\nMjolk 15,90';
  const result = matchCompanyName('Biltema Sweden AB', receipt);
  assert.equal(result.confirmed, false, `score was ${result.score}`);
  assert.ok(result.missingTokens.includes('biltema'));
});

test('a wholly missing name scores near zero rather than throwing', () => {
  assert.equal(matchCompanyName('', 'anything').score, 0);
  assert.equal(matchCompanyName('Volvo', '').score, 0);
});

test('reports which tokens were found and which were not', () => {
  const result = matchCompanyName('Clas Ohlson AB', 'CLAS OHLSON\nStockholm');
  assert.deepEqual(result.matchedTokens.sort(), ['clas', 'ohlson']);
  assert.deepEqual(result.missingTokens, []);
});
