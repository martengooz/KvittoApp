import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { SettingsFeatureController, type SettingsControllerSnapshot } from '../features/settings';
import { PrimaryButton, ScreenScaffold } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { colorToken } from '../ui/tokens';

export type SettingsFeatureScreenProps = {
  controller: SettingsFeatureController;
  startupSteps: string[];
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function SettingsFeatureScreen({ controller, startupSteps }: SettingsFeatureScreenProps) {
  const [snapshot, setSnapshot] = useState<SettingsControllerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await controller.getSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }, [controller]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback(
    async (work: () => Promise<void> | void) => {
      try {
        await work();
        await refresh();
      } catch (nextError) {
        setError(toErrorMessage(nextError));
      }
    },
    [refresh],
  );

  if (!snapshot) {
    return (
      <ScreenScaffold>
        <CaptionText accessibilityRole="progressbar">Loading settings…</CaptionText>
        {error ? <BodyText accessibilityRole="alert">{error}</BodyText> : null}
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">Settings</TitleText>
      {error ? <BodyText accessibilityRole="alert">{error}</BodyText> : null}

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Startup diagnostics">
        <TitleText>Startup diagnostics</TitleText>
        {startupSteps.map((step) => (
          <CaptionText key={step}>{step}</CaptionText>
        ))}
      </View>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Image settings">
        <TitleText>Image processing</TitleText>
        <View style={styles.toggleRow}>
          <CaptionText>Auto-capture</CaptionText>
          <Switch
            accessibilityLabel="Auto-capture"
            value={snapshot.image.autoCapture}
            onValueChange={(value) => {
              void apply(() => controller.updateImage({ autoCapture: value }));
            }}
          />
        </View>
        <CaptionText>{`Color mode: ${snapshot.image.colorMode}`}</CaptionText>
        <CaptionText>{`JPEG quality: ${snapshot.image.jpegQuality.toFixed(2)}`}</CaptionText>
      </View>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Sync settings">
        <TitleText>Sync</TitleText>
        <View style={styles.toggleRow}>
          <CaptionText>Auto-sync</CaptionText>
          <Switch
            accessibilityLabel="Auto-sync"
            value={snapshot.sync.autoSync}
            onValueChange={(value) => {
              void apply(() => controller.updateSync({ autoSync: value }));
            }}
          />
        </View>
        <View style={styles.toggleRow}>
          <CaptionText>Wi-Fi only</CaptionText>
          <Switch
            accessibilityLabel="Wi-Fi only"
            value={snapshot.sync.wifiOnly}
            onValueChange={(value) => {
              void apply(() => controller.updateSync({ wifiOnly: value }));
            }}
          />
        </View>
      </View>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Credentials">
        <TitleText>Credentials</TitleText>
        <CaptionText>{`Pairing token: ${snapshot.credentialPresence.pairingToken ? 'set' : 'not set'}`}</CaptionText>
        <CaptionText>{`AI API key: ${snapshot.credentialPresence.aiApiKey ? 'set' : 'not set'}`}</CaptionText>
        <CaptionText>{`Company API key: ${snapshot.credentialPresence.companyApiKey ? 'set' : 'not set'}`}</CaptionText>
        <PrimaryButton
          label="Clear secure credentials"
          onPress={() => {
            void apply(async () => {
              await controller.clearSecureCredentials();
            });
          }}
        />
      </View>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="About this build">
        <TitleText>About</TitleText>
        <CaptionText>{`${snapshot.about.appName} ${snapshot.about.appVersion}`}</CaptionText>
        <CaptionText>{`Native status: ${snapshot.about.nativeVersion}`}</CaptionText>
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    gap: 10,
    paddingTop: 12,
    paddingBottom: 16,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    borderRadius: 12,
    backgroundColor: colorToken('surface'),
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
