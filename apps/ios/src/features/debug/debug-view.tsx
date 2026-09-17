import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { IosDataRepository } from '../../data/repository';
import { clearSampleData, countSampleData, seedSampleData } from '../../data/sample-data';
import { ScreenScaffold, PrimaryButton } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';

export type DebugScreenProps = {
  repository: IosDataRepository;
  startupSteps: string[];
  /**
   * Whether sample-data actions may be offered. Gated on the simulator rather
   * than on a debug build, because the smoke check drives a Release build on a
   * simulator; a real device never gets these controls.
   */
  allowSampleData: boolean;
  /** Result of a seed triggered by the route, shown alongside the screen's own. */
  notice?: string | null;
};

type Counts = { receipts: number; items: number; categories: number; tags: number; samples: number };

export function DebugScreen({ repository, startupSteps, allowSampleData, notice }: DebugScreenProps) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [receipts, categories, tags, samples] = await Promise.all([
      repository.queryReceipts({}, 1000),
      repository.listCategories(),
      repository.listTags(),
      countSampleData(repository),
    ]);

    let items = 0;
    for (const receipt of receipts.items) {
      items += (await repository.listReceiptItems(receipt.id)).length;
    }

    setCounts({
      receipts: receipts.items.length,
      items,
      categories: categories.length,
      tags: tags.length,
      samples,
    });
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      void refresh().catch((cause: unknown) => {
        if (!cancelled) setStatus(cause instanceof Error ? cause.message : String(cause));
      });
    };

    run();
    const unsubscribe = repository.subscribe(() => {
      if (!cancelled) run();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh, repository]);

  const run = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setStatus(null);
    try {
      setStatus(await work());
    } catch (cause: unknown) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TitleText accessibilityRole="header">Debug</TitleText>

        <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Database contents">
          <TitleText>Database</TitleText>
          {counts === null ? (
            <CaptionText accessibilityRole="progressbar">Counting…</CaptionText>
          ) : (
            <>
              <CaptionText>{`Receipts: ${counts.receipts}`}</CaptionText>
              <CaptionText>{`Line items: ${counts.items}`}</CaptionText>
              <CaptionText>{`Categories: ${counts.categories}`}</CaptionText>
              <CaptionText>{`Tags: ${counts.tags}`}</CaptionText>
              <CaptionText>{`Sample receipts: ${counts.samples}`}</CaptionText>
            </>
          )}
        </View>

        <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Startup diagnostics">
          <TitleText>Startup</TitleText>
          {startupSteps.length === 0 ? (
            <CaptionText>No startup steps recorded.</CaptionText>
          ) : (
            startupSteps.map((step) => <CaptionText key={step}>{step}</CaptionText>)
          )}
        </View>

        <View style={styles.card}>
          <TitleText>Sample data</TitleText>
          {allowSampleData ? (
            <>
              <CaptionText>
                Six receipts covering the awkward cases: confirmed, parsed, a draft with no
                lines, a failed one, and one whose lines do not add up. Seeding twice
                overwrites rather than duplicating.
              </CaptionText>
              <View style={styles.actionRow}>
                <PrimaryButton
                  label="Seed sample data"
                  disabled={busy}
                  onPress={() => {
                    void run(async () => {
                      const { receipts, items } = await seedSampleData(repository);
                      return `Seeded ${receipts} receipts and ${items} line items.`;
                    });
                  }}
                />
                <PrimaryButton
                  label="Clear sample data"
                  disabled={busy}
                  onPress={() => {
                    void run(async () => {
                      const { receipts, items } = await clearSampleData(repository);
                      return receipts === 0
                        ? 'No sample receipts to remove.'
                        : `Removed ${receipts} receipts and ${items} line items.`;
                    });
                  }}
                />
              </View>
            </>
          ) : (
            <BodyText>
              Sample data is only available on a simulator, so it can never reach a real
              device’s receipts.
            </BodyText>
          )}
        </View>

        {(status ?? notice) ? <CaptionText accessibilityRole="alert">{status ?? notice}</CaptionText> : null}
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
    gap: 6,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
