import type {
  BackgroundScheduleOutcome,
  EventSubscription,
  NativeBackgroundLaunch,
} from '../../modules/kvitto-native/src/contracts';

/**
 * The host-environment half of `KvittoNativeFacade`, inert.
 *
 * Background windows, the launch environment and the share sheet are things
 * only a running device has. Every native stub in this suite has to satisfy the whole facade,
 * and most of them care about one corner of it; spreading this in keeps a stub
 * about the thing it is actually testing, and means adding a method here does
 * not touch eight unrelated files.
 *
 * Tests that exercise these paths build their own controllable doubles; see
 * `jobs-background-task.test.ts` and `app-route-driver.test.ts`.
 */
export const NATIVE_HOST_STUB: {
  launchRoutes(): string[];
  launchRouteDwellMs(): number;
  launchScanAction(): string;
  launchArchiveAction(): string;
  shareFile(fileUri: string): Promise<boolean>;
  backgroundTaskIdentifier(): string;
  drainPendingBackgroundLaunches(): NativeBackgroundLaunch[];
  isBackgroundLaunchExpired(handle: string): boolean;
  finishBackgroundLaunch(handle: string, success: boolean): boolean;
  scheduleBackgroundProcessing(
    earliestDelaySeconds: number,
    requiresNetwork: boolean,
    requiresPower: boolean,
  ): Promise<BackgroundScheduleOutcome>;
  cancelBackgroundProcessing(): Promise<void>;
  pendingBackgroundTaskIdentifiers(): Promise<string[]>;
  onBackgroundLaunch(listener: (launch: NativeBackgroundLaunch) => void): EventSubscription;
} = {
  launchRoutes: () => [],
  launchRouteDwellMs: () => 0,
  launchScanAction: () => '',
  launchArchiveAction: () => '',
  // False, not true: there is no share sheet here, so nothing was shared. A
  // stub claiming success would let a screen report a file safely out of the
  // app when nothing had happened at all.
  shareFile: async () => false,
  backgroundTaskIdentifier: () => 'com.kvitto.app.ios.jobs.processing',
  drainPendingBackgroundLaunches: () => [],
  isBackgroundLaunchExpired: () => false,
  finishBackgroundLaunch: () => true,
  scheduleBackgroundProcessing: async () => 'unavailable',
  cancelBackgroundProcessing: async () => undefined,
  pendingBackgroundTaskIdentifiers: async () => [],
  onBackgroundLaunch: () => ({ remove: () => undefined }),
};
