import { describe, expect, test } from '@jest/globals';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { PUSHED_MODAL_ROUTE_CONTRACTS } from '../src/app/routes';
import { TAB_FEATURE_SERVICE_KEYS } from '../src/app/services';

const EXPECTED_ROUTES = [
  'receipt/[receiptId]',
  'receipt/[receiptId]/edit',
  'receipt/[receiptId]/ocr',
  'receipt/[receiptId]/extraction',
  'filters',
  'categories',
  'tags',
  'pairing/scanner',
  'debug/log',
  'archive/preflight',
  'archive/result',
] as const;

describe('integration route/controller contracts', () => {
  test('defines pushed and modal route contracts for feature-owned flows', () => {
    const actualRoutes = PUSHED_MODAL_ROUTE_CONTRACTS.map((entry) => entry.route);
    expect(actualRoutes).toEqual(EXPECTED_ROUTES);
    expect(new Set(actualRoutes).size).toBe(actualRoutes.length);
  });

  test('binds every route contract to a known tab composition service key', () => {
    const controllerToService = {
      receipts: 'receipts',
      scan: 'scan',
      settings: 'settings',
    } as const;

    for (const contract of PUSHED_MODAL_ROUTE_CONTRACTS) {
      const serviceKey = controllerToService[contract.controller];
      expect(TAB_FEATURE_SERVICE_KEYS).toContain(serviceKey);
      expect(contract.title.length).toBeGreaterThan(0);
    }
  });

  test('has a concrete route file for every declared contract', () => {
    for (const contract of PUSHED_MODAL_ROUTE_CONTRACTS) {
      const routeFile = path.resolve(__dirname, '..', 'app', `${contract.route}.tsx`);
      expect(existsSync(routeFile)).toBe(true);
    }
  });
});
