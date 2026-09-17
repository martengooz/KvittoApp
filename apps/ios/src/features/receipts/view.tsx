import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';

import { FlashList } from '@shopify/flash-list';

import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { useReceiptsFeatureController, type ReceiptEditorState } from './controller';

export type ReceiptsFeatureScreenProps = {
  repository: IosDataRepository;
  /**
   * Supplied by the route to push the receipt detail screen. Without it the
   * list falls back to selecting in place, which keeps the screen usable (and
   * testable) without a navigator.
   */
  onOpenReceipt?: (receiptId: string) => void;
};

export function ReceiptsFeatureScreen({ repository, onOpenReceipt }: ReceiptsFeatureScreenProps) {
  const { state, queryInput, actions } = useReceiptsFeatureController(repository);
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);

  const selected = useMemo(
    () => state.details,
    [state.details],
  );

  useEffect(() => {
    actions.setNeedsReviewOnly(needsReviewOnly);
  }, [actions, needsReviewOnly]);

  return (
    <ScreenScaffold style={styles.container}>
      <View style={styles.header}>
        <TitleText accessibilityRole="header">Receipts</TitleText>
        <TextInput
          accessibilityLabel="Search receipts"
          accessibilityHint="Filters receipt list by merchant, notes and item names"
          placeholder="Search receipts"
          value={queryInput}
          onChangeText={actions.setQuery}
          style={styles.searchInput}
        />
        <View style={styles.filterRow}>
          <CaptionText>Needs review only</CaptionText>
          <Switch
            accessibilityLabel="Needs review only"
            value={needsReviewOnly}
            onValueChange={setNeedsReviewOnly}
          />
        </View>
      </View>

      {state.list.error ? (
        <BodyText accessibilityRole="alert">{state.list.error}</BodyText>
      ) : null}

      {state.list.rows.length === 0 && !state.list.loading ? (
        <BodyText accessibilityRole="summary">{state.list.emptyMessage}</BodyText>
      ) : (
        <FlashList
          accessibilityLabel="Receipts list"
          accessibilityHint="Double tap a row to open receipt details"
          data={state.list.rows}
          keyExtractor={(item) => item.id}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            void actions.loadNextPage();
          }}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.accessibilityLabel}
              onPress={() => {
                if (onOpenReceipt) {
                  onOpenReceipt(item.id);
                  return;
                }
                void actions.selectReceipt(item.id);
              }}
              style={styles.row}
            >
              <View style={styles.rowTop}>
                <BodyText>{item.merchantName}</BodyText>
                <CaptionText>{item.totalLabel}</CaptionText>
              </View>
              <CaptionText>{item.purchasedAtLabel}</CaptionText>
              <CaptionText>
                {item.status}
                {item.needsReview ? ' • needs review' : ''}
                {item.hasThumbnail ? ' • has thumbnail' : ' • no image loaded'}
              </CaptionText>
            </Pressable>
          )}
          ListFooterComponent={
            state.list.loading ? <CaptionText accessibilityRole="progressbar">Loading receipts…</CaptionText> : null
          }
        />
      )}

      {selected ? (
        <ReceiptDetailsCard
          details={selected}
          onSave={actions.saveReceiptEdits}
          onMarkReviewed={() => {
            void actions.markReviewed(selected.receiptId);
          }}
          onDelete={() => {
            void actions.deleteReceipt(selected.receiptId);
          }}
          onUndoDelete={() => {
            void actions.undoDelete();
          }}
        />
      ) : null}
    </ScreenScaffold>
  );
}

type DetailsCardProps = {
  details: NonNullable<ReturnType<typeof useReceiptsFeatureController>['state']['details']>;
  onSave: (editor: ReceiptEditorState) => Promise<void>;
  onMarkReviewed: () => void;
  onDelete: () => void;
  onUndoDelete: () => void;
};

function ReceiptDetailsCard({ details, onSave, onMarkReviewed, onDelete, onUndoDelete }: DetailsCardProps) {
  const [editor, setEditor] = useState<ReceiptEditorState>(details.editor);

  useEffect(() => {
    setEditor(details.editor);
  }, [details.editor]);

  return (
    <View style={styles.detailsCard} accessibilityRole="summary">
      <TitleText>Receipt details</TitleText>
      <CaptionText>{`Source: ${details.provenance.source}`}</CaptionText>
      <CaptionText>{`Review: ${details.provenance.reviewState}`}</CaptionText>
      <CaptionText>{`Extraction warnings: ${details.provenance.extractionWarningCount}`}</CaptionText>

      <TextInput
        accessibilityLabel="Merchant name"
        value={editor.merchantName}
        onChangeText={(merchantName) => setEditor((current) => ({ ...current, merchantName }))}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Purchase date time"
        value={editor.purchasedAt}
        onChangeText={(purchasedAt) => setEditor((current) => ({ ...current, purchasedAt }))}
        style={styles.input}
      />
      <TextInput
        accessibilityLabel="Receipt notes"
        value={editor.notes}
        onChangeText={(notes) => setEditor((current) => ({ ...current, notes }))}
        style={styles.input}
      />

      <View style={styles.actionRow}>
        <PrimaryButton
          label="Save receipt"
          onPress={() => {
            void onSave(editor);
          }}
        />
        <PrimaryButton label="Mark reviewed" onPress={onMarkReviewed} />
      </View>
      <View style={styles.actionRow}>
        <PrimaryButton label="Delete receipt" onPress={onDelete} />
        {details.canUndoDelete ? <PrimaryButton label="Undo delete" onPress={onUndoDelete} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingTop: 12,
    paddingBottom: 16,
    gap: 12,
  },
  header: {
    gap: 8,
  },
  searchInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  listContent: {
    gap: 8,
    paddingBottom: 12,
  },
  row: {
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  detailsCard: {
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    padding: 12,
    gap: 8,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: colorToken('background'),
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
});
