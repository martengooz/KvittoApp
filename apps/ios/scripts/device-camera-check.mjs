#!/usr/bin/env node
/**
 * Watches the live frame detector on a physical device.
 *
 * The camera cannot be checked any other way. A simulator has no camera, so
 * `onFrame` never runs there; on a device the preview looks identical whether
 * the detector is working, inert, or stalled, and a Release build has no
 * `console`. So the preview logs what it is seeing once a second, this parks
 * the app on the scan screen, and the readings come back over
 * `devicectl --console`.
 *
 * Point the camera at a receipt while it runs. It reports the best evidence
 * score it saw and whether that would have armed auto-capture, which needs
 * 0.35 (`MIN_EVIDENCE` in `src/features/scan/controller.ts`).
 *
 * Usage:
 *   node apps/ios/scripts/device-camera-check.mjs --app <path> --device <udid>
 *     [--seconds 30] [--screenshot <path>]
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const run = promisify(execFile);

const BUNDLE_ID = 'com.kvitto.app.ios';
const BOOT_READY = 'boot:ready';

/** Must match `MIN_EVIDENCE` in `src/features/scan/controller.ts`. */
const MIN_EVIDENCE = 0.35;

function parseArgs(argv) {
  const args = { device: null, app: null, seconds: 30, screenshot: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--device') args.device = argv[index + 1];
    if (argv[index] === '--app') args.app = argv[index + 1];
    if (argv[index] === '--seconds') args.seconds = Number(argv[index + 1]);
    if (argv[index] === '--screenshot') args.screenshot = argv[index + 1];
  }
  return args;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(log, message) {
  console.error(`\nCAMERA CHECK FAILED: ${message}\n`);
  if (log.trim().length > 0) {
    console.error('--- device console ---');
    console.error(log.slice(-8_000));
  }
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.app || !existsSync(args.app)) fail('', `--app must point at a built .app`);
  if (!args.device) fail('', '--device must be a physical device UDID');

  console.log(`Camera check on ${args.device} for ${args.seconds}s.`);
  console.log('Point the camera at a receipt now.\n');

  await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', args.device, args.app]);

  const child = spawn(
    'xcrun',
    [
      'devicectl', 'device', 'process', 'launch',
      '--device', args.device,
      '--console', '--terminate-existing',
      '--environment-variables',
      // One route, held for the whole session: the scan screen, so the preview
      // stays mounted and frames keep arriving.
      JSON.stringify({
        KVITTO_ROUTES: '/scan',
        KVITTO_ROUTE_DWELL_MS: String(args.seconds * 1000),
      }),
      BUNDLE_ID,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let log = '';
  const collect = (chunk) => {
    log += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const startedAt = Date.now();
  while (!log.includes(BOOT_READY)) {
    // Both spellings mean the same thing in practice: the phone is locked, or
    // was when the launch was requested. The second is what a launch issued
    // moments after the screen went off reports, and its text names neither
    // the lock nor the app - it took a misreported run to work that out.
    if (log.includes('could not be, unlocked') || log.includes('failed preflight checks')) {
      child.kill();
      fail('', 'the device is locked; unlock it and run this again');
    }
    if (Date.now() - startedAt > 120_000) {
      child.kill();
      fail(log, 'the app never booted');
    }
    await delay(500);
  }
  console.log(`  ${BOOT_READY}`);

  const deadline = Date.now() + args.seconds * 1000 + 8_000;
  let printed = 0;
  while (Date.now() < deadline) {
    const readings = [...log.matchAll(/frames:reading (.+)/g)];
    for (const reading of readings.slice(printed)) {
      console.log(`  ${reading[1].trim()}`);
    }
    printed = readings.length;
    await delay(1_000);
  }

  if (args.screenshot) {
    try {
      await run('xcrun', [
        'devicectl', 'device', 'capture', 'screenshot',
        '--device', args.device, '--destination', args.screenshot,
      ]);
      console.log(`  screenshot -> ${args.screenshot}`);
    } catch (error) {
      console.warn(`  screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  child.kill();

  const analyzer = log.match(/frames:analyzer (.+)/);
  if (!analyzer) {
    fail(log, 'the preview never reported whether it had a detector; it probably never mounted');
  }
  if (analyzer[1].trim().startsWith('unavailable')) {
    fail(log, 'the detector could not be created - the kvitto-frames pod is not linked into this build');
  }

  const readings = [...log.matchAll(/frames:reading (.+)/g)].map((match) => match[1].trim());
  if (readings.length === 0) {
    fail(log, 'the detector was created but produced no readings at all');
  }

  const scores = readings
    .map((line) => /evidence=([\d.]+)/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]));

  if (scores.length === 0) {
    // Every reading said `none`: the analyzer exists and is being polled, but
    // `onFrame` never ran. Camera permission is the usual reason.
    fail(
      log,
      'the detector never saw a frame. Grant camera access on the device and run this again',
    );
  }

  const best = Math.max(...scores);
  const ready = readings.filter((line) => line.startsWith('ready')).length;
  const skipped = [...log.matchAll(/skipped=(\d+)/g)].map((match) => Number(match[1]));

  console.log(`\n  readings:    ${readings.length}`);
  console.log(`  with a quad: ${ready}`);
  console.log(`  best score:  ${best.toFixed(3)} (auto-capture needs ${MIN_EVIDENCE})`);
  if (skipped.length > 0) {
    console.log(`  frames skipped by the interval gate: ${skipped.at(-1)}`);
  }

  if (best >= MIN_EVIDENCE) {
    console.log('\nCAMERA CHECK PASSED: the detector cleared the auto-capture threshold.');
  } else {
    // Not a failure. The camera may simply not have been pointed at anything.
    console.log(
      '\nCAMERA CHECK INCONCLUSIVE: frames arrived and the detector ran, but nothing\n' +
        'in view scored high enough to arm auto-capture. Point it squarely at a\n' +
        'receipt on a contrasting surface and run it again.',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
