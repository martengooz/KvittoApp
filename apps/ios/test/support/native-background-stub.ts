import type {
  BackgroundScheduleOutcome,
  EventSubscription,
  NativeBackgroundLaunch,
} from '../../modules/kvitto-native/src/contracts';

/**
 * The background-task half of `KvittoNativeFacade`, inert.
 *
 * Every native stub in this suite has to satisfy the whole facade, and most of
 * them care about one corner of it. Spreading this in keeps a stub about the
 * thing it is actually testing, and means adding a background method does not
 * touch eight unrelated files.
 *
 * Tests that exercise the background path build their own controllable double;
 * see `jobs-background-task.test.ts`.
 */
export const NATIVE_BACKGROUND_STUB: {
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
  backgroundTaskIdentifier: () => 'com.kvitto.app.ios.jobs.processing',
  drainPendingBackgroundLaunches: () => [],
  isBackgroundLaunchExpired: () => false,
  finishBackgroundLaunch: () => true,
  scheduleBackgroundProcessing: async () => 'unavailable',
  cancelBackgroundProcessing: async () => undefined,
  pendingBackgroundTaskIdentifiers: async () => [],
  onBackgroundLaunch: () => ({ remove: () => undefined }),
};
