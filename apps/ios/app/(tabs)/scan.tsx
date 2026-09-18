import { LoadingState } from '../../src/ui/controls';
import { ScanFeatureScreen } from '../../src/app/scan-screen';
import { useAppServices } from '../../src/app/services';

export default function ScanRoute() {
  const { composition } = useAppServices();

  return (
    <>
      {composition ? (
        <ScanFeatureScreen
          controller={composition.tabs.scan.controller}
          camera={composition.tabs.scan.camera}
          native={composition.tabs.scan.native}
        />
      ) : (
        <LoadingState message="Loading scan services..." />
      )}
    </>
  );
}
