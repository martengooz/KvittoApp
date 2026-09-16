import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../../src/app/route-skeleton';

export default function DebugLogRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Debug log' }} />
      <RouteSkeletonScreen
        title="Debug log"
        summary="Debug log route is wired for bounded, redacted diagnostics tied to existing settings and sync policies."
      />
    </>
  );
}
