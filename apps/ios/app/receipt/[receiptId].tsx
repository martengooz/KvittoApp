import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../src/app/route-skeleton';

export default function ReceiptDetailRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Receipt details' }} />
      <RouteSkeletonScreen
        title="Receipt details"
        summary="Receipt detail route is wired for pushed navigation and will host richer controller-backed detail rendering."
      />
    </>
  );
}
