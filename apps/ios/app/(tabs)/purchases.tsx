import { Stack } from 'expo-router';
import { LoadingState } from '../../src/ui/controls';
import { PurchasesFeatureScreen } from '../../src/features/purchases/view';
import { useAppServices } from '../../src/app/services';

export default function PurchasesRoute() {
  const { composition } = useAppServices();

  return (
    <>
      <Stack.Screen options={{ title: 'Purchases', headerLargeTitle: true }} />
      {composition ? <PurchasesFeatureScreen repository={composition.tabs.purchases.repository} /> : <LoadingState message="Loading purchases services..." />}
    </>
  );
}
