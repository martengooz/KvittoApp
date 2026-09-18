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
        /*
         * The answer comes from the call, not from re-reading the property.
         * `requestCameraPermission` resolves with what the user chose;
         * `cameraPermissionStatus` is a separate read of a hybrid object's
         * property, and trusting it to have caught up by the time the promise
         * settles is an assumption with nothing behind it. Getting that wrong
         * leaves the app reporting "unknown" after the user has just said yes,
         * with a preview that never starts and no way to tell why.
         */
        const granted = await camera.requestCameraPermission();
        if (granted) return 'granted';
        return toScanPermission(camera.cameraPermissionStatus);
      } catch {
        return 'unavailable';
      }
    },
  };
}
