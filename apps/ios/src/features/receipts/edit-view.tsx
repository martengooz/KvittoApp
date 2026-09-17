import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import type { Category, ID, Receipt, ReceiptItem, Tag } from '@kvitto/shared/domain';
import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';

const STATUSES: Receipt['status'][] = ['draft', 'parsed', 'confirmed', 'failed'];

/** Rounding on a real receipt is normal, so lines are compared with a tolerance. */
const LINE_TOLERANCE = 0.01;

export type ReceiptEditScreenProps = {
  repository: IosDataRepository;
  receiptId: ID;
  /** Called after a successful save, so the route can dismiss the modal. */
  onDone?: () => void;
};

type Loaded = {
  receipt: Receipt;
  items: ReceiptItem[];
  categories: Category[];
  tags: Tag[];
  tagIds: ID[];
};

type Draft = {
  merchantName: string;
  purchasedAt: string;
  notes: string;
  status: Receipt['status'];
  categoryId: ID | null;
  tagIds: ID[];
};

/** Parses a typed amount. Blank means "not stated", which is not the same as 0. */
function parseAmount(raw: string): number | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed.length === 0) return null;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : null;
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${label}${selected ? ', selected' : ''}`}
      onPress={onPress}
      style={[styles.chip, selected ? styles.chipSelected : null]}
    >
      <CaptionText>{label}</CaptionText>
    </Pressable>
  );
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

/**
 * The full receipt editor.
 *
 * The detail screen deliberately does not edit these fields: two screens
 * writing the same receipt is how they drift apart. Detail shows and this
 * saves.
 */
export function ReceiptEditScreen({ repository, receiptId, onDone }: ReceiptEditScreenProps) {
  const [loaded, setLoaded] = useState<Loaded | null | 'missing'>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const receipt = await repository.getReceipt(receiptId);
    if (!receipt || receipt.deletedAt !== 0) {
      setLoaded('missing');
      return;
    }

    const [items, categories, tags] = await Promise.all([
      repository.listReceiptItems(receiptId),
      repository.listCategories(),
      repository.listTags(),
    ]);
    const tagIds = await repository.listTagIdsForReceipt(receiptId);

    setLoaded({ receipt, items, categories, tags, tagIds });
    // The draft is seeded once; reloading must not discard what is being typed.
    setDraft((current) =>
      current ?? {
        merchantName: receipt.merchant.name ?? '',
        purchasedAt: receipt.purchasedAt ?? '',
        notes: receipt.notes ?? '',
        status: receipt.status,
        categoryId: receipt.categoryId,
        tagIds,
      },
    );
  }, [receiptId, repository]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      void load().catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };

    run();
    const unsubscribe = repository.subscribe((event) => {
      if (cancelled) return;
      if (event.kinds.includes('items') || event.kinds.includes('receipts')) run();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [load, repository]);

  const patchDraft = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const save = async (): Promise<void> => {
    if (!draft || loaded === null || loaded === 'missing') return;
    setSaving(true);
    setError(null);
    try {
      await repository.updateReceipt(receiptId, {
        merchant: { ...loaded.receipt.merchant, name: draft.merchantName.trim() || null },
        purchasedAt: draft.purchasedAt.trim() || null,
        notes: draft.notes.trim() || null,
        status: draft.status,
        categoryId: draft.categoryId,
      });
      await repository.setReceiptTags(receiptId, draft.tagIds);
      onDone?.();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (loaded === 'missing') {
    return (
      <ScreenScaffold style={styles.container}>
        <TitleText accessibilityRole="header">Receipt unavailable</TitleText>
        <BodyText>This receipt has been deleted, or it does not exist on this device.</BodyText>
      </ScreenScaffold>
    );
  }

  if (loaded === null || draft === null) {
    return (
      <ScreenScaffold style={styles.container}>
        <BodyText accessibilityRole="progressbar">Loading receipt…</BodyText>
      </ScreenScaffold>
    );
  }

  const itemSum = loaded.items.reduce((total, item) => total + item.totalPrice, 0);
  const receiptTotal = loaded.receipt.total;
  const sumMismatch =
    receiptTotal !== null && Math.abs(itemSum - receiptTotal) > LINE_TOLERANCE;

  return (
    <ScreenScaffold style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TitleText accessibilityRole="header">Edit receipt</TitleText>
        {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}

        <View style={styles.card}>
          <CaptionText>Merchant</CaptionText>
          <TextInput
            accessibilityLabel="Merchant name"
            value={draft.merchantName}
            onChangeText={(merchantName) => patchDraft({ merchantName })}
            style={styles.input}
          />
          <CaptionText>Purchased at (ISO timestamp)</CaptionText>
          <TextInput
            accessibilityLabel="Purchase date time"
            value={draft.purchasedAt}
            autoCapitalize="none"
            onChangeText={(purchasedAt) => patchDraft({ purchasedAt })}
            style={styles.input}
          />
          <CaptionText>Notes</CaptionText>
          <TextInput
            accessibilityLabel="Receipt notes"
            value={draft.notes}
            multiline
            onChangeText={(notes) => patchDraft({ notes })}
            style={styles.input}
          />
        </View>

        <View style={styles.card}>
          <CaptionText>Status</CaptionText>
          <View style={styles.chipRow}>
            {STATUSES.map((status) => (
              <Chip
                key={status}
                label={status}
                selected={draft.status === status}
                onPress={() => patchDraft({ status })}
              />
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <CaptionText>Category</CaptionText>
          <View style={styles.chipRow}>
            <Chip
              label="Uncategorised"
              selected={draft.categoryId === null}
              onPress={() => patchDraft({ categoryId: null })}
            />
            {loaded.categories.map((category) => (
              <Chip
                key={category.id}
                label={category.name}
                selected={draft.categoryId === category.id}
                onPress={() => patchDraft({ categoryId: category.id })}
              />
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <CaptionText>Tags</CaptionText>
          {loaded.tags.length === 0 ? (
            <CaptionText>No tags yet. Create one from Settings.</CaptionText>
          ) : (
            <View style={styles.chipRow}>
              {loaded.tags.map((tag) => (
                <Chip
                  key={tag.id}
                  label={tag.name}
                  selected={draft.tagIds.includes(tag.id)}
                  onPress={() => patchDraft({ tagIds: toggle(draft.tagIds, tag.id) })}
                />
              ))}
            </View>
          )}
        </View>

        <TitleText accessibilityRole="header">{`Line items (${loaded.items.length})`}</TitleText>
        {sumMismatch ? (
          /*
           * A printed receipt can legitimately disagree with the sum of its
           * lines - rounding, a missed line, a discount applied to the whole
           * basket. Silently rewriting the total would destroy evidence of what
           * was actually printed, so the difference is reported and left alone.
           */
          <CaptionText accessibilityRole="alert">
            {`Line items add up to ${itemSum.toFixed(2)}, but the receipt total is ${receiptTotal.toFixed(2)}.`}
          </CaptionText>
        ) : null}

        {loaded.items.length === 0 ? (
          <CaptionText>No line items on this receipt.</CaptionText>
        ) : (
          loaded.items.map((item) => (
            <LineItemRow key={item.id} item={item} repository={repository} onError={setError} />
          ))
        )}

        <PrimaryButton
          label="Add line item"
          onPress={() => {
            void repository.addItem(receiptId).catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : String(cause));
            });
          }}
        />

        <View style={styles.actionRow}>
          <PrimaryButton label={saving ? 'Saving…' : 'Save receipt'} disabled={saving} onPress={() => void save()} />
          <PrimaryButton label="Cancel" disabled={saving} onPress={() => onDone?.()} />
        </View>
      </ScrollView>
    </ScreenScaffold>
  );
}

/**
 * One editable line. Its fields are written on blur rather than on every
 * keystroke, so a half-typed "1" on the way to "12.50" is never persisted.
 */
function LineItemRow({
  item,
  repository,
  onError,
}: {
  item: ReceiptItem;
  repository: IosDataRepository;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [unitPrice, setUnitPrice] = useState(item.unitPrice === null ? '' : String(item.unitPrice));
  const [totalPrice, setTotalPrice] = useState(String(item.totalPrice));

  const commit = (patch: Partial<ReceiptItem>) => {
    void repository.updateItem(item.id, patch).catch((cause: unknown) => {
      onError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const quantityValue = parseAmount(quantity);
  const unitPriceValue = parseAmount(unitPrice);
  const totalValue = parseAmount(totalPrice);
  const lineMismatch =
    quantityValue !== null &&
    unitPriceValue !== null &&
    totalValue !== null &&
    Math.abs(quantityValue * unitPriceValue - totalValue) > LINE_TOLERANCE;

  return (
    <View style={styles.card}>
      <TextInput
        accessibilityLabel={`Item name, line ${item.lineNo + 1}`}
        value={name}
        onChangeText={setName}
        onBlur={() => commit({ name })}
        style={styles.input}
      />
      <View style={styles.pairRow}>
        <View style={styles.pairInput}>
          <CaptionText>Quantity</CaptionText>
          <TextInput
            accessibilityLabel={`Item quantity, line ${item.lineNo + 1}`}
            value={quantity}
            keyboardType="decimal-pad"
            onChangeText={setQuantity}
            onBlur={() => commit({ quantity: quantityValue ?? item.quantity })}
            style={styles.input}
          />
        </View>
        <View style={styles.pairInput}>
          <CaptionText>Unit price</CaptionText>
          <TextInput
            accessibilityLabel={`Item unit price, line ${item.lineNo + 1}`}
            value={unitPrice}
            keyboardType="decimal-pad"
            onChangeText={setUnitPrice}
            onBlur={() => commit({ unitPrice: unitPriceValue })}
            style={styles.input}
          />
        </View>
        <View style={styles.pairInput}>
          <CaptionText>Total</CaptionText>
          <TextInput
            accessibilityLabel={`Item total, line ${item.lineNo + 1}`}
            value={totalPrice}
            keyboardType="decimal-pad"
            onChangeText={setTotalPrice}
            onBlur={() => commit({ totalPrice: totalValue ?? item.totalPrice })}
            style={styles.input}
          />
        </View>
      </View>

      {lineMismatch ? (
        <CaptionText accessibilityRole="alert">
          {`Quantity times unit price is ${(quantityValue * unitPriceValue).toFixed(2)}, not ${totalValue.toFixed(2)}.`}
        </CaptionText>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove line ${item.lineNo + 1}, ${item.name}`}
        onPress={() => {
          void repository.deleteItem(item.id).catch((cause: unknown) => {
            onError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
        style={({ pressed }) => [styles.smallButton, pressed ? styles.chipSelected : null]}
      >
        <CaptionText style={styles.dangerLabel}>Remove line</CaptionText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingTop: 12,
    paddingBottom: 16,
  },
  scroll: {
    gap: 12,
    paddingBottom: 24,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pairRow: {
    flexDirection: 'row',
    gap: 8,
  },
  pairInput: {
    flexGrow: 1,
    flexBasis: 0,
    gap: 4,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipSelected: {
    backgroundColor: colorToken('surfaceSecondary'),
  },
  smallButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  dangerLabel: {
    color: colorToken('danger'),
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
