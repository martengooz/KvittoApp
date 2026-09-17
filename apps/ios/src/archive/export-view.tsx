import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ScreenScaffold, PrimaryButton } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { colorToken } from '../ui/tokens';
import { haptic } from '../ui/haptics';
import { nativeConfirm, type ConfirmPort } from '../ui/confirm';
import { exportArchive, type ArchiveExportSource, type ExportNativePort } from './export';

export type ArchiveExportScreenProps = {
  native: ExportNativePort;
  source: ArchiveExportSource;
  /** Where to write. Supplied by the route, which owns file placement. */
  destinationUri: string;
  confirm?: ConfirmPort;
};

/**
 * Exports everything on this device into one `.kvitto` file.
 *
 * Section 14 requires the export UI to warn that the contents are sensitive and
 * that v1 archives are not encrypted. That warning is both on the screen and in
 * the confirmation, because the screen can be skimmed and the confirmation
 * cannot.
 */
export function ArchiveExportScreen({
  native,
  source,
  destinationUri,
  confirm = nativeConfirm,
}: ArchiveExportScreenProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Export an unencrypted archive?',
      message:
        'The file will contain your receipt images and financial data, and version 1 archives are not password-protected. Anyone who gets the file can read all of it.',
      confirmLabel: 'Export anyway',
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const result = await exportArchive(native, source, destinationUri);
      haptic('success');
      setStatus(
        `Wrote ${result.entryCount} entries, including ${result.blobCount} image${
          result.blobCount === 1 ? '' : 's'
        }, to ${result.destinationUri}`,
      );
    } catch (cause: unknown) {
      haptic('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">Export archive</TitleText>

      <View style={styles.card} accessibilityRole="alert" accessibilityLabel="Export sensitivity warning">
        <TitleText>This file is sensitive</TitleText>
        <BodyText>
          The archive contains your receipt images and financial data. Version 1 archives are
          not password-protected, so anyone who gets the file can read all of it.
        </BodyText>
        <CaptionText>
          API keys, pairing tokens and device identifiers are left out.
        </CaptionText>
      </View>

      <PrimaryButton label={busy ? 'Exporting…' : 'Export archive'} disabled={busy} onPress={() => void run()} />

      {status ? <CaptionText accessibilityRole="summary">{status}</CaptionText> : null}
      {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'stretch', justifyContent: 'flex-start', paddingTop: 12, gap: 12 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('danger'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
});
