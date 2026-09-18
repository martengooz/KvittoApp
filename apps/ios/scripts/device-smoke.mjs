#!/usr/bin/env node
/**
 * Smoke check on a physical device.
 *
 * `scripts/smoke.mjs` drives a simulator, where `simctl` can open deep links
 * and stream the unified log. Neither is available for a real device:
 * `devicectl` installs, launches, screenshots, and nothing else - it cannot
 * open a URL and it cannot tap. Everything past the first screen was therefore
 * unverifiable on the hardware the app actually ships to.
 *
 * Two things close that gap, and this script is the pair of them:
 *
 * 1. The app drives itself through a route list handed to it in its launch
 *    environment (`KVITTO_ROUTES`; see `src/app/route-driver.ts`). Nothing can
 *    set that on an App Store launch, so the path is unreachable in the field.
 * 2. Diagnostics are mirrored to stderr, which `devicectl --console` does
 *    stream, so boot and route markers are readable from here.
 *
 * What this does *not* do, and the simulator check does: sample-data seeding
 * is simulator-only by design, so the populated routes are only as populated
 * as the device's own database. And there is no CPU check - `ps` cannot reach
 * a process on a device.
 *
 * Usage:
 *   node apps/ios/scripts/device-smoke.mjs --app <path to .app> --device <udid>
 *     [--dwell <ms>] [--screenshot <path>]
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const run = promisify(execFile);

const BUNDLE_ID = 'com.kvitto.app.ios';

const BOOT_READY = 'boot:ready';
const BOOT_FAILED = 'boot:failed';
const RENDER_FAILED = 'render:failed';
const ROUTES_STARTED = 'routes:started';
const ROUTES_VISITING = 'routes:visiting';
const ROUTES_FINISHED = 'routes:finished';
const ROUTES_FAILED = 'routes:failed';

/**
 * Routes the check drives, in order.
 *
 * Receipt routes use an id that does not exist, which exercises the real
 * not-found path. Unlike the simulator check there is no seeding step - a real
 * device never gets sample data, deliberately, so it must not be given any.
 */
const ROUTES = [
  '/',
  '/purchases',
  '/scan',
  '/collections',
  '/settings',
  '/receipt/smoke-missing-id',
  '/receipt/smoke-missing-id/extraction',
  '/receipt/smoke-missing-id/ocr',
  '/receipt/smoke-missing-id/edit',
  '/filters',
  '/categories',
  '/tags',
  '/debug/log',
  '/archive/export',
  '/archive/preflight',
  '/archive/result',
  '/pairing/scanner',
  '/',
];

const BOOT_TIMEOUT_MS = 120_000;
const DEFAULT_DWELL_MS = 1_200;

function parseArgs(argv) {
  const args = { device: null, app: null, dwell: DEFAULT_DWELL_MS, screenshot: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--device') args.device = argv[index + 1];
    if (argv[index] === '--app') args.app = argv[index + 1];
    if (argv[index] === '--dwell') args.dwell = Number(argv[index + 1]);
    if (argv[index] === '--screenshot') args.screenshot = argv[index + 1];
  }
  return args;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(log, message) {
  console.error(`\nSMOKE FAILED: ${message}\n`);
  if (log.trim().length > 0) {
    console.error('--- device console ---');
    console.error(log.slice(-20_000));
  }
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.app || !existsSync(args.app)) {
    fail('', `--app must point at a built .app (got ${args.app ?? 'nothing'})`);
  }
  if (!args.device) {
    fail('', '--device must be a physical device UDID; run `xcrun devicectl list devices`');
  }

  console.log(`Device smoke check: ${args.app}\n            on ${args.device}`);

  await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', args.device, args.app]);

  // The route list and dwell reach the app as environment variables, which is
  // the only channel `devicectl` offers into a signed Release build.
  const child = spawn(
    'xcrun',
    [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      args.device,
      '--console',
      '--terminate-existing',
      '--environment-variables',
      JSON.stringify({
        KVITTO_ROUTES: ROUTES.join(','),
        KVITTO_ROUTE_DWELL_MS: String(args.dwell),
      }),
      BUNDLE_ID,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let log = '';
  let exited = false;
  const collect = (chunk) => {
    log += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => {
    exited = true;
  });

  const startedAt = Date.now();
  while (!log.includes(BOOT_READY)) {
    if (log.includes(BOOT_FAILED)) {
      child.kill();
      fail(log, 'the app reported boot:failed');
    }
    // A device that refused the launch says so at once. Waiting out the boot
    // timeout for an answer already in hand wastes two minutes and reports the
    // wrong problem - "did not boot" rather than "was never started".
    // Both spellings mean the same thing in practice: the phone is locked, or
    // was when the launch was requested. The second is what a launch issued
    // moments after the screen went off reports, and its text names neither
    // the lock nor the app - it took a misreported run to work that out.
    if (log.includes('could not be, unlocked') || log.includes('failed preflight checks')) {
      child.kill();
      fail('', 'the device is locked; unlock it and run this again');
    }
    if (exited) {
      fail(log, 'devicectl exited before the app reported boot:ready');
    }
    if (Date.now() - startedAt > BOOT_TIMEOUT_MS) {
      child.kill();
      fail(log, `the app did not reach ${BOOT_READY} within ${BOOT_TIMEOUT_MS}ms`);
    }
    await delay(500);
  }
  console.log(`  ${BOOT_READY}`);

  const routeBudgetMs = ROUTES.length * (args.dwell + 1_500) + 15_000;
  const routesStartedAt = Date.now();
  while (!log.includes(ROUTES_FINISHED)) {
    if (Date.now() - routesStartedAt > routeBudgetMs) {
      child.kill();
      // The last `routes:visiting` line names the route that did not come back,
      // which is the whole reason routes are announced before they are opened.
      const lastVisited = [...log.matchAll(new RegExp(`${ROUTES_VISITING} (\\S+)`, 'g'))].at(-1);
      fail(
        log,
        `route walk did not finish within ${routeBudgetMs}ms; last route opened was ` +
          `${lastVisited ? lastVisited[1] : 'none - the walk never started'}`,
      );
    }
    if (!log.includes(ROUTES_STARTED) && Date.now() - routesStartedAt > 20_000) {
      child.kill();
      fail(
        log,
        `the app booted but never reported ${ROUTES_STARTED}; the route list did not reach it. ` +
          'Check that this build includes the launch route driver.',
      );
    }
    await delay(500);
  }

  for (const match of log.matchAll(new RegExp(`${ROUTES_VISITING} (\\S+)`, 'g'))) {
    console.log(`  ${match[1]} ok`);
  }

  if (args.screenshot) {
    // Wrapped: every route passed by this point, and a screenshot is a
    // convenience. Failing the run over it would report the wrong thing.
    //
    // Note the shape: `devicectl device capture screenshot`, with the path as
    // a named `--destination` rather than a positional argument.
    try {
      await run('xcrun', [
        'devicectl',
        'device',
        'capture',
        'screenshot',
        '--device',
        args.device,
        '--destination',
        args.screenshot,
      ]);
      console.log(`  screenshot -> ${args.screenshot}`);
    } catch (error) {
      console.warn(`  screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  child.kill();

  if (log.includes(RENDER_FAILED)) {
    fail(log, 'a screen tripped the router error boundary (render:failed)');
  }
  if (log.includes(ROUTES_FAILED)) {
    fail(log, 'at least one route could not be opened');
  }

  const finished = log.match(new RegExp(`${ROUTES_FINISHED} (\\d+)/(\\d+)`));
  if (!finished) {
    fail(log, `could not read the ${ROUTES_FINISHED} count from the device console`);
  }
  if (finished[1] !== finished[2]) {
    fail(log, `only ${finished[1]} of ${finished[2]} routes were reached`);
  }

  console.log(`\nDEVICE SMOKE PASSED (${finished[2]} routes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
