import { LoadingState } from '../../src/ui/controls';
import { CollectionsFeatureScreen } from '../../src/features/collections/view';
import { useAppServices } from '../../src/app/services';

export default function CollectionsRoute() {
  const { composition } = useAppServices();

  return (
    <>
      {composition ? <CollectionsFeatureScreen repository={composition.tabs.collections.repository} /> : <LoadingState message="Loading collection services..." />}
    </>
  );
}
