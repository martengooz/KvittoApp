/** Markers the archive device check watches. */
export const ARCHIVE_ACTION_MARKERS = {
  started: 'archive:action:started',
  skipped: 'archive:action:skipped',
  exported: 'archive:action:exported',
  shared: 'archive:action:shared',
  failed: 'archive:action:failed',
} as const;

export type ArchiveLaunchOutcome = 'skipped' | 'shared' | 'dismissed' | 'failed';

export interface ArchiveLaunchActionPorts {
  /** The verb from the launch environment. Empty on every normal launch. */
  action: string;
  /** Runs the export, returning where it wrote. */
  exportArchive(): Promise<string>;
  /** Hands that file to the share sheet; false means the sheet was dismissed. */
  shareFile(uri: string): Promise<boolean>;
  log(category: string, message: string): void;
}

/**
 * Exports an archive and opens the share sheet, from the launch environment.
 *
 * The share sheet is UIKit presentation: it has to run on the main thread, it
 * has to find the view controller actually on screen rather than the root one,
 * and on iPad it raises rather than degrades if given no popover anchor. None
 * of that is reachable from a test - the adapter is Swift, and the failure mode
 * is a crash or a sheet nobody can see, neither of which a host-rendered screen
 * can observe.
 *
 * So this presses both buttons on a real device, and a screenshot afterwards
 * shows whether the sheet came up. Picking a destination still needs a person;
 * everything up to that point does not.
 *
 * Nothing can set this on an App Store launch.
 */
export async function driveArchiveAction(ports: ArchiveLaunchActionPorts): Promise<ArchiveLaunchOutcome> {
  const action = ports.action.trim();
  if (action === '') return 'skipped';

  if (action !== 'export-and-share') {
    ports.log(ARCHIVE_ACTION_MARKERS.skipped, `unknown action ${action}`);
    return 'skipped';
  }

  ports.log(ARCHIVE_ACTION_MARKERS.started, action);

  try {
    const uri = await ports.exportArchive();
    ports.log(ARCHIVE_ACTION_MARKERS.exported, uri);

    const shared = await ports.shareFile(uri);
    /*
     * Reported either way. A dismissal still proves the sheet was presented,
     * which is the thing that could not be checked anywhere else - so it is a
     * distinct outcome rather than a failure.
     */
    ports.log(ARCHIVE_ACTION_MARKERS.shared, shared ? 'completed' : 'dismissed');
    return shared ? 'shared' : 'dismissed';
  } catch (error) {
    ports.log(ARCHIVE_ACTION_MARKERS.failed, error instanceof Error ? error.message : String(error));
    return 'failed';
  }
}
