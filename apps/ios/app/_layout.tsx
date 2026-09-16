import { RootRouterLayout, RouterErrorBoundary } from '../src/app/root-layout';

export default function RootLayout() {
  return <RootRouterLayout />;
}

export function ErrorBoundary(props: Parameters<typeof RouterErrorBoundary>[0]) {
  return <RouterErrorBoundary {...props} />;
}
