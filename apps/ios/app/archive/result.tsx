import { Stack, useRouter } from 'expo-router';

import { ArchiveResultScreen } from '../../src/archive/result-view';
import { readPreflightReport } from '../../src/archive/last-report';
import { applyArchive } from '../../src/archive/apply';
import { createNativeArchiveEntrySource } from '../../src/archive/native-entry-source';
import { useAppServices } from '../../src/app/services';

export default function ArchiveResultRoute() {
  const { composition } = useAppServices();
  const router = useRouter();
  const remembered = readPreflightReport();

  return (
    <>
      <Stack.Screen options={{ title: 'Archive result' }} />
      <ArchiveResultScreen
        report={remembered?.report ?? null}
        onApply={
          composition && remembered
            ? () =>
                applyArchive(
                  composition.repository,
                  composition.tabs.scan.native,
                  createNativeArchiveEntrySource(composition.tabs.scan.native, remembered.fileUri),
                  remembered.fileUri,
                )
            : undefined
        }
        onStartOver={() => router.replace('/archive/preflight')}
      />
    </>
  );
}
