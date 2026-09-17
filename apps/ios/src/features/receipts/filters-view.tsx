import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';

import type { Category, Receipt } from '@kvitto/shared/domain';
import type { IosDataRepository, ReceiptFilter } from '../../data/repository';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { countActiveFilters, type ReceiptFilterStore } from './filter-store';

const STATUSES: Receipt['status'][] = ['draft', 'parsed', 'confirmed', 'failed'];

export type ReceiptFiltersScreenProps = {
  repository: IosDataRepository;
  filterStore: ReceiptFilterStore;
  /** Called after Apply or Clear, so the route can dismiss the modal. */
  onDone?: () => void;
};

/** Parses a user-typed amount, treating blank and nonsense alike as "no bound". */
function parseAmount(raw: string): number | undefined {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed.length === 0) return undefined;
  const value = Number.parseFloat(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Keeps a typed date only when it is a complete `YYYY-MM-DD`. */
function parseDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
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

export function ReceiptFiltersScreen({ repository, filterStore, onDone }: ReceiptFiltersScreenProps) {
  const initial = useMemo(() => filterStore.getFilter(), [filterStore]);

  const [from, setFrom] = useState(initial.from ?? '');
  const [to, setTo] = useState(initial.to ?? '');
  const [minTotal, setMinTotal] = useState(initial.minTotal === undefined ? '' : String(initial.minTotal));
  const [maxTotal, setMaxTotal] = useState(initial.maxTotal === undefined ? '' : String(initial.maxTotal));
  const [statuses, setStatuses] = useState<Receipt['status'][]>(initial.statuses ?? []);
  const [categoryIds, setCategoryIds] = useState<string[]>(initial.categoryIds ?? []);
  const [needsReview, setNeedsReview] = useState(initial.needsReview ?? false);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const out: Category[] = [];
      let cursor = -1;
      while (true) {
        const page = await repository.list('categories', { cursor, limit: 300 });
        for (const row of page.items) {
          if (row.deletedAt === 0) out.push(row);
        }
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      if (!cancelled) setCategories(out.sort((a, b) => a.sortOrder - b.sortOrder));
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const draft: ReceiptFilter = {
    from: parseDate(from),
    to: parseDate(to),
    minTotal: parseAmount(minTotal),
    maxTotal: parseAmount(maxTotal),
    statuses: statuses.length > 0 ? statuses : undefined,
    categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
    needsReview: needsReview ? true : undefined,
  };

  const activeCount = countActiveFilters(draft);
  const rangeInverted =
    draft.minTotal !== undefined && draft.maxTotal !== undefined && draft.minTotal > draft.maxTotal;
  const datesInverted = draft.from !== undefined && draft.to !== undefined && draft.from > draft.to;

  return (
    <ScreenScaffold style={styles.container}>
      {/*
        The category chips grow with the user's taxonomy - nineteen by default -
        so this content is taller than the screen and was clipping Apply and
        Clear off the bottom, where they could not be reached at all.
        Everything, actions included, scrolls together. A pinned footer would
        keep them permanently in view, but inside a form sheet the scroll area
        above it did not clip to its bounds and painted over the buttons; one
        scrolling column is simpler and behaves at every detent.
      */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <TitleText accessibilityRole="header">Filters</TitleText>
        <CaptionText>{activeCount === 0 ? 'No filters applied.' : `${activeCount} filters applied.`}</CaptionText>

        <View style={styles.card}>
          <CaptionText>Purchased between (YYYY-MM-DD)</CaptionText>
          <View style={styles.pairRow}>
            <TextInput
              accessibilityLabel="Purchased from date"
              placeholder="from"
              value={from}
              onChangeText={setFrom}
              autoCapitalize="none"
              style={[styles.input, styles.pairInput]}
            />
            <TextInput
              accessibilityLabel="Purchased to date"
              placeholder="to"
              value={to}
              onChangeText={setTo}
              autoCapitalize="none"
              style={[styles.input, styles.pairInput]}
            />
          </View>
          {datesInverted ? (
            <CaptionText accessibilityRole="alert">The start date is after the end date.</CaptionText>
          ) : null}
        </View>

        <View style={styles.card}>
          <CaptionText>Total between</CaptionText>
          <View style={styles.pairRow}>
            <TextInput
              accessibilityLabel="Minimum total"
              placeholder="min"
              value={minTotal}
              onChangeText={setMinTotal}
              keyboardType="decimal-pad"
              style={[styles.input, styles.pairInput]}
            />
            <TextInput
              accessibilityLabel="Maximum total"
              placeholder="max"
              value={maxTotal}
              onChangeText={setMaxTotal}
              keyboardType="decimal-pad"
              style={[styles.input, styles.pairInput]}
            />
          </View>
          {rangeInverted ? (
            <CaptionText accessibilityRole="alert">The minimum is greater than the maximum.</CaptionText>
          ) : null}
        </View>

        <View style={styles.card}>
          <CaptionText>Status</CaptionText>
          <View style={styles.chipRow}>
            {STATUSES.map((status) => (
              <Chip
                key={status}
                label={status}
                selected={statuses.includes(status)}
                onPress={() => setStatuses((current) => toggle(current, status))}
              />
            ))}
          </View>
        </View>

        <View style={styles.card}>
          <CaptionText>Category</CaptionText>
          {categories.length === 0 ? (
            <CaptionText>No categories yet.</CaptionText>
          ) : (
            <View style={styles.chipRow}>
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  label={category.name}
                  selected={categoryIds.includes(category.id)}
                  onPress={() => setCategoryIds((current) => toggle(current, category.id))}
                />
              ))}
            </View>
          )}
        </View>

        <View style={styles.filterRow}>
          <BodyText>Needs review only</BodyText>
          <Switch
            accessibilityLabel="Needs review only"
            value={needsReview}
            onValueChange={setNeedsReview}
          />
        </View>
        <View style={styles.actionRow}>
          <PrimaryButton
            label="Apply filters"
            disabled={rangeInverted || datesInverted}
            onPress={() => {
              filterStore.replaceFilter(draft);
              onDone?.();
            }}
          />
          <PrimaryButton
            label="Clear all"
            onPress={() => {
              filterStore.clear();
              setFrom('');
              setTo('');
              setMinTotal('');
              setMaxTotal('');
              setStatuses([]);
              setCategoryIds([]);
              setNeedsReview(false);
              onDone?.();
            }}
          />
        </View>
      </ScrollView>
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
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: 12,
    paddingBottom: 12,
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
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colorToken('surfaceSecondary'),
    paddingTop: 12,
    marginTop: 4,
  },
});
