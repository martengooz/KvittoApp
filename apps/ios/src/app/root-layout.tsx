import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppServicesProvider, useAppServices } from './services';
import { DiagnosticsRecoveryState, LoadingState, ScreenScaffold } from '../ui/controls';
import { BodyText, TitleText } from '../ui/typography';
import { PUSHED_MODAL_ROUTE_CONTRACTS } from './routes';

function RouterShell() {
  const { boot, retryBoot } = useAppServices();

  if (boot.status === 'loading') {
    return <LoadingState message="Preparing encrypted storage and startup services..." />;
  }

  if (boot.status === 'error') {
    return (
      <DiagnosticsRecoveryState
        title={boot.diagnostics?.message ?? 'Startup failed'}
        details={boot.diagnostics?.details ?? 'Open diagnostics and retry startup.'}
        onRetry={retryBoot}
      />
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, animation: 'default' }}>
        <Stack.Screen name="(tabs)" />
        {PUSHED_MODAL_ROUTE_CONTRACTS.map((route) => (
          <Stack.Screen
            key={route.route}
            name={route.route}
            options={{
              headerShown: true,
              title: route.title,
              presentation: route.presentation,
            }}
          />
        ))}
      </Stack>
    </>
  );
}

export function RootRouterLayout() {
  return (
    <AppServicesProvider>
      <RouterShell />
    </AppServicesProvider>
  );
}

export function RouterErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <ScreenScaffold>
      <TitleText accessibilityRole="header">Unexpected error</TitleText>
      <BodyText>
        {error.message || 'An unknown rendering error occurred while building the native shell.'}
      </BodyText>
      <BodyText accessibilityRole="button" onPress={() => void retry()}>
        Tap to retry
      </BodyText>
    </ScreenScaffold>
  );
}
