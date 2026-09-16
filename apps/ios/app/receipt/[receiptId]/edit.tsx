import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../../src/app/route-skeleton';

export default function ReceiptEditRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Edit receipt', presentation: 'modal' }} />
      <RouteSkeletonScreen
        title="Edit receipt"
        summary="Modal edit route is wired for receipt field editing with controller-backed save and review actions."
      />
    </>
  );
}
