import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';

import type { ID } from '@kvitto/shared/domain';
import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { ReceiptsFeatureController, type ReceiptEditorState } from './controller';

export type ReceiptDetailScreenProps = {
  repository: IosDataRepository;
  receiptId: ID;
  /** Called after the receipt is deleted, so the route can pop back to the list. */
  onDeleted?: () => void;
  onOpenExtraction?: () => void;
  onOpenOcr?: () => void;
};

/**
 * Loads one receipt's details without touching the list query. The list
 * controller already owns this loading and its invariants, so it is reused
 * here rather than duplicated; only `selectReceipt` is driven.
 */
function useReceiptDetails(repository: IosDataRepository, receiptId: ID) {
  const controller = useMemo(() => new ReceiptsFeatureController(repository), [repository]);

  const state = useSyncExternalStore(
    useCallback((listener) => controller.subscribe(listener), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
    useCallback(() => controller.getSnapshot(), [controller]),
  );

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      await controller.selectReceipt(receiptId);
      if (!cancelled) setLoading(false);
    };
    void load();

    const unsubscribe = repository.subscribe((event) => {
      if (!event.kinds.some((kind) => ['receipts', 'items', 'categories', 'tags', 'receiptTags'].includes(kind))) {
        return;
      }
      void controller.selectReceipt(receiptId);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [controller, repository, receiptId]);

  return { controller, details: state.details, loading };
}

export function ReceiptDetailScreen({
  repository,
  receiptId,
  onDeleted,
  onOpenExtraction,
  onOpenOcr,
}: ReceiptDetailScreenProps) {
  const { controller, details, loading } = useReceiptDetails(repository, receiptId);
  const [editor, setEditor] = useState<ReceiptEditorState | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setEditor(details?.editor ?? null);
  }, [details?.editor]);

  const run = useCallback(async (label: string, work: () => Promise<void>) => {
    setStatus(null);
    try {
      await work();
      setStatus(label);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  if (loading) {
    return (
      <ScreenScaffold style={styles.container}>
        <BodyText accessibilityRole="progressbar">Loading receipt…</BodyText>
      </ScreenScaffold>
    );
  }

  if (!details || !editor) {
    return (
      <ScreenScaffold style={styles.container}>
        <TitleText accessibilityRole="header">Receipt unavailable</TitleText>
        <BodyText>This receipt has been deleted, or it does not exist on this device.</BodyText>
      </ScreenScaffold>
    );
  }

  const categoryName =
    details.categories.find((category) => category.id === editor.categoryId)?.name ?? 'Uncategorised';
  const tagNames = details.tags
    .filter((tag) => editor.tagIds.includes(tag.id))
    .map((tag) => tag.name);

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">{editor.merchantName || 'Unknown merchant'}</TitleText>

      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Receipt provenance">
        <CaptionText>{`Source: ${details.provenance.source}`}</CaptionText>
        <CaptionText>{`Status: ${details.provenance.status}`}</CaptionText>
        <CaptionText>{`Review: ${details.provenance.reviewState}`}</CaptionText>
        <CaptionText>{`Category: ${categoryName}`}</CaptionText>
        <CaptionText>{`Tags: ${tagNames.length > 0 ? tagNames.join(', ') : 'none'}`}</CaptionText>
        <CaptionText>{`Extraction warnings: ${details.provenance.extractionWarningCount}`}</CaptionText>
      </View>

      <View style={styles.card}>
        <CaptionText>Merchant</CaptionText>
        <TextInput
          accessibilityLabel="Merchant name"
          value={editor.merchantName}
          onChangeText={(merchantName) => setEditor((current) => (current ? { ...current, merchantName } : current))}
          style={styles.input}
        />
        <CaptionText>Purchased at</CaptionText>
        <TextInput
          accessibilityLabel="Purchase date time"
          value={editor.purchasedAt}
          onChangeText={(purchasedAt) => setEditor((current) => (current ? { ...current, purchasedAt } : current))}
          style={styles.input}
        />
        <CaptionText>Notes</CaptionText>
        <TextInput
          accessibilityLabel="Receipt notes"
          value={editor.notes}
          onChangeText={(notes) => setEditor((current) => (current ? { ...current, notes } : current))}
          style={styles.input}
        />
      </View>

      <View style={styles.actionRow}>
        <PrimaryButton
          label="Save receipt"
          onPress={() => {
            void run('Saved.', () => controller.saveReceiptEdits(editor));
          }}
        />
        <PrimaryButton
          label="Mark reviewed"
          onPress={() => {
            void run('Marked reviewed.', () => controller.markReviewed(receiptId));
          }}
        />
      </View>

      <View style={styles.actionRow}>
        <PrimaryButton
          label="Delete receipt"
          onPress={() => {
            void run('Deleted.', async () => {
              await controller.deleteReceipt(receiptId);
              onDeleted?.();
            });
          }}
        />
        {onOpenExtraction ? <PrimaryButton label="Extraction" onPress={onOpenExtraction} /> : null}
        {onOpenOcr ? <PrimaryButton label="OCR text" onPress={onOpenOcr} /> : null}
      </View>

      {status ? <CaptionText accessibilityRole="alert">{status}</CaptionText> : null}
      {details.error ? <BodyText accessibilityRole="alert">{details.error}</BodyText> : null}

      <TitleText accessibilityRole="header">{`Items (${details.items.length})`}</TitleText>
      {details.items.length === 0 ? (
        <CaptionText>No line items on this receipt.</CaptionText>
      ) : (
        <View style={styles.list}>
          <FlashList
            accessibilityLabel="Receipt line items"
            data={details.items}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.name}, ${item.totalPrice}`}
                style={styles.itemRow}
              >
                <BodyText>{item.name}</BodyText>
                <CaptionText>{String(item.totalPrice)}</CaptionText>
              </Pressable>
            )}
          />
        </View>
      )}
    </ScreenScaffold>
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
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  list: {
    minHeight: 120,
    flexGrow: 1,
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colorToken('surfaceSecondary'),
  },
});
