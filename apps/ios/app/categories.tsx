import { Stack } from 'expo-router';

import { LoadingState } from '../src/ui/controls';
import { TaxonomyScreen } from '../src/features/taxonomy/taxonomy-view';
import { useAppServices } from '../src/app/services';

export default function CategoriesRoute() {
  const { composition } = useAppServices();

  return (
    <>
      <Stack.Screen options={{ title: 'Categories' }} />
      {composition ? (
        <TaxonomyScreen repository={composition.repository} kind="categories" />
      ) : (
        <LoadingState message="Loading categories..." />
      )}
    </>
  );
}
