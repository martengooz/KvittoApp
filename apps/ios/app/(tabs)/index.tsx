import { useRouter } from 'expo-router';
import { LoadingState } from '../../src/ui/controls';
import { ReceiptsFeatureScreen } from '../../src/features/receipts/view';
import { useAppServices } from '../../src/app/services';

export default function ReceiptsRoute() {
  const { composition } = useAppServices();
  const router = useRouter();

  return (
    <>
      {composition ? <ReceiptsFeatureScreen
          repository={composition.tabs.receipts.repository}
          filterStore={composition.tabs.receipts.filters}
          onOpenFilters={() => router.push('/filters')}
          onOpenReceipt={(receiptId) => router.push(`/receipt/${receiptId}`)}
        /> : <LoadingState message="Loading receipts services..." />}
    </>
  );
}
