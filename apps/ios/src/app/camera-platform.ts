import type { ScanCameraPermissionsPort, ScanPermissionState } from '../features/scan';

interface VisionCameraModule {
  VisionCamera: {
    cameraPermissionStatus: string;
    requestCameraPermission(): Promise<boolean>;
  };
}

function toScanPermission(status: string): ScanPermissionState {
  if (status === 'authorized') return 'granted';
  if (status === 'denied' || status === 'restricted') return 'denied';
  if (status === 'not-determined') return 'unknown';
  return 'unavailable';
}

/**
 * VisionCamera pulls in Nitro's TurboModule at import time, which only exists in
 * the app. Loading it here, on first use, keeps the service composition
 * importable from host tests.
 */
function loadVisionCamera(): VisionCameraModule['VisionCamera'] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('react-native-vision-camera') as VisionCameraModule).VisionCamera;
  } catch {
    return null;
  }
}

export function createVisionCameraPermissionsPort(): ScanCameraPermissionsPort {
  return {
    getStatus(): ScanPermissionState {
      const camera = loadVisionCamera();
      if (!camera) return 'unavailable';
      try {
        return toScanPermission(camera.cameraPermissionStatus);
      } catch {
        return 'unavailable';
      }
    },

    async request(): Promise<ScanPermissionState> {
      const camera = loadVisionCamera();
      if (!camera) return 'unavailable';
      try {
        await camera.requestCameraPermission();
        return toScanPermission(camera.cameraPermissionStatus);
      } catch {
        return 'unavailable';
      }
    },
  };
}
