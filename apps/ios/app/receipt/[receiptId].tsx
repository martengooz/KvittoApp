import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { LoadingState } from '../../src/ui/controls';
import { ReceiptDetailScreen } from '../../src/features/receipts/detail-view';
import { useAppServices } from '../../src/app/services';

export default function ReceiptDetailRoute() {
  const { composition } = useAppServices();
  const { receiptId } = useLocalSearchParams<{ receiptId: string }>();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Receipt details', headerBackTitle: 'Receipts' }} />
      {composition && receiptId ? (
        <ReceiptDetailScreen
          repository={composition.tabs.receipts.repository}
          receiptId={receiptId}
          onDeleted={() => {
            if (router.canGoBack()) router.back();
          }}
          onOpenExtraction={() => router.push(`/receipt/${receiptId}/extraction`)}
          onOpenOcr={() => router.push(`/receipt/${receiptId}/ocr`)}
        />
      ) : (
        <LoadingState message="Loading receipt services..." />
      )}
    </>
  );
}
