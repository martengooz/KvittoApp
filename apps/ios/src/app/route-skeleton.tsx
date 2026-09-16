import { ScreenScaffold, SurfaceCard } from '../ui/controls';
import { CaptionText } from '../ui/typography';

export type RouteSkeletonScreenProps = {
  title: string;
  summary: string;
};

export function RouteSkeletonScreen({ title, summary }: RouteSkeletonScreenProps) {
  return (
    <ScreenScaffold>
      <SurfaceCard title={title} body={summary} />
      <CaptionText accessibilityRole="summary">Route shell is wired. Controller integration follows existing feature APIs.</CaptionText>
    </ScreenScaffold>
  );
}
