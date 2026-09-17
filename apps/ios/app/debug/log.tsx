import { useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';

import { LoadingState } from '../../src/ui/controls';
import { DebugScreen } from '../../src/features/debug/debug-view';
import { useAppServices } from '../../src/app/services';
import { seedSampleData } from '../../src/data/sample-data';
import { createKvittoNativeFacade } from '../../modules/kvitto-native/src';

/** Watched by `scripts/smoke.mjs` to prove seeding actually ran. */
const SAMPLE_SEEDED_MARKER = 'sample-data:seeded';

/**
 * Whether sample-data actions may appear. Off-device the native module is
 * unavailable, and a device that cannot answer is treated as a real one.
 */
function isSimulator(): boolean {
  try {
    return createKvittoNativeFacade().isSimulator();
  } catch {
    return false;
  }
}

export default function DebugLogRoute() {
  const { composition } = useAppServices();
  const { seed } = useLocalSearchParams<{ seed?: string }>();
  const allowSampleData = isSimulator();
  const [autoSeed, setAutoSeed] = useState<string | null>(null);

  /*
   * `?seed=1` seeds on open. Without it the only way to put receipts on a
   * simulator is to tap the button, and `simctl` cannot tap - which left every
   * receipt-dependent screen unverifiable on device past its empty state. A
   * deep link is drivable by the smoke check; the simulator gate still applies.
   */
  const repository = composition?.repository;
  useEffect(() => {
    if (!repository || seed !== '1' || !allowSampleData) return;

    let cancelled = false;
    void seedSampleData(repository)
      .then(({ receipts, items }) => {
        if (!cancelled) setAutoSeed(`Seeded ${receipts} receipts and ${items} line items on open.`);
        /*
         * Release strips `console`, and the smoke check cannot read the screen.
         * Without this line a seed that silently did nothing would leave the
         * populated routes rendering "not found" - and still passing.
         */
        try {
          createKvittoNativeFacade().logDiagnostic(SAMPLE_SEEDED_MARKER, `${receipts}/${items}`);
        } catch {
          // Off-device there is no unified log; the on-screen notice still says.
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAutoSeed(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [allowSampleData, repository, seed]);

  return (
    <>
      <Stack.Screen options={{ title: 'Debug' }} />
      {composition ? (
        <DebugScreen
          repository={composition.repository}
          startupSteps={composition.startup.steps}
          allowSampleData={allowSampleData}
          notice={autoSeed}
        />
      ) : (
        <LoadingState message="Loading debug services..." />
      )}
    </>
  );
}
