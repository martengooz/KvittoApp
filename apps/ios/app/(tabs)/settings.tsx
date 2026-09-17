import { Stack, useRouter } from 'expo-router';
import { LoadingState } from '../../src/ui/controls';
import { SettingsFeatureScreen } from '../../src/app/settings-screen';
import { useAppServices } from '../../src/app/services';

export default function SettingsRoute() {
  const { composition } = useAppServices();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerLargeTitle: true }} />
      {composition ? (
        <SettingsFeatureScreen
          controller={composition.tabs.settings.controller}
          startupSteps={composition.startup.steps}
          onOpenCategories={() => router.push('/categories')}
          onOpenTags={() => router.push('/tags')}
          onOpenExport={() => router.push('/archive/export')}
          onOpenImport={() => router.push('/archive/preflight')}
          onOpenPairing={() => router.push('/pairing/scanner')}
        />
      ) : (
        <LoadingState message="Loading settings services..." />
      )}
    </>
  );
}
