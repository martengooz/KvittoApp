import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useFrameOutput,
  usePhotoOutput,
  type CameraRef,
} from 'react-native-vision-camera';

import type { ScanCameraBridge, ScanCameraCapture, ScanCameraUiState } from '../features/scan';
import { toFrameAnalysis } from '../features/scan/frame-analysis';
import { saveCaptureToScratch } from '../features/scan/capture-file';
import type { FrameAnalysisResult, KvittoNativeFacade } from '../../modules/kvitto-native/src';
import {
  FRAME_ORIENTATION_DEGREES,
  tryCreateFrameDocumentAnalyzer,
} from '../../modules/kvitto-frames/src';
import { BodyText, CaptionText } from '../ui/typography';
import { colorToken } from '../ui/tokens';

/**
 * Shortest gap between two Vision requests, in milliseconds.
 *
 * Detection costs more than a frame interval, so running it on every frame
 * only starves the pipeline. Five readings a second is far more than the scan
 * state machine needs to decide a receipt has been held still.
 */
const FRAME_ANALYSIS_INTERVAL_MS = 200;

/**
 * Markers the device camera check watches for; see
 * `scripts/device-camera-check.mjs`.
 *
 * The frame pipeline is otherwise entirely unobservable on a device: Release
 * strips `console`, the preview looks identical whether the detector is
 * running or inert, and a stalled pipeline shows up as a preview that simply
 * stops moving.
 */
export const FRAME_MARKERS = {
  /** The detector was created, or could not be. */
  analyzer: 'frames:analyzer',
  /** A periodic reading, while the preview is mounted. */
  reading: 'frames:reading',
} as const;

/** How often a reading is logged. Diagnostics, not the pipeline's own rate. */
const FRAME_LOG_INTERVAL_MS = 1_000;

export interface ScanCameraPreviewProps {
  bridge: ScanCameraBridge;
  native: KvittoNativeFacade;
}

function useBridgeState(bridge: ScanCameraBridge): ScanCameraUiState {
  const [state, setState] = useState<ScanCameraUiState>(() => bridge.getUiState());
  useEffect(() => bridge.subscribe(setState), [bridge]);
  return state;
}

/**
 * Owns the native camera session for as long as the scan screen shows it, and
 * registers capture with the bridge so the scan controller can drive it without
 * knowing about React or VisionCamera.
 */
export function ScanCameraPreview({ bridge, native }: ScanCameraPreviewProps) {
  const state = useBridgeState(bridge);
  const cameraRef = useRef<CameraRef>(null);
  const device = useCameraDevice('back');
  const photoOutput = usePhotoOutput({ qualityPrioritization: 'quality' });

  /*
   * The live document detector. Created once per mounted preview, and null
   * wherever the native module is missing - auto-capture is an accelerator,
   * not the feature, so losing it must not take the camera with it.
   */
  const analyzer = useMemo(() => {
    const created = tryCreateFrameDocumentAnalyzer();
    if (created) created.minIntervalMs = FRAME_ANALYSIS_INTERVAL_MS;
    return created;
  }, []);

  /*
   * Frame timestamps come from `CMTime` and count from an arbitrary origin,
   * usually boot. Sampling the offset once lets a reading be aged against wall
   * time without putting a `Date.now()` call inside the frame worklet.
   */
  const frameClockOffsetMs = useRef(0);

  /*
   * Reports what the detector is seeing, once a second, for as long as the
   * preview is up. This is the only way to find out on a device whether frames
   * are arriving at all, whether the evidence score reaches the threshold the
   * scan controller needs, and whether the pipeline is dropping frames because
   * a buffer was held too long.
   */
  useEffect(() => {
    if (!analyzer) {
      try {
        native.logDiagnostic(FRAME_MARKERS.analyzer, 'unavailable');
      } catch {
        // Off-device there is no log; the screen still works.
      }
      return;
    }

    try {
      native.logDiagnostic(FRAME_MARKERS.analyzer, `ready interval=${FRAME_ANALYSIS_INTERVAL_MS}ms`);
    } catch {
      // As above.
    }

    const timer = setInterval(() => {
      try {
        const latest = analyzer.latest;
        native.logDiagnostic(
          FRAME_MARKERS.reading,
          latest
            ? `${latest.status} evidence=${latest.evidenceScore.toFixed(3)} coverage=${latest.coverage.toFixed(3)} took=${latest.durationMs.toFixed(1)}ms skipped=${analyzer.skippedFrames}`
            : 'none',
        );
      } catch {
        // A logging failure must never take the camera down.
      }
    }, FRAME_LOG_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [analyzer, native]);

  const frameOutput = useFrameOutput({
    onFrame: (frame) => {
      'worklet';
      try {
        // `hasNativeBuffer` is false for formats Vision cannot read anyway, so
        // there is nothing to fall back to - skipping is the whole handling.
        if (analyzer !== null && frame.hasNativeBuffer) {
          const buffer = frame.getNativeBuffer();
          try {
            analyzer.analyze(
              buffer.pointer,
              FRAME_ORIENTATION_DEGREES[frame.orientation] ?? 0,
              frame.isMirrored,
              frame.timestamp * 1000,
            );
          } finally {
            // Both of these releases are load-bearing: hold either the buffer
            // or the frame past this callback and the camera pipeline stalls,
            // which shows up as a preview that freezes rather than as an error.
            buffer.release();
          }
        }
      } finally {
        frame.dispose();
      }
    },
  });

  const outputs = useMemo(
    () => (analyzer === null ? [photoOutput] : [photoOutput, frameOutput]),
    [analyzer, frameOutput, photoOutput],
  );

  const capturePhoto = useCallback(async (): Promise<ScanCameraCapture> => {
    // The work is in `saveCaptureToScratch`, which can be tested; this
    // component cannot, because VisionCamera needs a camera to mount.
    const photo = await photoOutput.capturePhoto({}, {});
    return saveCaptureToScratch(photo, native);
  }, [native, photoOutput]);

  const readLatestFrameAnalysis = useCallback((): FrameAnalysisResult | null => {
    if (!analyzer) return null;
    const latest = analyzer.latest;
    if (!latest) return null;

    if (frameClockOffsetMs.current === 0) {
      // First reading seen: pin the two clocks together. Doing it here rather
      // than at mount means the offset is measured against a timestamp that
      // actually exists, instead of against whatever the camera had not yet
      // produced.
      frameClockOffsetMs.current = Date.now() - latest.timestampMs;
    }

    return toFrameAnalysis(latest, {
      nowMs: Date.now(),
      frameClockOffsetMs: frameClockOffsetMs.current,
    });
  }, [analyzer]);

  useEffect(
    () => bridge.attach({ capturePhoto, readLatestFrameAnalysis }),
    [bridge, capturePhoto, readLatestFrameAnalysis],
  );

  /*
   * A reading outlives the preview that produced it, and the analyzer is a
   * native singleton. Without this, reopening the scan screen would arm
   * auto-capture from whatever the camera last saw minutes ago.
   */
  useEffect(() => {
    if (!analyzer) return;
    return () => {
      analyzer.reset();
      frameClockOffsetMs.current = 0;
    };
  }, [analyzer]);

  if (!device) {
    return (
      <View style={styles.placeholder} accessibilityRole="summary">
        <BodyText>No camera is available on this device.</BodyText>
        <CaptionText>Receipts can still be imported from the photo library.</CaptionText>
      </View>
    );
  }

  if (state.permission !== 'granted') {
    return (
      <View style={styles.placeholder} accessibilityRole="summary">
        <BodyText>Camera access is needed to scan a receipt.</BodyText>
        <CaptionText>
          {state.permission === 'denied'
            ? 'Camera access was denied. It can be turned back on in Settings.'
            : 'Grant camera access to start scanning.'}
        </CaptionText>
      </View>
    );
  }

  return (
    <View style={styles.frame} accessibilityLabel="Camera preview">
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={state.active}
        outputs={outputs}
        torchMode={state.torch ? 'on' : 'off'}
        zoom={state.zoom}
        onError={(error) => {
          bridge.reportError(error instanceof Error ? error.message : String(error));
        }}
      />
      {!state.active ? (
        <View style={styles.pausedOverlay} accessibilityRole="summary">
          <CaptionText>Preview paused</CaptionText>
        </View>
      ) : null}
    </View>
  );
}

/*
 * A 3:4 preview is 524pt tall on a 393pt-wide phone, which on its own is more
 * than the space under the header - so the shutter sat below the fold with the
 * preview filling the screen above it. Capping the box lets the primary action
 * stay visible; the camera fills it, so the framing a user sees is unchanged.
 */
const MAX_PREVIEW_HEIGHT = 420;

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 3 / 4,
    maxHeight: MAX_PREVIEW_HEIGHT,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colorToken('surfaceSecondary'),
  },
  placeholder: {
    aspectRatio: 3 / 4,
    maxHeight: MAX_PREVIEW_HEIGHT,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colorToken('surfaceSecondary'),
    backgroundColor: colorToken('surface'),
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  pausedOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colorToken('surface'),
    opacity: 0.85,
  },
});
