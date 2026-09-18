import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { preflightArchive, type PreflightIssue, type PreflightReport } from '@kvitto/archive';
import { ScreenScaffold, PrimaryButton } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { colorToken } from '../ui/tokens';
import { haptic } from '../ui/haptics';
import { createNativeArchiveEntrySource, type ArchiveNativePort } from './native-entry-source';

export type ArchivePreflightScreenProps = {
  native: ArchiveNativePort;
  /** Pre-filled when the caller already has a file, e.g. from a picker. */
  initialFileUri?: string;
  /** Handed the report and the file it describes, so the route can apply it. */
  onReport?: (report: PreflightReport, fileUri: string) => void;
};

function IssueRow({ issue }: { issue: PreflightIssue }) {
  return (
    <View style={styles.issue}>
      <CaptionText style={issue.severity === 'error' ? styles.error : undefined}>
        {`${issue.severity}: ${issue.code}`}
      </CaptionText>
      <BodyText>{issue.message}</BodyText>
      {issue.path ? <CaptionText>{issue.path}</CaptionText> : null}
    </View>
  );
}

/**
 * Inspects a `.kvitto` archive and reports what importing it would do, without
 * changing anything. Requirement 6 of section 14: a preflight report comes
 * before any change is applied.
 */
export function ArchivePreflightScreen({ native, initialFileUri, onReport }: ArchivePreflightScreenProps) {
  const [fileUri, setFileUri] = useState(initialFileUri ?? '');
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    const trimmed = fileUri.trim();
    if (trimmed.length === 0) {
      setError('Choose an archive file first.');
      return;
    }

    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const source = createNativeArchiveEntrySource(native, trimmed);
      const next = await preflightArchive(source);
      setReport(next);
      haptic(next.ok ? 'success' : 'warning');
      onReport?.(next, trimmed);
    } catch (cause: unknown) {
      haptic('error');
      // A file that is not a ZIP at all throws rather than reporting issues,
      // so it needs saying in words instead of an empty report.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [fileUri, native, onReport]);

  const errors = report?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const warnings = report?.issues.filter((issue) => issue.severity === 'warning') ?? [];

  return (
    <ScreenScaffold style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TitleText accessibilityRole="header">Import archive</TitleText>
        <CaptionText>
          Nothing is imported by this screen. It reads the archive and reports what would
          change.
        </CaptionText>

        <View style={styles.card}>
          <CaptionText>Archive file URI</CaptionText>
          <TextInput
            accessibilityLabel="Archive file URI"
            value={fileUri}
            onChangeText={setFileUri}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="file:///…/export.kvitto"
            style={styles.input}
          />
        </View>

        <PrimaryButton
          label={busy ? 'Checking…' : 'Check archive'}
          disabled={busy}
          onPress={() => void run()}
        />

        {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}

        {report ? (
          <>
            <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Preflight summary">
              <TitleText>{report.ok ? 'Archive can be imported' : 'Archive was rejected'}</TitleText>
              <CaptionText>{`Version: ${report.manifest?.version ?? 'unknown'}`}</CaptionText>
              <CaptionText>{`Entries: ${report.entryCount}`}</CaptionText>
              <CaptionText>{`Uncompressed: ${report.totalUncompressedBytes} bytes`}</CaptionText>
              <CaptionText>{`Blobs: ${report.blobCount}`}</CaptionText>
              {Object.entries(report.entityCounts).map(([kind, count]) => (
                <CaptionText key={kind}>{`${kind}: ${count ?? 0}`}</CaptionText>
              ))}
            </View>

            <TitleText accessibilityRole="header">{`Errors (${errors.length})`}</TitleText>
            {errors.length === 0 ? (
              <CaptionText>No blocking problems were found.</CaptionText>
            ) : (
              <View style={styles.card}>
                {errors.map((issue, index) => (
                  <IssueRow key={`${issue.code}-${issue.path ?? index}`} issue={issue} />
                ))}
              </View>
            )}

            <TitleText accessibilityRole="header">{`Warnings (${warnings.length})`}</TitleText>
            {warnings.length === 0 ? (
              <CaptionText>No warnings.</CaptionText>
            ) : (
              <View style={styles.card}>
                {warnings.map((issue, index) => (
                  <IssueRow key={`${issue.code}-${issue.path ?? index}`} issue={issue} />
                ))}
              </View>
            )}
          </>
        ) : null}
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
  },
  issue: { gap: 2 },
  error: { color: colorToken('danger') },
});
