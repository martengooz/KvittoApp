import { Stack, useLocalSearchParams } from 'expo-router';

import { LoadingState } from '../../../src/ui/controls';
import { ReceiptOcrScreen } from '../../../src/features/receipts/provenance-view';
import { useAppServices } from '../../../src/app/services';

export default function ReceiptOcrRoute() {
  const { composition } = useAppServices();
  const { receiptId } = useLocalSearchParams<{ receiptId: string }>();

  return (
    <>
      <Stack.Screen options={{ title: 'OCR text', headerBackTitle: 'Receipt' }} />
      {composition && receiptId ? (
        <ReceiptOcrScreen repository={composition.tabs.receipts.repository} receiptId={receiptId} />
      ) : (
        <LoadingState message="Loading OCR services..." />
      )}
    </>
  );
}
