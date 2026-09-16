import { Stack } from 'expo-router';
import { RouteSkeletonScreen } from '../src/app/route-skeleton';

export default function CategoriesRoute() {
  return (
    <>
      <Stack.Screen options={{ title: 'Categories' }} />
      <RouteSkeletonScreen
        title="Categories"
        summary="Category management route is present and reserved for receipts taxonomy editing using existing repositories."
      />
    </>
  );
}
