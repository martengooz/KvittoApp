import { Stack, useRouter } from 'expo-router';

import { LoadingState } from '../src/ui/controls';
import { ReceiptFiltersScreen } from '../src/features/receipts/filters-view';
import { useAppServices } from '../src/app/services';

export default function FiltersRoute() {
  const { composition } = useAppServices();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Filters', presentation: 'modal' }} />
      {composition ? (
        <ReceiptFiltersScreen
          repository={composition.tabs.receipts.repository}
          filterStore={composition.tabs.receipts.filters}
          onDone={() => {
            if (router.canGoBack()) router.back();
          }}
        />
      ) : (
        <LoadingState message="Loading filter services..." />
      )}
    </>
  );
}
