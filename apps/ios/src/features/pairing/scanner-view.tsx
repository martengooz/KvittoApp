import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import type { SettingsFeatureController } from '../settings';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { haptic } from '../../ui/haptics';
import { parsePairingPayload } from './payload';

export type PairingScannerScreenProps = {
  controller: SettingsFeatureController;
  /** False on a simulator, or wherever no camera is available. */
  cameraAvailable: boolean;
  onPaired?: () => void;
};

/**
 * Pairs this device with a server.
 *
 * Manual entry is a first-class path, not a fallback for broken cameras: a
 * simulator has none, a code can be sent in a message, and a camera-only screen
 * would be unusable and untestable. The scanning path shares this exact
 * parsing, so both arrive at the same validation.
 */
export function PairingScannerScreen({ controller, cameraAvailable, onPaired }: PairingScannerScreenProps) {
  const [raw, setRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = parsePairingPayload(raw);
    if (!parsed.ok) {
      haptic('warning');
      setError(parsed.reason);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await controller.setSecureCredentials({ pairingToken: parsed.payload.token });
      await controller.updatePairing({
        serverUrl: parsed.payload.serverUrl,
        paired: true,
        accountHint: parsed.payload.accountId,
        ...(parsed.payload.deviceName ? { deviceName: parsed.payload.deviceName } : {}),
      });
      haptic('success');
      // The token is not kept in component state after this point.
      setRaw('');
      onPaired?.();
    } catch (cause: unknown) {
      haptic('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TitleText accessibilityRole="header">Pair this device</TitleText>

        <View style={styles.card}>
          <CaptionText>Scanning</CaptionText>
          <BodyText>
            {cameraAvailable
              ? 'Point the camera at the pairing code shown in the web app.'
              : 'No camera is available on this device, so paste the pairing code instead.'}
          </BodyText>
          {cameraAvailable ? (
            <CaptionText>
              Live code scanning is not wired up yet; paste the code below in the meantime.
            </CaptionText>
          ) : null}
        </View>

        <View style={styles.card}>
          <CaptionText>Pairing code</CaptionText>
          <TextInput
            accessibilityLabel="Pairing code"
            value={raw}
            onChangeText={(next) => {
              setRaw(next);
              setError(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            placeholder="kvitto://pair?server=…&token=…"
            style={styles.input}
          />
          <CaptionText>
            The code contains a token that lets this device read your receipts. Only paste one
            you generated yourself.
          </CaptionText>
        </View>

        {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}

        <PrimaryButton label={busy ? 'Pairing…' : 'Pair device'} disabled={busy} onPress={() => void submit()} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'stretch', justifyContent: 'flex-start', paddingTop: 12, paddingBottom: 16 },
  scroll: { gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 72,
  },
});
