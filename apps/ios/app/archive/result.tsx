import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../src/app/route-skeleton';

export default function ArchiveResultRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Archive result' }} />
      <RouteSkeletonScreen
        title="Archive result"
        summary="Archive result route is wired for post-import reporting with merge outcomes and follow-up actions."
      />
    </>
  );
}
