import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../src/app/route-skeleton';

export default function PairingScannerRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Pairing scanner', presentation: 'modal' }} />
      <RouteSkeletonScreen
        title="Pairing scanner"
        summary="Pairing scanner route is wired for camera-driven QR onboarding using existing sync identity contracts."
      />
    </>
  );
}
