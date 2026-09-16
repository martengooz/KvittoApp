import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/controls';
import { ScanFeatureScreen } from '../../src/app/scan-screen';
import { useAppServices } from '../../src/app/services';

export default function ScanRoute() {
  const { composition } = useAppServices();

  return (
    <>
      <Stack.Screen options={{ title: 'Scan', headerLargeTitle: true }} />
      {composition ? <ScanFeatureScreen controller={composition.tabs.scan.controller} /> : <LoadingState message="Loading scan services..." />}
    </>
  );
}
