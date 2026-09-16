import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../src/app/route-skeleton';

export default function TagsRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Tags' }} />
      <RouteSkeletonScreen
        title="Tags"
        summary="Tag management route is present and reserved for receipts taxonomy editing using existing repositories."
      />
    </>
  );
}
