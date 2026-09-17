import { Stack, useRouter } from 'expo-router';

import { ArchiveResultScreen } from '../../src/archive/result-view';
import { readPreflightReport } from '../../src/archive/last-report';

export default function ArchiveResultRoute() {
  const router = useRouter();

  return (
    <>
      <Stack.Screen options={{ title: 'Archive result' }} />
      <ArchiveResultScreen
        report={readPreflightReport()}
        onStartOver={() => router.replace('/archive/preflight')}
      />
    </>
  );
}
