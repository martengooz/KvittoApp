import type {
  JobBackgroundAdapterContract,
  JobBackgroundLaunchContext,
  JobBackgroundRegistrationResult,
} from './contracts';

interface AdapterRuntime {
  supported: boolean;
  register(taskIdentifier: string): Promise<JobBackgroundRegistrationResult>;
}

function createAdapter(
  kind: JobBackgroundAdapterContract['kind'],
  runtime: AdapterRuntime,
): JobBackgroundAdapterContract {
  return {
    kind,
    opportunistic: true,
    requiresPersistentStore: true,
    async isAvailable(): Promise<boolean> {
      return runtime.supported;
    },
    async register(taskIdentifier: string): Promise<JobBackgroundRegistrationResult> {
      if (!runtime.supported) return 'unavailable';
      return runtime.register(taskIdentifier);
    },
    async execute(context: JobBackgroundLaunchContext, run: () => Promise<void>): Promise<'ran' | 'skipped'> {
      if (!runtime.supported) return 'skipped';
      if (context.adapterKind !== kind) return 'skipped';
      await run();
      return 'ran';
    },
  };
}

export function createBgContinuedProcessingTaskAdapter(runtime: AdapterRuntime): JobBackgroundAdapterContract {
  return createAdapter('bg-continued-processing-task', runtime);
}

export function createBgProcessingTaskAdapter(runtime: AdapterRuntime): JobBackgroundAdapterContract {
  return createAdapter('bg-processing-task', runtime);
}

export function createExpoBackgroundTaskAdapter(runtime: AdapterRuntime): JobBackgroundAdapterContract {
  return createAdapter('expo-background-task', runtime);
}
