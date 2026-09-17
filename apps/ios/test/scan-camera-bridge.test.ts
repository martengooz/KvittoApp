import { describe, expect, test } from '@jest/globals';

import {
  createScanCameraBridge,
  type ScanCameraCapture,
  type ScanCameraUiState,
  type ScanPermissionState,
} from '../src/features/scan';

function setup(options: { permission?: ScanPermissionState; requested?: ScanPermissionState } = {}) {
  let permission = options.permission ?? 'unknown';
  let requests = 0;
  const captures: number[] = [];

  const bridge = createScanCameraBridge({
    permissions: {
      getStatus: () => permission,
      async request() {
        requests += 1;
        permission = options.requested ?? 'granted';
        return permission;
      },
    },
    async describeCapture(capture) {
      return {
        uri: capture.uri,
        mimeType: 'image/jpeg',
        width: capture.width,
        height: capture.height,
        byteSize: capture.byteSize,
        sha256Id: 'c'.repeat(64),
        role: 'original',
      };
    },
    now: () => 5_000,
  });

  const capturePhoto = async (): Promise<ScanCameraCapture> => {
    captures.push(1);
    return { uri: 'file:///scratch/capture.jpg', width: 3024, height: 4032, byteSize: 0 };
  };

  return {
    bridge,
    capturePhoto,
    captureCount: () => captures.length,
    requestCount: () => requests,
  };
}

describe('scan camera bridge', () => {
  test('capture fails with a readable reason when no preview is on screen', async () => {
    const { bridge } = setup({ permission: 'granted' });
    await bridge.startPreview();

    await expect(bridge.captureStill()).rejects.toThrow('preview is not on screen');
  });

  test('capture fails when permission has not been granted, even with a preview', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'denied' });
    bridge.attach({ capturePhoto });
    await bridge.startPreview();

    await expect(bridge.captureStill()).rejects.toThrow('permission has not been granted');
  });

  test('capture fails while the preview is paused', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'granted' });
    bridge.attach({ capturePhoto });

    await expect(bridge.captureStill()).rejects.toThrow('preview is not running');
  });

  test('a granted, attached, running preview captures and describes the photo', async () => {
    const { bridge, capturePhoto, captureCount } = setup({ permission: 'granted' });
    bridge.attach({ capturePhoto });
    await bridge.startPreview();

    await expect(bridge.captureStill()).resolves.toEqual({
      uri: 'file:///scratch/capture.jpg',
      mimeType: 'image/jpeg',
      width: 3024,
      height: 4032,
      byteSize: 0,
      sha256Id: 'c'.repeat(64),
      role: 'original',
    });
    expect(captureCount()).toBe(1);
  });

  test('requesting permission goes through the platform and updates the published state', async () => {
    const { bridge, requestCount } = setup({ permission: 'unknown', requested: 'granted' });
    expect(bridge.getUiState().permission).toBe('unknown');

    await expect(bridge.requestPermission()).resolves.toBe('granted');
    expect(requestCount()).toBe(1);
    expect(bridge.getUiState().permission).toBe('granted');
  });

  test('pausing the preview releases the torch', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'granted' });
    bridge.attach({ capturePhoto });
    await bridge.startPreview();
    bridge.setTorch(true);
    expect(bridge.getUiState().torch).toBe(true);

    await bridge.stopPreview();
    expect(bridge.getUiState()).toMatchObject({ active: false, torch: false });
  });

  test('detaching the preview drops the torch and the active flag', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'granted' });
    const detach = bridge.attach({ capturePhoto });
    await bridge.startPreview();
    bridge.setTorch(true);

    detach();
    expect(bridge.getUiState()).toMatchObject({ attached: false, active: false, torch: false });
    await expect(bridge.captureStill()).rejects.toThrow('preview is not on screen');
  });

  test('a stale detach from a replaced preview does not disconnect the live one', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'granted' });
    const detachFirst = bridge.attach({ capturePhoto });
    bridge.attach({ capturePhoto });
    await bridge.startPreview();

    detachFirst();

    expect(bridge.getUiState().attached).toBe(true);
    await expect(bridge.captureStill()).resolves.toMatchObject({ width: 3024 });
  });

  test('zoom is clamped to the device range', () => {
    const { bridge } = setup({ permission: 'granted' });
    bridge.setZoom(0.1);
    expect(bridge.getUiState().zoom).toBe(1);
    bridge.setZoom(50);
    expect(bridge.getUiState().zoom).toBe(10);
    bridge.setZoom(2.5);
    expect(bridge.getUiState().zoom).toBe(2.5);
  });

  test('subscribers see changes once, and not for no-op updates', async () => {
    const { bridge } = setup({ permission: 'granted' });
    const seen: ScanCameraUiState[] = [];
    const unsubscribe = bridge.subscribe((state) => seen.push(state));

    await bridge.startPreview();
    await bridge.startPreview();
    bridge.setTorch(true);
    bridge.setTorch(true);

    expect(seen).toHaveLength(2);
    unsubscribe();

    bridge.setTorch(false);
    expect(seen).toHaveLength(2);
  });

  test('frame analysis reports no live plugin rather than inventing a document', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'granted' });

    const idle = await bridge.analyzeFrameCompact(0);
    expect(idle).toMatchObject({ status: 'no-document', pluginLinked: false, source: 'stub' });

    bridge.attach({ capturePhoto });
    await bridge.startPreview();
    const running = await bridge.analyzeFrameCompact(0);
    expect(running).toMatchObject({ status: 'unsupported', pluginLinked: false, evidenceScore: 0 });
  });

  test('a live frame reading is passed straight through once a plugin provides one', async () => {
    const { bridge, capturePhoto } = setup({ permission: 'granted' });
    bridge.attach({
      capturePhoto,
      readLatestFrameAnalysis: () => ({
        status: 'ready',
        pluginLinked: true,
        evidenceScore: 0.82,
        coverage: 0.61,
        normalizedQuad: {
          topLeft: { x: 0.1, y: 0.1 },
          topRight: { x: 0.9, y: 0.1 },
          bottomRight: { x: 0.9, y: 0.9 },
          bottomLeft: { x: 0.1, y: 0.9 },
        },
        source: 'vision-frame-plugin',
        timing: { startedAtMs: 1, endedAtMs: 6, durationMs: 5 },
      }),
    });
    await bridge.startPreview();

    const reading = await bridge.analyzeFrameCompact(0);
    expect(reading).toMatchObject({
      status: 'ready',
      pluginLinked: true,
      source: 'vision-frame-plugin',
      evidenceScore: 0.82,
    });
  });
});
