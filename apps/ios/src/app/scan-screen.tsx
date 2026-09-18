import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import type {
  ScanBatchOutcome,
  ScanCameraBridge,
  ScanCameraUiState,
  ScanFeatureController,
  ScanState,
} from '../features/scan';
import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';
import { ScanCameraPreview } from './camera-preview';
import { PrimaryButton, ScreenScaffold } from '../ui/controls';
import { BodyText, CaptionText } from '../ui/typography';
import { colorToken } from '../ui/tokens';

export type ScanFeatureScreenProps = {
  controller: ScanFeatureController;
  camera: ScanCameraBridge;
  native: KvittoNativeFacade;
};

const ZOOM_STEPS = [1, 2, 3] as const;

function cloneScanState(state: Readonly<ScanState>): ScanState {
  return {
    ...state,
    recoverableStageIds: [...state.recoverableStageIds],
    importProgress: state.importProgress ? { ...state.importProgress } : null,
    review: state.review ? { ...state.review } : null,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function ScanFeatureScreen({ controller, camera, native }: ScanFeatureScreenProps) {
  const [state, setState] = useState<ScanState>(() => cloneScanState(controller.getState()));
  const [cameraState, setCameraState] = useState<ScanCameraUiState>(() => camera.getUiState());
  const [error, setError] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<ScanBatchOutcome | null>(null);

  useEffect(() => camera.subscribe(setCameraState), [camera]);

  const refresh = useCallback(() => {
    setState(cloneScanState(controller.getState()));
  }, [controller]);

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setError(null);
      try {
        await work();
      } catch (nextError) {
        setError(toErrorMessage(nextError));
      } finally {
        refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    void run(async () => {
      await controller.syncRecoverableStages();
    });
  }, [controller, run]);

  // Stopping the preview when the screen goes away releases the camera and the
  // torch rather than leaving them held by an unmounted screen.
  useEffect(() => {
    return () => {
      void controller.stopCapture();
    };
  }, [controller]);

  const canCapture =
    state.permission === 'granted' && cameraState.attached && cameraState.active && !state.processing;

  return (
    <ScreenScaffold style={styles.container}>
      {/* The title comes from the tab's native header; see `src/app/tabs.ts`. */}
      {/*
        The camera preview is most of a screen tall, and the controls below it
        add four more rows. Without this the shutter was off the bottom of the
        screen with no way to reach it - on a phone you could see the preview
        and not take a photo. Caught by a device screenshot; no test can see it.
      */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Scan diagnostics">
        <CaptionText>{`Permission: ${state.permission}`}</CaptionText>
        <CaptionText>{`Stage: ${state.stage}`}</CaptionText>
        <CaptionText>{`Auto-capture: ${state.auto}`}</CaptionText>
        <CaptionText>{`Recoverable stages: ${state.recoverableStageIds.length}`}</CaptionText>
      </View>

      {error ? <BodyText accessibilityRole="alert">{error}</BodyText> : null}
      {state.importProgress ? (
        <CaptionText accessibilityRole="progressbar">
          {`Importing ${state.importProgress.index}/${state.importProgress.total} (${state.importProgress.imported} saved)`}
        </CaptionText>
      ) : null}
      {lastImport ? (
        <CaptionText accessibilityRole="summary">
          {`Last import: ${lastImport.imported}/${lastImport.total} saved, ${lastImport.failed} failed, ${lastImport.fallbackCount} fallback.`}
        </CaptionText>
      ) : null}

      {state.stage === 'capture' ? (
        <ScanCameraPreview bridge={camera} native={native} />
      ) : null}

      {cameraState.lastError ? (
        <BodyText accessibilityRole="alert">{cameraState.lastError}</BodyText>
      ) : null}

      <View style={styles.row}>
        {/*
          Hidden once granted rather than shown disabled. It sat above the
          preview taking the most valuable space on the screen to offer
          something that could never happen again.
        */}
        {state.permission === 'granted' ? null : (
          <PrimaryButton
            label="Request camera permission"
            onPress={() => {
              void run(async () => {
                await controller.requestPermission();
              });
            }}
          />
        )}
        <PrimaryButton
          label={cameraState.active ? 'Pause preview' : 'Start capture'}
          onPress={() => {
            void run(async () => {
              if (cameraState.active) {
                await controller.stopCapture();
                return;
              }
              await controller.startCapture();
            });
          }}
          disabled={state.processing}
        />
      </View>

      <View style={styles.row} accessibilityLabel="Camera controls">
        <PrimaryButton
          label={cameraState.torch ? 'Torch on' : 'Torch off'}
          onPress={() => {
            camera.setTorch(!cameraState.torch);
          }}
          disabled={!cameraState.active}
        />
        {ZOOM_STEPS.map((step) => (
          <PrimaryButton
            key={step}
            label={`${step}x`}
            onPress={() => {
              camera.setZoom(step);
            }}
            disabled={!cameraState.active || cameraState.zoom === step}
          />
        ))}
      </View>

      <View style={styles.row}>
        <PrimaryButton
          label="Manual shutter"
          onPress={() => {
            void run(async () => {
              await controller.manualShutter();
            });
          }}
          disabled={!canCapture}
        />
        <PrimaryButton
          label="Confirm scan"
          onPress={() => {
            void run(async () => {
              await controller.confirm();
            });
          }}
          disabled={!state.review || state.processing}
        />
      </View>

      <View style={styles.row}>
        <PrimaryButton
          label="Import from library"
          onPress={() => {
            void run(async () => {
              const outcome = await controller.importFromLibrary();
              setLastImport(outcome);
            });
          }}
          disabled={state.processing}
        />
      </View>

      {state.review ? (
        <View style={styles.card} accessibilityRole="summary" accessibilityLabel="Review details">
          <CaptionText>{`Detection: ${state.review.detectionSource}`}</CaptionText>
          <CaptionText>{`Fallback used: ${state.review.fallbackUsed ? 'yes' : 'no'}`}</CaptionText>
          <CaptionText>{`Rotation: ${state.review.rotation}`}</CaptionText>
        </View>
      ) : null}
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    justifyContent: 'flex-start',
    paddingTop: 12,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: 10,
    paddingBottom: 24,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
});
