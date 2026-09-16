import { describe, expect, test } from '@jest/globals';

import {
  createBgContinuedProcessingTaskAdapter,
  createBgProcessingTaskAdapter,
  createExpoBackgroundTaskAdapter,
} from '../src/jobs/background-adapters';

describe('Packet 10 iOS background adapter contracts', () => {
  test('adapters are opportunistic and require persistent store semantics', async () => {
    const runtime = {
      supported: true,
      register: async () => 'registered' as const,
    };

    const adapters = [
      createBgContinuedProcessingTaskAdapter(runtime),
      createBgProcessingTaskAdapter(runtime),
      createExpoBackgroundTaskAdapter(runtime),
    ];

    for (const adapter of adapters) {
      expect(adapter.opportunistic).toBe(true);
      expect(adapter.requiresPersistentStore).toBe(true);
      await expect(adapter.isAvailable()).resolves.toBe(true);
      await expect(adapter.register(`task-${adapter.kind}`)).resolves.toBe('registered');
    }
  });

  test('execute skips when adapter kind does not match launch context', async () => {
    const runtime = {
      supported: true,
      register: async () => 'registered' as const,
    };

    const adapter = createBgProcessingTaskAdapter(runtime);
    let ran = 0;

    const result = await adapter.execute(
      {
        taskIdentifier: 'bg.process',
        adapterKind: 'expo-background-task',
        window: {
          startedAt: 10,
          deadlineAt: null,
          opportunistic: true,
        },
      },
      async () => {
        ran += 1;
      },
    );

    expect(result).toBe('skipped');
    expect(ran).toBe(0);
  });

  test('unavailable runtime reports unavailability and skips execution', async () => {
    const runtime = {
      supported: false,
      register: async () => 'registered' as const,
    };

    const adapter = createExpoBackgroundTaskAdapter(runtime);

    await expect(adapter.isAvailable()).resolves.toBe(false);
    await expect(adapter.register('expo.job')).resolves.toBe('unavailable');

    await expect(
      adapter.execute(
        {
          taskIdentifier: 'expo.job',
          adapterKind: 'expo-background-task',
          window: {
            startedAt: 99,
            deadlineAt: 199,
            opportunistic: true,
          },
        },
        async () => {},
      ),
    ).resolves.toBe('skipped');
  });
});
