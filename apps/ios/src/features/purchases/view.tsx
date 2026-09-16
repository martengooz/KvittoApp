import { FlatList, Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useState } from 'react';

import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { usePurchasesFeatureController } from './controller';

export type PurchasesFeatureScreenProps = {
  repository: IosDataRepository;
};

export function PurchasesFeatureScreen({ repository }: PurchasesFeatureScreenProps) {
  const [includeDiscounts, setIncludeDiscounts] = useState(false);
  const { state, actions } = usePurchasesFeatureController(repository);

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">Purchases</TitleText>
      <TextInput
        accessibilityLabel="Global item search"
        placeholder="Search purchased items"
        value={state.queryInput}
        onChangeText={actions.setQuery}
        style={styles.input}
      />

      <View style={styles.toggleRow}>
        <CaptionText>Include discount rows</CaptionText>
        <Switch
          accessibilityLabel="Include discounts"
          value={includeDiscounts}
          onValueChange={(value) => {
            setIncludeDiscounts(value);
            void actions.setIncludeDiscounts(value);
          }}
        />
      </View>

      {state.rows.length === 0 && !state.loading ? (
        <BodyText accessibilityRole="summary">No matching purchase rows.</BodyText>
      ) : (
        <FlatList
          accessibilityLabel="Global purchases list"
          accessibilityHint="Shows item rows without loading image blobs"
          data={state.rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={styles.listContent}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            void actions.loadNextPage();
          }}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.priceLabel}, ${item.purchasedAtLabel}`}
              onPress={() => actions.selectSearchName(item.searchName)}
              style={styles.row}
            >
              <BodyText>{item.name}</BodyText>
              <CaptionText>{`${item.priceLabel} • ${item.merchantName}`}</CaptionText>
              <CaptionText>{item.purchasedAtLabel}</CaptionText>
            </Pressable>
          )}
          ListFooterComponent={state.loading ? <CaptionText accessibilityRole="progressbar">Loading purchases…</CaptionText> : null}
        />
      )}

      {state.priceHistory.length > 0 ? (
        <View style={styles.historyCard} accessibilityRole="summary" accessibilityLabel="Price history">
          <TitleText>Price history</TitleText>
          {state.priceHistory.map((point) => (
            <CaptionText key={`${point.merchantName}:${point.purchasedAt ?? 'unknown'}:${point.price}`}>
              {`${point.purchasedAt?.slice(0, 10) ?? 'Unknown'} • ${point.price.toFixed(2)} • ${point.merchantName}`}
            </CaptionText>
          ))}
        </View>
      ) : null}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingTop: 12,
    gap: 10,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    borderRadius: 10,
    backgroundColor: colorToken('surface'),
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listContent: {
    gap: 8,
    paddingBottom: 12,
  },
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  historyCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
});
