import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ScreenScaffold, PrimaryButton } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { colorToken } from '../ui/tokens';
import { haptic } from '../ui/haptics';
import { nativeConfirm, type ConfirmPort } from '../ui/confirm';
import { exportArchive, type ArchiveExportSource, type ExportNativePort } from './export';
import { driveArchiveAction } from './launch-action';

export type ArchiveExportScreenProps = {
  native: ExportNativePort;
  source: ArchiveExportSource;
  /** Where to write. Supplied by the route, which owns file placement. */
  destinationUri: string;
  confirm?: ConfirmPort;
  /**
   * Launch-environment verb, for driving the export and share sheet on a
   * device. Empty on every normal launch; see `./launch-action`.
   */
  launchAction?: string;
  log?: (category: string, message: string) => void;
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
  launchAction = '',
  log,
}: ArchiveExportScreenProps) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Set once an export succeeds. Until the file is shared it sits in the app's
   * own caches directory, which nothing else on the phone can open - so an
   * export that is never shared has produced nothing the user can use.
   */
  const [exportedUri, setExportedUri] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

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
      setExportedUri(result.destinationUri);
      /*
       * Deliberately no longer reports the destination path. It is inside the
       * app container, so it told the user where a file was that they had no
       * way to open - which read as success while leaving them stuck.
       */
      setStatus(
        `Wrote ${result.entryCount} entries, including ${result.blobCount} image${
          result.blobCount === 1 ? '' : 's'
        }. Save it somewhere you can reach before you leave this screen.`,
      );
    } catch (cause: unknown) {
      haptic('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const share = async (uri: string): Promise<void> => {
    setSharing(true);
    setError(null);
    try {
      const shared = await native.shareFile(uri);
      /*
       * A dismissed sheet is not a failure, but it is also not a save, and
       * saying nothing would leave the earlier success message standing over a
       * file that still has not gone anywhere.
       */
      setStatus(
        shared
          ? 'Saved. The archive has left the app.'
          : 'Not saved yet - the share sheet was dismissed.',
      );
      haptic(shared ? 'success' : 'warning');
    } catch (cause: unknown) {
      haptic('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSharing(false);
    }
  };

  /*
   * Driven from the launch environment, so the share sheet - UIKit presentation
   * that no test can reach - gets exercised on a real device. It deliberately
   * bypasses the confirmation rather than answering it: the warning is a gate
   * for a person, and a driver that could click through it would be a driver
   * that could click through it by accident.
   */
  const driven = useRef(false);
  useEffect(() => {
    if (driven.current || launchAction.trim() === '') return;
    driven.current = true;
    void driveArchiveAction({
      action: launchAction,
      exportArchive: async () => {
        const result = await exportArchive(native, source, destinationUri);
        setExportedUri(result.destinationUri);
        return result.destinationUri;
      },
      shareFile: (uri) => native.shareFile(uri),
      log: log ?? (() => undefined),
    });
  }, [destinationUri, launchAction, log, native, source]);

  return (
    <ScreenScaffold style={styles.container}>
      {/* An export report grows a line per blob and per failure, so this can outgrow the screen. */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {/* The title comes from the native header; see `src/app/routes.ts`. */}

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

      {/*
        The archive is written into the app's caches directory, where it is
        unreachable. This is the only way it leaves the device, so it sits
        directly under the export button rather than anywhere further down.
      */}
      {exportedUri ? (
        <PrimaryButton
          label={sharing ? 'Opening…' : 'Save or send the file'}
          disabled={sharing}
          onPress={() => void share(exportedUri)}
        />
      ) : null}

      {status ? <CaptionText accessibilityRole="summary">{status}</CaptionText> : null}
      {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: 12,
    paddingBottom: 24,
  },
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
