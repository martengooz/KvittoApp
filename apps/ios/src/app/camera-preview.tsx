import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  usePhotoOutput,
  type CameraRef,
} from 'react-native-vision-camera';

import type { ScanCameraBridge, ScanCameraCapture, ScanCameraUiState } from '../features/scan';
import type { KvittoNativeFacade } from '../../modules/kvitto-native/src';
import { BodyText, CaptionText } from '../ui/typography';
import { colorToken } from '../ui/tokens';

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
  const outputs = useMemo(() => [photoOutput], [photoOutput]);

  const capturePhoto = useCallback(async (): Promise<ScanCameraCapture> => {
    const photo = await photoOutput.capturePhoto({}, {});
    try {
      const uri = native.makeScratchFileUri('capture', 'jpg');
      await photo.saveToFileAsync(uri);
      return {
        uri,
        width: photo.width,
        height: photo.height,
        // The file was just written; its size is read when it is hashed.
        byteSize: 0,
      };
    } finally {
      photo.dispose();
    }
  }, [native, photoOutput]);

  useEffect(() => bridge.attach({ capturePhoto }), [bridge, capturePhoto]);

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

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 3 / 4,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: colorToken('surfaceSecondary'),
  },
  placeholder: {
    aspectRatio: 3 / 4,
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
