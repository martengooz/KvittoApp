import type { FileBackedDescriptor, KvittoNativeFacade } from '../../modules/kvitto-native/src';
import {
  createScanCameraBridge,
  type ScanCameraBridge,
  type ScanCameraCapture,
  type ScanPermissionState,
} from '../../src/features/scan';

/**
 * A native facade carrying only what host tests reach. Casting through
 * `Partial` keeps the stub honest: a test that needs another native method has
 * to add it here rather than silently getting `undefined`.
 */
export function createNativeFacadeStub(overrides: Partial<KvittoNativeFacade> = {}): KvittoNativeFacade {
  const stub: Partial<KvittoNativeFacade> = {
    makeScratchFileUri: (prefix, extension) => `file:///scratch/${prefix}.${extension}`,
    hashFileSha256: async () => 'a'.repeat(64),
    ...overrides,
  };
  return stub as KvittoNativeFacade;
}

export interface FakeScanCameraOptions {
  permission?: ScanPermissionState;
  capture?: () => Promise<ScanCameraCapture>;
}

export function createFakeScanCameraBridge(options: FakeScanCameraOptions = {}): ScanCameraBridge {
  let permission = options.permission ?? 'granted';
  return createScanCameraBridge({
    permissions: {
      getStatus: () => permission,
      async request() {
        permission = options.permission ?? 'granted';
        return permission;
      },
    },
    async describeCapture(capture): Promise<FileBackedDescriptor> {
      return {
        uri: capture.uri,
        mimeType: 'image/jpeg',
        width: capture.width,
        height: capture.height,
        byteSize: capture.byteSize,
        sha256Id: 'b'.repeat(64),
        role: 'original',
      };
    },
  });
}
