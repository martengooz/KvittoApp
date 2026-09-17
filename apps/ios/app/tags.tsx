import { Stack } from 'expo-router';

import { LoadingState } from '../src/ui/controls';
import { TaxonomyScreen } from '../src/features/taxonomy/taxonomy-view';
import { useAppServices } from '../src/app/services';

export default function TagsRoute() {
  const { composition } = useAppServices();

  return (
    <>
      <Stack.Screen options={{ title: 'Tags' }} />
      {composition ? (
        <TaxonomyScreen repository={composition.repository} kind="tags" />
      ) : (
        <LoadingState message="Loading tags..." />
      )}
    </>
  );
}
