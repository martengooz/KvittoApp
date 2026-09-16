import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/controls';
import { SettingsFeatureScreen } from '../../src/app/settings-screen';
import { useAppServices } from '../../src/app/services';

export default function SettingsRoute() {
  const { composition } = useAppServices();

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerLargeTitle: true }} />
      {composition ? (
        <SettingsFeatureScreen
          controller={composition.tabs.settings.controller}
          startupSteps={composition.startup.steps}
        />
      ) : (
        <LoadingState message="Loading settings services..." />
      )}
    </>
  );
}
