import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import type { Category, ID, Tag } from '@kvitto/shared/domain';
import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';
import { haptic } from '../../ui/haptics';

/**
 * A colour the app can actually render. Anything else is rejected at the edit
 * field rather than stored, because a bad value here reaches every list that
 * paints a swatch and there is nowhere further down to catch it.
 */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Offered when creating, so a new row is never the same colour as the last. */
const PALETTE = [
  '#4f7cff',
  '#22a06b',
  '#e0812f',
  '#d1495b',
  '#8557d6',
  '#0f8b8d',
  '#b3733a',
  '#5b6c7d',
];

type Draft = {
  /** Absent while creating. */
  id?: ID;
  name: string;
  color: string;
  icon: string;
};

type Pending = { id: ID; name: string; usage: string } | null;

function nextColor(used: string[]): string {
  const free = PALETTE.find((color) => !used.includes(color.toLowerCase()));
  return free ?? PALETTE[used.length % PALETTE.length]!;
}

function Swatch({ color, glyph }: { color: string; glyph?: string | null }) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={[styles.swatch, { backgroundColor: HEX_COLOR.test(color) ? color : colorToken('surfaceSecondary') }]}
    >
      {glyph ? <BodyText>{glyph}</BodyText> : null}
    </View>
  );
}

function SmallButton({
  label,
  onPress,
  tone = 'normal',
}: {
  label: string;
  onPress: () => void;
  tone?: 'normal' | 'danger';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.smallButton, pressed ? styles.smallButtonPressed : null]}
    >
      <CaptionText style={tone === 'danger' ? styles.dangerLabel : undefined}>{label}</CaptionText>
    </Pressable>
  );
}

export type TaxonomyKind = 'categories' | 'tags';

export type TaxonomyScreenProps = {
  repository: IosDataRepository;
  kind: TaxonomyKind;
};

/**
 * Manages one editable taxonomy. Categories and tags differ only in whether a
 * row carries an emoji glyph and in what deleting one costs, so they share a
 * screen rather than two files that drift apart.
 */
export function TaxonomyScreen({ repository, kind }: TaxonomyScreenProps) {
  const isCategories = kind === 'categories';
  const noun = isCategories ? 'category' : 'tag';
  const plural = isCategories ? 'Categories' : 'Tags';

  const [rows, setRows] = useState<(Category | Tag)[] | null>(null);
  const [usage, setUsage] = useState<Record<ID, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = isCategories ? await repository.listCategories() : await repository.listTags();
    setRows(list);

    const counts: Record<ID, string> = {};
    for (const row of list) {
      if (isCategories) {
        const { receipts, items } = await repository.countCategoryUsage(row.id);
        counts[row.id] =
          receipts === 0 && items === 0
            ? 'Not used yet'
            : `Used by ${receipts} receipt${receipts === 1 ? '' : 's'} and ${items} item${items === 1 ? '' : 's'}`;
      } else {
        const { receipts } = await repository.countTagUsage(row.id);
        counts[row.id] =
          receipts === 0 ? 'Not used yet' : `Used by ${receipts} receipt${receipts === 1 ? '' : 's'}`;
      }
    }
    setUsage(counts);
  }, [isCategories, repository]);

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
      if (event.kinds.includes(kind) || event.kinds.includes('receipts') || event.kinds.includes('items')) run();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [kind, load, repository]);

  const usedColors = useMemo(
    () => (rows ?? []).map((row) => row.color.toLowerCase()),
    [rows],
  );

  const colorValid = draft === null || HEX_COLOR.test(draft.color);
  const nameValid = draft === null || draft.name.trim().length > 0;

  /** A name already taken, ignoring case and the row being edited itself. */
  const nameTaken =
    draft !== null &&
    (rows ?? []).some(
      (row) => row.id !== draft.id && row.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
    );

  const save = async () => {
    if (!draft || !colorValid || !nameValid || nameTaken) return;
    setError(null);
    try {
      if (isCategories) {
        await repository.saveCategory({
          id: draft.id,
          name: draft.name,
          color: draft.color,
          icon: draft.icon.trim().length > 0 ? draft.icon.trim() : null,
        });
      } else {
        await repository.saveTag({ id: draft.id, name: draft.name, color: draft.color });
      }
      setDraft(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const confirmDelete = async (id: ID) => {
    setError(null);
    try {
      if (isCategories) await repository.deleteCategory(id);
      else await repository.deleteTag(id);
      haptic('success');
      setPending(null);
    } catch (cause: unknown) {
      haptic('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (rows === null) {
    return (
      <ScreenScaffold style={styles.container}>
        <BodyText accessibilityRole="progressbar">{`Loading ${plural.toLowerCase()}…`}</BodyText>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold style={styles.container}>
      {/* The title comes from the native header; see `src/app/routes.ts`. */}
      <CaptionText>
        {rows.length === 0 ? `No ${plural.toLowerCase()} yet.` : `${rows.length} ${rows.length === 1 ? noun : plural.toLowerCase()}.`}
      </CaptionText>

      {error ? <CaptionText accessibilityRole="alert">{error}</CaptionText> : null}

      {draft === null ? (
        <PrimaryButton
          label={`Add ${noun}`}
          onPress={() => setDraft({ name: '', color: nextColor(usedColors), icon: '' })}
        />
      ) : (
        <View style={styles.card}>
          <TitleText accessibilityRole="header">{draft.id ? `Edit ${noun}` : `New ${noun}`}</TitleText>

          <CaptionText>Name</CaptionText>
          <TextInput
            accessibilityLabel={`${plural} name`}
            value={draft.name}
            placeholder="Name"
            onChangeText={(name) => setDraft((current) => (current ? { ...current, name } : current))}
            style={styles.input}
          />
          {nameTaken ? (
            <CaptionText accessibilityRole="alert">{`A ${noun} called “${draft.name.trim()}” already exists.`}</CaptionText>
          ) : null}

          <CaptionText>Colour (#rrggbb)</CaptionText>
          <View style={styles.pairRow}>
            <Swatch color={draft.color} />
            <TextInput
              accessibilityLabel={`${plural} colour`}
              value={draft.color}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(color) => setDraft((current) => (current ? { ...current, color } : current))}
              style={[styles.input, styles.pairInput]}
            />
          </View>
          {colorValid ? null : (
            <CaptionText accessibilityRole="alert">A colour looks like #4f7cff.</CaptionText>
          )}

          {isCategories ? (
            <>
              <CaptionText>Icon (one emoji, optional)</CaptionText>
              <TextInput
                accessibilityLabel="Category icon"
                value={draft.icon}
                placeholder="🛒"
                onChangeText={(icon) => setDraft((current) => (current ? { ...current, icon } : current))}
                style={styles.input}
              />
            </>
          ) : null}

          <View style={styles.actionRow}>
            <PrimaryButton
              label="Save"
              disabled={!colorValid || !nameValid || nameTaken}
              onPress={() => void save()}
            />
            <PrimaryButton label="Cancel" onPress={() => setDraft(null)} />
          </View>
        </View>
      )}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {rows.map((row) => {
          const glyph = isCategories ? (row as Category).icon : null;
          const isPending = pending?.id === row.id;

          return (
            <View key={row.id} style={styles.card}>
              <View style={styles.rowHeader}>
                <Swatch color={row.color} glyph={glyph} />
                <View style={styles.rowText}>
                  {/* The name is the row's subject, so it takes the primary tone. */}
                  <BodyText tone="primary">{row.name}</BodyText>
                  <CaptionText>{usage[row.id] ?? 'Counting…'}</CaptionText>
                </View>
              </View>

              {isPending ? (
                <View style={styles.confirm}>
                  {/*
                    There is no Alert in this app yet, and a destructive action
                    needs a second step, so the confirmation lives in the row
                    and spells out what deleting actually changes.
                  */}
                  <CaptionText accessibilityRole="alert">
                    {isCategories
                      ? `Delete “${row.name}”? ${pending.usage}. Deleting clears it from them; the receipts themselves are kept.`
                      : `Delete “${row.name}”? ${pending.usage}. Deleting removes it from them; the receipts themselves are kept.`}
                  </CaptionText>
                  <View style={styles.actionRow}>
                    <SmallButton label={`Delete ${row.name}`} tone="danger" onPress={() => void confirmDelete(row.id)} />
                    <SmallButton label="Keep it" onPress={() => setPending(null)} />
                  </View>
                </View>
              ) : (
                <View style={styles.actionRow}>
                  <SmallButton
                    label={`Edit ${row.name}`}
                    onPress={() => {
                      setPending(null);
                      setDraft({ id: row.id, name: row.name, color: row.color, icon: glyph ?? '' });
                    }}
                  />
                  <SmallButton
                    label={`Remove ${row.name}`}
                    tone="danger"
                    onPress={() => {
                      setDraft(null);
                      setPending({ id: row.id, name: row.name, usage: usage[row.id] ?? 'Usage unknown' });
                    }}
                  />
                </View>
              )}
            </View>
          );
        })}
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
    alignItems: 'center',
    gap: 8,
  },
  pairInput: {
    flexGrow: 1,
    flexBasis: 0,
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowText: {
    flexShrink: 1,
    gap: 2,
  },
  confirm: {
    gap: 8,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  smallButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  smallButtonPressed: {
    backgroundColor: colorToken('surfaceSecondary'),
  },
  dangerLabel: {
    color: colorToken('danger'),
  },
  list: {
    // See the note in filters-view.tsx: a grow-only basis overflows.
    flex: 1,
  },
  listContent: {
    gap: 12,
    paddingBottom: 16,
  },
});
