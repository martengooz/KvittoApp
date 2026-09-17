import { Stack, useRouter } from 'expo-router';

import { LoadingState } from '../../src/ui/controls';
import { PairingScannerScreen } from '../../src/features/pairing/scanner-view';
import { useAppServices } from '../../src/app/services';
import { createKvittoNativeFacade } from '../../modules/kvitto-native/src';

/** A simulator has no camera, so scanning cannot be offered there. */
function cameraAvailable(): boolean {
  try {
    return !createKvittoNativeFacade().isSimulator();
  } catch {
    return false;
  }
}

export default function PairingScannerRoute() {
  const { composition } = useAppServices();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Pair device', presentation: 'modal' }} />
      {composition ? (
        <PairingScannerScreen
          controller={composition.tabs.settings.controller}
          cameraAvailable={cameraAvailable()}
          onPaired={() => {
            if (router.canGoBack()) router.back();
          }}
        />
      ) : (
        <LoadingState message="Loading pairing services..." />
      )}
    </>
  );
}
