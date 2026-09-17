#!/usr/bin/env node
/**
 * Device smoke check.
 *
 * The Jest suite passed green twice while the app could not start at all, so
 * this installs the built app on a simulator, launches it, and asserts against
 * the unified log that it actually booted, that visiting every tab produces no
 * JavaScript exception, that no screen trips the render error boundary, and that
 * the app is not burning CPU while idle.
 *
 * Usage:
 *   node apps/ios/scripts/smoke.mjs --app <path to .app> [--device <name or udid>]
 *
 * Exits non-zero, with the captured log, on any failure.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const run = promisify(execFile);

const BUNDLE_ID = 'com.kvitto.app.ios';
const BOOT_READY = 'boot:ready';
const BOOT_FAILED = 'boot:failed';
const RENDER_FAILED = 'render:failed';
const JS_ERROR_PREDICATE = 'facebook.react.log:javascript';

/** Routes the check visits, as `<scheme>:///<path>`. */
const ROUTES = ['/', '/purchases', '/scan', '/collections', '/settings'];
const SCHEME = 'kvittoapp';

const BOOT_TIMEOUT_MS = 90_000;
const ROUTE_SETTLE_MS = 3_000;

/**
 * A runaway render loop throws nothing and keeps the process alive, so an
 * exception check cannot see it. It does peg a core, so an idle app that is
 * still burning CPU is treated as a failure.
 */
const IDLE_CPU_LIMIT_PERCENT = 40;
const CPU_WINDOW_MS = 3_000;

function parseArgs(argv) {
  const args = { device: 'iPhone 17 Pro', app: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--app') args.app = argv[index + 1];
    if (argv[index] === '--device') args.device = argv[index + 1];
  }
  return args;
}

function fail(message, log) {
  console.error(`\nSMOKE FAILED: ${message}\n`);
  if (log && log.trim().length > 0) {
    console.error('--- captured device log (last 60 lines) ---');
    console.error(log.trim().split('\n').slice(-60).join('\n'));
  }
  process.exit(1);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simctl(args) {
  return run('xcrun', ['simctl', ...args], { maxBuffer: 32 * 1024 * 1024 });
}

/** Process id of the app on the simulator, or null when it is not running. */
async function appPid(device) {
  const { stdout } = await run('bash', [
    '-lc',
    `xcrun simctl spawn ${JSON.stringify(device)} launchctl list | grep ${BUNDLE_ID} || true`,
  ]).catch(() => ({ stdout: '' }));
  const pid = Number.parseInt(String(stdout).trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** Cumulative CPU seconds consumed by a process, from `ps -o time=` (`mm:ss.ss`). */
async function cpuSeconds(pid) {
  const { stdout } = await run('ps', ['-o', 'time=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
  const raw = String(stdout).trim();
  if (!raw) return null;
  const parts = raw.split(/[:]/).map((part) => Number.parseFloat(part));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Percentage of one core the app used over `windowMs`.
 *
 * Measured as a delta of cumulative CPU time, not `ps %cpu`, which on macOS is
 * an average over the whole process lifetime and so hides a loop that started
 * seconds ago.
 */
async function cpuUtilisation(device, windowMs) {
  const pid = await appPid(device);
  if (pid === null) return null;

  const first = await cpuSeconds(pid);
  if (first === null) return null;

  const startedAt = Date.now();
  await delay(windowMs);

  const second = await cpuSeconds(pid);
  if (second === null) return null;

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  if (elapsedSeconds <= 0) return null;
  return ((second - first) / elapsedSeconds) * 100;
}

async function main() {
  const { app, device } = parseArgs(process.argv.slice(2));

  if (!app) fail('Pass --app <path to the built .app bundle>.');
  if (!existsSync(app)) fail(`No app bundle at ${app}.`);

  console.log(`Smoke check: ${app}\n            on ${device}`);

  await simctl(['boot', device]).catch(() => {
    // Already booted is the common case and not an error.
  });
  await simctl(['bootstatus', device, '-b']);

  // A stale install would hide a packaging regression.
  await simctl(['uninstall', device, BUNDLE_ID]).catch(() => {});
  await simctl(['install', device, app]);

  let log = '';
  const stream = spawn('xcrun', [
    'simctl',
    'spawn',
    device,
    'log',
    'stream',
    '--style',
    'compact',
    '--predicate',
    'processImagePath CONTAINS "KvittoAppiOS"',
  ]);
  stream.stdout.on('data', (chunk) => {
    log += String(chunk);
  });
  stream.stderr.on('data', (chunk) => {
    log += String(chunk);
  });

  const stopStream = () => {
    stream.kill('SIGTERM');
  };

  try {
    await delay(1_500);
    await simctl(['launch', device, BUNDLE_ID]);

    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let booted = false;
    while (Date.now() < deadline) {
      if (log.includes(BOOT_FAILED)) {
        const line = log.split('\n').find((entry) => entry.includes(BOOT_FAILED)) ?? BOOT_FAILED;
        stopStream();
        fail(`The app reported a boot failure: ${line.trim()}`, log);
      }
      if (log.includes(BOOT_READY)) {
        booted = true;
        break;
      }
      await delay(1_000);
    }

    if (!booted) {
      stopStream();
      fail(`The app did not report ${BOOT_READY} within ${BOOT_TIMEOUT_MS / 1000}s.`, log);
    }
    console.log(`  ${BOOT_READY}`);

    for (const route of ROUTES) {
      const before = log.split(JS_ERROR_PREDICATE).length - 1;
      await simctl(['openurl', device, `${SCHEME}://${route}`]);
      await delay(ROUTE_SETTLE_MS);
      const after = log.split(JS_ERROR_PREDICATE).length - 1;

      if (after > before) {
        stopStream();
        fail(`Visiting ${route} produced a JavaScript exception.`, log);
      }

      if (log.includes(RENDER_FAILED)) {
        const line = log.split('\n').find((entry) => entry.includes(RENDER_FAILED)) ?? RENDER_FAILED;
        stopStream();
        fail(`Visiting ${route} tripped the render error boundary: ${line.trim()}`, log);
      }

      // Checked per route, because a loop only burns CPU while its screen is up.
      const cpu = await cpuUtilisation(device, CPU_WINDOW_MS);
      if (cpu !== null && cpu > IDLE_CPU_LIMIT_PERCENT) {
        stopStream();
        fail(
          `${route} left the app using ${cpu.toFixed(0)}% CPU while idle (limit ` +
            `${IDLE_CPU_LIMIT_PERCENT}%), which is what a render or query loop looks like.`,
          log,
        );
      }
      console.log(`  ${route} ok${cpu === null ? '' : ` (idle cpu ${cpu.toFixed(0)}%)`}`);
    }

    // A crash after the last navigation would otherwise go unnoticed.
    const { stdout } = await simctl(['spawn', device, 'launchctl', 'list']).catch(() => ({ stdout: '' }));
    if (stdout && !stdout.includes(BUNDLE_ID)) {
      stopStream();
      fail('The app is no longer running at the end of the check.', log);
    }

    stopStream();
    console.log('\nSMOKE PASSED');
  } catch (error) {
    stopStream();
    fail(error instanceof Error ? error.message : String(error), log);
  }
}

await main();
