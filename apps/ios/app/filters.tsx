import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../src/app/route-skeleton';

export default function FiltersRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Filters', presentation: 'modal' }} />
      <RouteSkeletonScreen
        title="Filters"
        summary="Receipt filtering contracts are wired to the receipts domain. UI and persistence controls are next."
      />
    </>
  );
}
