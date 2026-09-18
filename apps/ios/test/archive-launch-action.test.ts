import { describe, expect, test } from '@jest/globals';

import { ARCHIVE_ACTION_MARKERS, driveArchiveAction } from '../src/archive/launch-action';
import type { ArchiveLaunchActionPorts } from '../src/archive/launch-action';

function makeHarness(overrides: Partial<ArchiveLaunchActionPorts> = {}) {
  const logs: Array<{ category: string; message: string }> = [];
  const calls: string[] = [];

  const ports: ArchiveLaunchActionPorts = {
    action: 'export-and-share',
    exportArchive: async () => {
      calls.push('export');
      return 'file:///out.kvitto';
    },
    shareFile: async (uri) => {
      calls.push(`share:${uri}`);
      return true;
    },
    log: (category, message) => {
      logs.push({ category, message });
    },
    ...overrides,
  };

  return { ports, logs, calls, categories: () => logs.map((entry) => entry.category) };
}

describe('archive launch action', () => {
  test('a normal launch does nothing and says nothing', async () => {
    const harness = makeHarness({ action: '' });

    expect(await driveArchiveAction(harness.ports)).toBe('skipped');
    expect(harness.calls).toEqual([]);
    expect(harness.logs).toEqual([]);
  });

  test('exports, then shares what the export actually wrote', async () => {
    const harness = makeHarness({
      exportArchive: async () => 'file:///somewhere-else.kvitto',
    });

    expect(await driveArchiveAction(harness.ports)).toBe('shared');
    // Sharing the requested destination rather than the written one would pass
    // whenever the two agree and fail silently on a device where they do not.
    expect(harness.calls).toEqual(['share:file:///somewhere-else.kvitto']);
    expect(harness.categories()).toEqual([
      ARCHIVE_ACTION_MARKERS.started,
      ARCHIVE_ACTION_MARKERS.exported,
      ARCHIVE_ACTION_MARKERS.shared,
    ]);
  });

  test('a dismissed sheet is a distinct outcome, not a failure', async () => {
    /*
     * A dismissal still proves the sheet was presented, which is the one thing
     * this exists to check. Reporting it as a failure would make the device run
     * red for the expected result.
     */
    const harness = makeHarness({ shareFile: async () => false });

    expect(await driveArchiveAction(harness.ports)).toBe('dismissed');
    expect(harness.logs.at(-1)).toEqual({
      category: ARCHIVE_ACTION_MARKERS.shared,
      message: 'dismissed',
    });
  });

  test('an unknown verb is refused rather than treated as the real one', async () => {
    const harness = makeHarness({ action: 'export' });

    expect(await driveArchiveAction(harness.ports)).toBe('skipped');
    expect(harness.calls).toEqual([]);
    expect(harness.categories()).toEqual([ARCHIVE_ACTION_MARKERS.skipped]);
  });

  test('a failed export never reaches the share sheet', async () => {
    const harness = makeHarness({
      exportArchive: async () => {
        throw new Error('disk full');
      },
    });

    expect(await driveArchiveAction(harness.ports)).toBe('failed');
    expect(harness.calls).toEqual([]);
    expect(harness.logs.at(-1)?.message).toContain('disk full');
  });

  test('a share that throws is reported, not left as an unhandled rejection', async () => {
    const harness = makeHarness({
      shareFile: async () => {
        throw new Error('no visible screen to present from');
      },
    });

    await expect(driveArchiveAction(harness.ports)).resolves.toBe('failed');
    expect(harness.categories()).toEqual([
      ARCHIVE_ACTION_MARKERS.started,
      ARCHIVE_ACTION_MARKERS.exported,
      ARCHIVE_ACTION_MARKERS.failed,
    ]);
  });
});
