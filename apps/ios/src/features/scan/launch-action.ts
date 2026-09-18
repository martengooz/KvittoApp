/** Markers the device camera check watches; see `scripts/device-camera-check.mjs`. */
export const SCAN_ACTION_MARKERS = {
  started: 'scan:action:started',
  skipped: 'scan:action:skipped',
  captured: 'scan:action:captured',
  saved: 'scan:action:saved',
  failed: 'scan:action:failed',
} as const;

export type ScanLaunchOutcome = 'skipped' | 'saved' | 'failed';

export interface ScanLaunchActionPorts {
  /** The verb from the launch environment. Empty on every normal launch. */
  action: string;
  /** Whether a capture would be accepted: granted, attached, active, idle. */
  canCapture(): boolean;
  shutter(): Promise<void>;
  confirm(): Promise<string>;
  log(category: string, message: string): void;
  wait(ms: number): Promise<void>;
  now(): number;
  /** How long to wait for the preview before giving up. */
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Presses the shutter on behalf of a test, from the launch environment.
 *
 * `devicectl` can install, launch and screenshot a physical device, and that is
 * the whole list: it cannot tap. So the one path that matters most on real
 * hardware - point the camera at a receipt and press the button - was the one
 * path only a human could exercise, and it shipped broken because of it. The
 * capture wrote to a `file://` URI used as a filesystem path, which no test
 * could see and no simulator could reach, because a simulator has no camera.
 *
 * Only `capture` does anything. An unrecognised verb is reported and ignored
 * rather than treated as a capture: a typo in a smoke script should fail loudly,
 * not silently write a receipt and claim the path works.
 *
 * Nothing can set this on an App Store launch, so the path is unreachable in
 * the field rather than merely unused.
 */
export async function driveScanAction(ports: ScanLaunchActionPorts): Promise<ScanLaunchOutcome> {
  const action = ports.action.trim();
  if (action === '') return 'skipped';

  if (action !== 'capture') {
    ports.log(SCAN_ACTION_MARKERS.skipped, `unknown action ${action}`);
    return 'skipped';
  }

  ports.log(SCAN_ACTION_MARKERS.started, action);

  const timeoutMs = ports.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollMs = ports.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = ports.now() + timeoutMs;

  /*
   * The camera takes a moment to attach after the screen mounts. Pressing the
   * shutter before then fails for a reason that has nothing to do with the
   * capture path, which is exactly the false negative this is meant to catch.
   */
  while (!ports.canCapture()) {
    if (ports.now() >= deadline) {
      ports.log(SCAN_ACTION_MARKERS.failed, `preview not ready after ${timeoutMs}ms`);
      return 'failed';
    }
    await ports.wait(pollMs);
  }

  try {
    await ports.shutter();
    ports.log(SCAN_ACTION_MARKERS.captured, 'shutter');
    const receiptId = await ports.confirm();
    ports.log(SCAN_ACTION_MARKERS.saved, receiptId);
    return 'saved';
  } catch (error) {
    /*
     * Reported, never rethrown. This is a diagnostic path, and a capture that
     * fails should leave a line in the log and a usable app behind it - the log
     * is the whole point, and an unhandled rejection would cost us the rest.
     */
    ports.log(SCAN_ACTION_MARKERS.failed, error instanceof Error ? error.message : String(error));
    return 'failed';
  }
}
