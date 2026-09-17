import { useEffect } from 'react';
import { Stack, type ErrorBoundaryProps } from 'expo-router';

import { createKvittoNativeFacade } from '../../modules/kvitto-native/src';
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

/** Marker the device smoke check watches for; see `apps/ios/scripts/smoke.mjs`. */
export const RENDER_FAILED_MARKER = 'render:failed';

export function RouterErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  // A render failure is invisible from outside the app: the process stays alive
  // and the screen still looks like a screen. React also stops a runaway update
  // loop once it trips its depth guard, so CPU falls back to idle and nothing
  // else marks it. Reporting it makes the failure observable.
  useEffect(() => {
    try {
      createKvittoNativeFacade().logDiagnostic(RENDER_FAILED_MARKER, error.message || 'unknown render error');
    } catch {
      // Off-device the boundary still renders; only the log line is missing.
    }
  }, [error]);

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
