import { StyleSheet, View } from 'react-native';

import type { PreflightReport } from '@kvitto/archive';
import { ScreenScaffold, PrimaryButton } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { colorToken } from '../ui/tokens';

export type ArchiveResultScreenProps = {
  /** Null when the screen is opened without having run a preflight first. */
  report: PreflightReport | null;
  onStartOver?: () => void;
};

/**
 * What the last preflight concluded.
 *
 * Importing is not wired yet, and this screen says so rather than offering a
 * button that would do nothing: a disabled "Import" with no explanation reads
 * as a bug, and a working-looking one that silently does nothing is worse.
 */
export function ArchiveResultScreen({ report, onStartOver }: ArchiveResultScreenProps) {
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

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">
        {report.ok ? 'Archive is importable' : 'Archive cannot be imported'}
      </TitleText>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Archive result">
        <CaptionText>{`Version: ${report.manifest?.version ?? 'unknown'}`}</CaptionText>
        <CaptionText>{`Entries: ${report.entryCount}`}</CaptionText>
        <CaptionText>{`Blobs: ${report.blobCount}`}</CaptionText>
        <CaptionText>{`Blocking problems: ${errors.length}`}</CaptionText>
      </View>

      {report.ok ? (
        <BodyText>
          Applying an archive is not implemented yet, so nothing on this device has been
          changed. See IOS-NEXT-STEPS.md.
        </BodyText>
      ) : (
        <BodyText accessibilityRole="alert">
          {errors[0]?.message ?? 'The archive was rejected.'}
        </BodyText>
      )}

      {onStartOver ? <PrimaryButton label="Check another archive" onPress={onStartOver} /> : null}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
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
