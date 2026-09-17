import { Stack, useLocalSearchParams } from 'expo-router';

import { LoadingState } from '../../../src/ui/controls';
import { ReceiptExtractionScreen } from '../../../src/features/receipts/provenance-view';
import { useAppServices } from '../../../src/app/services';

export default function ReceiptExtractionRoute() {
  const { composition } = useAppServices();
  const { receiptId } = useLocalSearchParams<{ receiptId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'Extraction', headerBackTitle: 'Receipt' }} />
      {composition && receiptId ? (
        <ReceiptExtractionScreen repository={composition.tabs.receipts.repository} receiptId={receiptId} />
      ) : (
        <LoadingState message="Loading extraction services..." />
      )}
    </>
  );
}
