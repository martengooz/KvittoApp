import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../src/app/route-skeleton';

export default function ArchivePreflightRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Archive preflight' }} />
      <RouteSkeletonScreen
        title="Archive preflight"
        summary="Archive preflight route is wired for validation, conflict preview, and blob integrity checks before import."
      />
    </>
  );
}
