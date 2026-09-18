import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { PreflightReport } from '@kvitto/archive';
import { ScreenScaffold, PrimaryButton } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { colorToken } from '../ui/tokens';
import { haptic } from '../ui/haptics';
import { nativeConfirm, type ConfirmPort } from '../ui/confirm';
import type { ArchiveApplyResult } from './apply';

export type ArchiveResultScreenProps = {
  /** Null when the screen is opened without having run a preflight first. */
  report: PreflightReport | null;
  /** Applies the archive. Absent means importing is not available here. */
  onApply?: () => Promise<ArchiveApplyResult>;
  onStartOver?: () => void;
  confirm?: ConfirmPort;
};

/**
 * What the last preflight concluded, and the one place an import is started.
 *
 * Import is offered only when the preflight passed. A rejected archive gets no
 * button at all rather than a disabled one: the reason it was rejected is
 * already on screen, and a greyed-out control invites a second guess at it.
 */
export function ArchiveResultScreen({
  report,
  onApply,
  onStartOver,
  confirm = nativeConfirm,
}: ArchiveResultScreenProps) {
  const [applied, setApplied] = useState<ArchiveApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!report) {
    return (
      <ScreenScaffold style={styles.container}>
        <TitleText accessibilityRole="header">No archive checked</TitleText>
        <BodyText>Check an archive first; its result appears here.</BodyText>
        {onStartOver ? <PrimaryButton label="Check an archive" onPress={onStartOver} /> : null}
      </ScreenScaffold>
    );
  }

  const errors = report.issues.filter((issue) => issue.severity === 'error');

  const run = async (): Promise<void> => {
    if (!onApply) return;
    const confirmed = await confirm({
      title: 'Import this archive?',
      message:
        `${report.entryCount} entries and ${report.blobCount} image${report.blobCount === 1 ? '' : 's'} ` +
        'will be merged into this device. Where a receipt exists in both, the newer version wins. ' +
        'Nothing is deleted.',
      confirmLabel: 'Import',
    });
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      const result = await onApply();
      setApplied(result);
      haptic('success');
    } catch (cause: unknown) {
      haptic('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold style={styles.container}>
      {/* A preflight report lists every error and warning the archive produced, so this can outgrow the screen. */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <TitleText accessibilityRole="header">
        {report.ok ? 'Archive is importable' : 'Archive cannot be imported'}
      </TitleText>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Archive result">
        <CaptionText>{`Version: ${report.manifest?.version ?? 'unknown'}`}</CaptionText>
        <CaptionText>{`Entries: ${report.entryCount}`}</CaptionText>
        <CaptionText>{`Blobs: ${report.blobCount}`}</CaptionText>
        <CaptionText>{`Blocking problems: ${errors.length}`}</CaptionText>
      </View>

      {report.ok ? null : (
        <BodyText accessibilityRole="alert">
          {errors[0]?.message ?? 'The archive was rejected.'}
        </BodyText>
      )}

      {applied ? (
        <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Import result">
          <TitleText>Imported</TitleText>
          <CaptionText>{`Created: ${applied.created}`}</CaptionText>
          <CaptionText>{`Updated: ${applied.updated}`}</CaptionText>
          <CaptionText>{`Already up to date: ${applied.unchanged}`}</CaptionText>
          <CaptionText>{`Images stored: ${applied.blobsStored}`}</CaptionText>
        </View>
      ) : null}

      {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}

      {report.ok && onApply && !applied ? (
        <PrimaryButton label={busy ? 'Importing…' : 'Import archive'} disabled={busy} onPress={() => void run()} />
      ) : null}

      {report.ok && !onApply ? (
        <BodyText>Importing is not available on this device.</BodyText>
      ) : null}

      {onStartOver ? <PrimaryButton label="Check another archive" onPress={onStartOver} /> : null}
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
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
});
