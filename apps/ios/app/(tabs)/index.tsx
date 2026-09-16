import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/controls';
import { ReceiptsFeatureScreen } from '../../src/features/receipts/view';
import { useAppServices } from '../../src/app/services';

export default function ReceiptsRoute() {
  const { composition } = useAppServices();

  return (
    <>
      <Stack.Screen options={{ title: 'Receipts', headerLargeTitle: true }} />
      {composition ? <ReceiptsFeatureScreen repository={composition.tabs.receipts.repository} /> : <LoadingState message="Loading receipts services..." />}
    </>
  );
}
