import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { ROUTE_DRIVER_MARKERS } from '../src/app/route-driver';
import { PUSHED_MODAL_ROUTE_CONTRACTS } from '../src/app/routes';

const script = readFileSync(join(__dirname, '..', 'scripts', 'device-smoke.mjs'), 'utf8');

function drivenRoutes(): string[] {
  const block = /const ROUTES = \[([\s\S]*?)\];/.exec(script);
  expect(block).not.toBeNull();
  return [...block![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe('the device smoke check and the app agree', () => {
  test('every pushed route is driven on the device', () => {
    // The device check is the only thing that opens these screens on real
    // hardware. A route added to the contract and not here is one that has
    // never rendered on a device - which is exactly the gap this check exists
    // to close, so it must not reopen quietly.
    const driven = new Set(drivenRoutes());

    for (const contract of PUSHED_MODAL_ROUTE_CONTRACTS) {
      const concrete = contract.route.replace('[receiptId]', 'smoke-missing-id');
      expect(driven.has(`/${concrete}`)).toBe(true);
    }
  });

  test('it drives the five tabs as well as the pushed routes', () => {
    const driven = new Set(drivenRoutes());
    for (const tab of ['/', '/purchases', '/scan', '/collections', '/settings']) {
      expect(driven.has(tab)).toBe(true);
    }
  });

  test('the markers it waits for are the ones the driver logs', () => {
    // These are matched out of a log by string, so a rename on either side
    // turns the check into one that waits forever and then reports the wrong
    // reason.
    for (const [name, marker] of Object.entries(ROUTE_DRIVER_MARKERS)) {
      expect(script).toContain(`'${marker}'`);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test('it does not try to seed sample data on a real device', () => {
    // Seeding is gated on `isSimulator()` and must stay that way: a person's
    // own receipts are not somewhere to write six fake ones.
    expect(script).not.toContain('seed=1');
  });
});
