import { useEffect } from 'react';
import { useColorScheme } from 'react-native';
import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
  router,
  type ErrorBoundaryProps,
} from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { createKvittoNativeFacade } from '../../modules/kvitto-native/src';
import { StatusBar } from 'expo-status-bar';
import { AppServicesProvider, useAppServices } from './services';
import { DiagnosticsRecoveryState, LoadingState, ScreenScaffold } from '../ui/controls';
import { BodyText, TitleText } from '../ui/typography';
import { PUSHED_MODAL_ROUTE_CONTRACTS } from './routes';
import { driveRoutes } from './route-driver';

/**
 * Walks the routes named in the launch environment, once, after boot.
 *
 * The list is empty in every normal launch - nothing can set an environment
 * variable on an App Store launch - so this is inert in the field. It exists
 * because `devicectl` cannot open a URL or tap, which left every screen past
 * the first unverifiable on the hardware the app actually ships to.
 */
function useLaunchRouteDriver(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    let native: ReturnType<typeof createKvittoNativeFacade>;
    try {
      native = createKvittoNativeFacade();
    } catch {
      // Off-device there is no environment to read; nothing to drive.
      return;
    }

    const routes = native.launchRoutes();
    if (routes.length === 0) return;

    void driveRoutes({
      routes,
      dwellMs: native.launchRouteDwellMs(),
      navigate: (route) => {
        router.navigate(route as Parameters<typeof router.navigate>[0]);
      },
      log: (category, message) => native.logDiagnostic(category, message),
      wait: (ms) =>
        new Promise<void>((resolve) => {
          const handle = setTimeout(() => {
            if (!cancelled) resolve();
          }, ms);
          if (cancelled) clearTimeout(handle);
        }),
    });

    return () => {
      cancelled = true;
    };
  }, [ready]);
}

function RouterShell() {
  const { boot, retryBoot } = useAppServices();
  /*
   * The navigation chrome has its own theme and does not read the system
   * appearance on its own. Without this the header and its title stayed light
   * while every screen underneath - which reads system colours through
   * `colorToken` - went dark, which on a device is a white bar above a black
   * screen. Only ever visible on hardware: the simulator was screenshotted in
   * light mode, where the two happen to agree.
   */
  const scheme = useColorScheme();

  // Hooks run before the early returns below, so this cannot be moved inside
  // the ready branch; it gates on `ready` instead.
  useLaunchRouteDriver(boot.status === 'ready');

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
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/*
        `auto` follows the system appearance. It was pinned to `dark`, which
        means dark status-bar *content* - black text - and that is unreadable
        against this app's own dark-mode background.
      */}
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, animation: 'default' }}>
        <Stack.Screen name="(tabs)" />
        {/*
          Route options live here alone. Setting them again on the screen's own
          `Stack.Screen` made the two disagree: the sheet took its presentation
          from one and its header from the other, and rendered with a duplicate
          title bar.
        */}
        {PUSHED_MODAL_ROUTE_CONTRACTS.map((route) => (
          <Stack.Screen
            key={route.route}
            name={route.route}
            options={{
              headerShown: route.headerShown ?? true,
              title: route.title,
              presentation: route.presentation,
              ...(route.sheet
                ? {
                    sheetAllowedDetents: route.sheet.detents,
                    sheetInitialDetentIndex: route.sheet.initialDetentIndex,
                    sheetGrabberVisible: true,
                    sheetCornerRadius: 16,
                  }
                : {}),
            }}
          />
        ))}
      </Stack>
    </ThemeProvider>
  );
}

export function RootRouterLayout() {
  return (
    /*
     * Swipe actions on list rows are gesture-handler gestures, and those do
     * nothing without this root view. It wraps the provider so every route is
     * inside it, not just the ones that happen to use a gesture today.
     */
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppServicesProvider>
        <RouterShell />
      </AppServicesProvider>
    </GestureHandlerRootView>
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
