import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../../src/app/route-skeleton';

export default function ReceiptOcrRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'OCR details' }} />
      <RouteSkeletonScreen
        title="OCR details"
        summary="OCR evidence route is wired for source-first OCR diagnostics and receipt field fill provenance."
      />
    </>
  );
}
