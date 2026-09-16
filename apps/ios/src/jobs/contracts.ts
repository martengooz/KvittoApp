export type JobBackgroundAdapterKind =
  | 'bg-continued-processing-task'
  | 'bg-processing-task'
  | 'expo-background-task';

export interface PersistentJobStoreDependency {
  readonly durable: true;
  readonly persistence: 'sqlite' | 'sqlcipher' | 'custom';
  readonly description?: string;
}

export interface JobBackgroundWindow {
  readonly startedAt: number;
  readonly deadlineAt: number | null;
  readonly opportunistic: true;
}

export interface JobBackgroundLaunchContext {
  readonly taskIdentifier: string;
  readonly adapterKind: JobBackgroundAdapterKind;
  readonly window: JobBackgroundWindow;
}

export type JobBackgroundRegistrationResult = 'registered' | 'already-registered' | 'unavailable';

export interface JobBackgroundAdapterContract {
  readonly kind: JobBackgroundAdapterKind;
  readonly opportunistic: true;
  readonly requiresPersistentStore: true;
  isAvailable(): Promise<boolean>;
  register(taskIdentifier: string): Promise<JobBackgroundRegistrationResult>;
  execute(context: JobBackgroundLaunchContext, run: () => Promise<void>): Promise<'ran' | 'skipped'>;
}

export interface JobForegroundRunnerCapability {
  readonly opportunistic: true;
  readonly requiresPersistentStore: true;
}

export const IOS_JOB_RUNNER_CAPABILITY: JobForegroundRunnerCapability = {
  opportunistic: true,
  requiresPersistentStore: true,
};
