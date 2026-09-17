import { Stack, useRouter } from 'expo-router';

import { LoadingState } from '../../src/ui/controls';
import { ArchivePreflightScreen } from '../../src/archive/preflight-view';
import { rememberPreflightReport } from '../../src/archive/last-report';
import { useAppServices } from '../../src/app/services';

export default function ArchivePreflightRoute() {
  const { composition } = useAppServices();
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Import archive' }} />
      {composition ? (
        <ArchivePreflightScreen
          native={composition.tabs.scan.native}
          onReport={(report) => {
            rememberPreflightReport(report);
            router.push('/archive/result');
          }}
        />
      ) : (
        <LoadingState message="Loading archive services..." />
      )}
    </>
  );
}
