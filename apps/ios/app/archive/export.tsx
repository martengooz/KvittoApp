import { Stack } from 'expo-router';

import { LoadingState } from '../../src/ui/controls';
import { ArchiveExportScreen } from '../../src/archive/export-view';
import { createRepositoryExportSource } from '../../src/archive/repository-source';
import { useAppServices } from '../../src/app/services';

export default function ArchiveExportRoute() {
  const { composition } = useAppServices();

  if (!composition) {
    return (
      <>
        <Stack.Screen options={{ title: 'Export archive' }} />
        <LoadingState message="Loading archive services..." />
      </>
    );
  }

  const native = composition.tabs.scan.native;
  const source = createRepositoryExportSource(composition.repository, native, () =>
    composition.tabs.settings.controller.getSnapshot(),
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Export archive' }} />
      <ArchiveExportScreen
        native={native}
        source={source}
        destinationUri={native.makeScratchFileUri('kvitto-export', 'kvitto')}
      />
    </>
  );
}
