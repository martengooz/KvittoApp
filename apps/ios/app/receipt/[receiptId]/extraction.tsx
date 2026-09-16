import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../../src/app/route-skeleton';

export default function ReceiptExtractionRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Extraction details' }} />
      <RouteSkeletonScreen
        title="Extraction details"
        summary="Extraction diagnostics route is wired for provider outputs and warning-level review decisions."
      />
    </>
  );
}
