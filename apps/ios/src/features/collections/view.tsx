import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { useCollectionsFeatureController, type CollectionSummaryRow } from './controller';

export type CollectionsFeatureScreenProps = {
  repository: IosDataRepository;
};

export function CollectionsFeatureScreen({ repository }: CollectionsFeatureScreenProps) {
  const { state } = useCollectionsFeatureController(repository);

  return (
    <ScreenScaffold style={styles.container}>
      {/* The title comes from the tab's native header; see `src/app/tabs.ts`. */}
      {state.error ? <BodyText accessibilityRole="alert">{state.error}</BodyText> : null}
      {state.loading ? <CaptionText accessibilityRole="progressbar">Loading summaries…</CaptionText> : null}

      <SummaryList title="By month" rows={state.byMonth} />
      <SummaryList title="By category" rows={state.byCategory} />
      <SummaryList title="By merchant" rows={state.byMerchant} />
      <SummaryList title="By tag" rows={state.byTag} />
    </ScreenScaffold>
  );
}

type SummaryListProps = {
  title: string;
  rows: CollectionSummaryRow[];
};

function SummaryList({ title, rows }: SummaryListProps) {
  return (
    <View style={styles.card} accessibilityRole="summary" accessibilityLabel={`${title} summary`}>
      <TitleText>{title}</TitleText>
      {rows.length === 0 ? (
        <CaptionText>No summary rows.</CaptionText>
      ) : (
        <FlashList
          accessibilityLabel={`${title} list`}
          data={rows}
          keyExtractor={(item) => item.key}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <BodyText>{item.label}</BodyText>
              <CaptionText>{`${item.total.toFixed(2)} (${item.count})`}</CaptionText>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingTop: 12,
    paddingBottom: 16,
    gap: 10,
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 2,
  },
});
