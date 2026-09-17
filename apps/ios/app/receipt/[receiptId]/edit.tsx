import { Stack, useLocalSearchParams, useRouter } from 'expo-router';

import { LoadingState } from '../../../src/ui/controls';
import { ReceiptEditScreen } from '../../../src/features/receipts/edit-view';
import { useAppServices } from '../../../src/app/services';

export default function ReceiptEditRoute() {
  const { composition } = useAppServices();
  const { receiptId } = useLocalSearchParams<{ receiptId: string }>();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Edit receipt', presentation: 'modal' }} />
      {composition && receiptId ? (
        <ReceiptEditScreen
          repository={composition.tabs.receipts.repository}
          receiptId={receiptId}
          onDone={() => {
            if (router.canGoBack()) router.back();
          }}
        />
      ) : (
        <LoadingState message="Loading receipt services..." />
      )}
    </>
  );
}
