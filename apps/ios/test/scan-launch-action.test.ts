import { describe, expect, test } from '@jest/globals';

import { SCAN_ACTION_MARKERS, driveScanAction } from '../src/features/scan/launch-action';
import type { ScanLaunchActionPorts } from '../src/features/scan/launch-action';

function makeHarness(overrides: Partial<ScanLaunchActionPorts> = {}) {
  const logs: Array<{ category: string; message: string }> = [];
  const calls: string[] = [];
  const clock = { value: 0 };
  let ready = true;

  const ports: ScanLaunchActionPorts = {
    action: 'capture',
    canCapture: () => ready,
    shutter: async () => {
      calls.push('shutter');
    },
    confirm: async () => {
      calls.push('confirm');
      return 'receipt-1';
    },
    log: (category, message) => {
      logs.push({ category, message });
    },
    // The clock only moves when the driver waits, so a poll loop that never
    // waits would spin here rather than quietly passing on a real timer.
    wait: async (ms) => {
      clock.value += ms;
    },
    now: () => clock.value,
    ...overrides,
  };

  return {
    ports,
    logs,
    calls,
    clock,
    setReady: (next: boolean) => {
      ready = next;
    },
    categories: () => logs.map((entry) => entry.category),
  };
}

describe('scan launch action', () => {
  test('a normal launch does nothing at all', async () => {
    const harness = makeHarness({ action: '' });

    expect(await driveScanAction(harness.ports)).toBe('skipped');
    expect(harness.calls).toEqual([]);
    // Not even a log line: every launch in the field takes this path.
    expect(harness.logs).toEqual([]);
  });

  test('capture presses the shutter and confirms, reporting the receipt', async () => {
    const harness = makeHarness();

    expect(await driveScanAction(harness.ports)).toBe('saved');
    expect(harness.calls).toEqual(['shutter', 'confirm']);
    expect(harness.categories()).toEqual([
      SCAN_ACTION_MARKERS.started,
      SCAN_ACTION_MARKERS.captured,
      SCAN_ACTION_MARKERS.saved,
    ]);
    expect(harness.logs.at(-1)?.message).toBe('receipt-1');
  });

  test('an unknown verb is refused rather than treated as a capture', async () => {
    /*
     * A typo in a smoke script must not quietly write a receipt and report that
     * the capture path works - that would be a green check for an untested path.
     */
    const harness = makeHarness({ action: 'captrue' });

    expect(await driveScanAction(harness.ports)).toBe('skipped');
    expect(harness.calls).toEqual([]);
    expect(harness.categories()).toEqual([SCAN_ACTION_MARKERS.skipped]);
  });

  test('waits for the preview to attach before pressing anything', async () => {
    // The camera is not ready the instant the screen mounts. Pressing then
    // fails for a reason that has nothing to do with the path under test.
    const harness = makeHarness();
    harness.setReady(false);

    let polls = 0;
    harness.ports.canCapture = () => {
      polls += 1;
      if (polls > 3) return true;
      return false;
    };

    expect(await driveScanAction(harness.ports)).toBe('saved');
    expect(harness.calls).toEqual(['shutter', 'confirm']);
    expect(harness.clock.value).toBeGreaterThan(0);
  });

  test('gives up when the preview never attaches, without pressing', async () => {
    const harness = makeHarness({ readyTimeoutMs: 500, pollIntervalMs: 100 });
    harness.setReady(false);

    expect(await driveScanAction(harness.ports)).toBe('failed');
    expect(harness.calls).toEqual([]);
    expect(harness.categories()).toContain(SCAN_ACTION_MARKERS.failed);
    expect(harness.logs.at(-1)?.message).toContain('500ms');
  });

  test('a failing capture is reported and swallowed', async () => {
    /*
     * This is the shape of the defect a real tap found: the save threw deep in
     * the capture path. The driver has to leave that message in the log, and
     * has to not take the app down with an unhandled rejection - the log is the
     * only thing a device hands back.
     */
    const harness = makeHarness({
      shutter: async () => {
        throw new Error('The file "capture-1.jpg" doesn\'t exist.');
      },
    });

    await expect(driveScanAction(harness.ports)).resolves.toBe('failed');
    expect(harness.categories()).toEqual([SCAN_ACTION_MARKERS.started, SCAN_ACTION_MARKERS.failed]);
    expect(harness.logs.at(-1)?.message).toContain("doesn't exist");
  });

  test('a failing confirm still reports, after a successful shutter', async () => {
    const harness = makeHarness({
      confirm: async () => {
        throw new Error('no review to confirm');
      },
    });

    expect(await driveScanAction(harness.ports)).toBe('failed');
    expect(harness.categories()).toEqual([
      SCAN_ACTION_MARKERS.started,
      SCAN_ACTION_MARKERS.captured,
      SCAN_ACTION_MARKERS.failed,
    ]);
  });
});
