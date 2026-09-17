import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { ID, Receipt } from '@kvitto/shared/domain';
import type { IosDataRepository } from '../../data/repository';
import { ScreenScaffold } from '../../ui/controls';
import { BodyText, CaptionText, TitleText } from '../../ui/typography';
import { colorToken } from '../../ui/tokens';

type LoadState = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; receipt: Receipt };

/** Loads one receipt and follows later edits to it. */
function useReceipt(repository: IosDataRepository, receiptId: ID): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const receipt = await repository.getReceipt(receiptId);
      if (cancelled) return;
      setState(receipt && receipt.deletedAt === 0 ? { status: 'ready', receipt } : { status: 'missing' });
    };

    void load();
    const unsubscribe = repository.subscribe((event) => {
      if (event.kinds.includes('receipts')) void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [repository, receiptId]);

  return state;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <CaptionText>{label}</CaptionText>
      <BodyText>{value}</BodyText>
    </View>
  );
}

function asTime(value: number | null | undefined): string {
  if (!value) return 'unknown';
  return new Date(value).toISOString();
}

function Unavailable({ title, message }: { title: string; message: string }) {
  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">{title}</TitleText>
      <BodyText>{message}</BodyText>
    </ScreenScaffold>
  );
}

export type ReceiptProvenanceScreenProps = {
  repository: IosDataRepository;
  receiptId: ID;
};

/** Everything the AI extraction pass recorded, including why it failed. */
export function ReceiptExtractionScreen({ repository, receiptId }: ReceiptProvenanceScreenProps) {
  const state = useReceipt(repository, receiptId);

  if (state.status === 'loading') {
    return (
      <ScreenScaffold style={styles.container}>
        <BodyText accessibilityRole="progressbar">Loading extraction…</BodyText>
      </ScreenScaffold>
    );
  }
  if (state.status === 'missing') {
    return <Unavailable title="Receipt unavailable" message="This receipt has been deleted, or it does not exist on this device." />;
  }

  const { extraction, status } = state.receipt;
  if (!extraction) {
    return (
      <Unavailable
        title="No extraction yet"
        message={`This receipt has not been through an extraction pass. Its status is “${status}”.`}
      />
    );
  }

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">Extraction</TitleText>
      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Extraction provenance">
        <Row label="Provider" value={extraction.provider} />
        <Row label="Model" value={extraction.model} />
        <Row label="Completed" value={asTime(extraction.at)} />
        <Row label="Duration" value={extraction.durationMs === null ? 'unknown' : `${extraction.durationMs} ms`} />
        <Row
          label="Tokens"
          value={
            extraction.inputTokens === null && extraction.outputTokens === null
              ? 'not reported'
              : `${extraction.inputTokens ?? '?'} in / ${extraction.outputTokens ?? '?'} out`
          }
        />
      </View>

      {extraction.error ? (
        <View style={styles.card}>
          <TitleText accessibilityRole="header">Error</TitleText>
          <BodyText accessibilityRole="alert">{extraction.error}</BodyText>
        </View>
      ) : null}

      <TitleText accessibilityRole="header">{`Warnings (${extraction.warnings.length})`}</TitleText>
      {extraction.warnings.length === 0 ? (
        <CaptionText>No warnings were raised while normalising this receipt.</CaptionText>
      ) : (
        <View style={styles.card}>
          {extraction.warnings.map((warning, index) => (
            <BodyText key={`${index}-${warning}`}>{`• ${warning}`}</BodyText>
          ))}
        </View>
      )}
    </ScreenScaffold>
  );
}

/** The on-device OCR evidence: recognised text and what was read out of it. */
export function ReceiptOcrScreen({ repository, receiptId }: ReceiptProvenanceScreenProps) {
  const state = useReceipt(repository, receiptId);

  if (state.status === 'loading') {
    return (
      <ScreenScaffold style={styles.container}>
        <BodyText accessibilityRole="progressbar">Loading OCR text…</BodyText>
      </ScreenScaffold>
    );
  }
  if (state.status === 'missing') {
    return <Unavailable title="Receipt unavailable" message="This receipt has been deleted, or it does not exist on this device." />;
  }

  const { ocr } = state.receipt;
  if (!ocr) {
    return (
      <Unavailable
        title="No OCR text yet"
        message="This receipt has not been through an on-device text recognition pass."
      />
    );
  }

  return (
    <ScreenScaffold style={styles.container}>
      <TitleText accessibilityRole="header">OCR</TitleText>
      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="OCR provenance">
        <Row label="Engine" value={ocr.engine} />
        <Row label="Confidence" value={`${Math.round(ocr.confidence)} / 100`} />
        <Row label="Completed" value={asTime(ocr.at)} />
        <Row label="Duration" value={ocr.durationMs === null ? 'unknown' : `${ocr.durationMs} ms`} />
      </View>

      <TitleText accessibilityRole="header">{`Organisation numbers (${ocr.orgNumbers.length})`}</TitleText>
      {ocr.orgNumbers.length === 0 ? (
        <CaptionText>No organisation number was found in the text.</CaptionText>
      ) : (
        <View style={styles.card}>
          {ocr.orgNumbers.map((entry) => (
            <BodyText key={entry.value}>
              {`${entry.value} — ${Math.round(entry.confidence)}%${entry.repaired ? ' (repaired)' : ''}`}
            </BodyText>
          ))}
        </View>
      )}

      <TitleText accessibilityRole="header">{`Dates (${ocr.dates.length})`}</TitleText>
      {ocr.dates.length === 0 ? (
        <CaptionText>No purchase date was found in the text.</CaptionText>
      ) : (
        <View style={styles.card}>
          {ocr.dates.map((entry) => (
            <BodyText key={entry.value}>{`${entry.value} — ${Math.round(entry.confidence)}%`}</BodyText>
          ))}
        </View>
      )}

      <TitleText accessibilityRole="header">Recognised text</TitleText>
      <ScrollView style={styles.textBox} accessibilityLabel="Recognised receipt text">
        <BodyText>{ocr.text.trim().length > 0 ? ocr.text : '(the recognised text was empty)'}</BodyText>
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
    gap: 6,
  },
  row: {
    gap: 2,
  },
  textBox: {
    maxHeight: 280,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
