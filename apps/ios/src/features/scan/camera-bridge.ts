import type { FileBackedDescriptor, FrameAnalysisResult } from '../../../modules/kvitto-native/src';
import type { ScanCameraPort, ScanPermissionState } from './types';

export interface ScanCameraCapture {
  /** Absolute `file://` URI the photo was written to. */
  uri: string;
  width: number;
  height: number;
  byteSize: number;
}

/**
 * What the mounted preview component can do. The bridge holds these only while
 * a preview is on screen; every call fails with a clear reason when it is not.
 */
export interface ScanCameraHandles {
  capturePhoto(): Promise<ScanCameraCapture>;
  /** Latest compact reading the native frame processor produced, if any. */
  readLatestFrameAnalysis?(): FrameAnalysisResult | null;
}

export interface ScanCameraUiState {
  /** A preview component is mounted and has registered its handles. */
  attached: boolean;
  /** The preview should be streaming. The component mirrors this into `isActive`. */
  active: boolean;
  permission: ScanPermissionState;
  torch: boolean;
  /** Zoom factor, clamped to the device range by the preview component. */
  zoom: number;
  lastError: string | null;
}

export interface ScanCameraPermissionsPort {
  getStatus(): ScanPermissionState;
  request(): Promise<ScanPermissionState>;
}

export interface ScanCameraBridge extends ScanCameraPort {
  /** Called by the preview component on mount; the returned function detaches. */
  attach(handles: ScanCameraHandles): () => void;
  getUiState(): ScanCameraUiState;
  subscribe(listener: (state: ScanCameraUiState) => void): () => void;
  setTorch(on: boolean): void;
  setZoom(zoom: number): void;
  reportPermission(state: ScanPermissionState): void;
  reportError(message: string | null): void;
}

export interface CreateScanCameraBridgeInput {
  permissions: ScanCameraPermissionsPort;
  /** Turns a captured photo file into the descriptor the scan controller expects. */
  describeCapture(capture: ScanCameraCapture): Promise<FileBackedDescriptor>;
  now?: () => number;
  /** Clamp for zoom requests. Default 1-10. */
  zoomRange?: { min: number; max: number };
}

function unavailableFrame(now: number, status: FrameAnalysisResult['status']): FrameAnalysisResult {
  return {
    status,
    pluginLinked: false,
    evidenceScore: 0,
    coverage: 0,
    normalizedQuad: null,
    source: 'stub',
    timing: { startedAtMs: now, endedAtMs: now, durationMs: 0 },
  };
}

/**
 * Bridges the scan controller's imperative camera port to a VisionCamera preview
 * that only exists while the scan screen is mounted.
 *
 * The controller drives capture and preview lifecycle; the component owns the
 * native session. Keeping them apart means the controller and its tests never
 * touch native code, and the screen can mount and unmount freely without the
 * controller holding a stale camera reference.
 */
export function createScanCameraBridge(input: CreateScanCameraBridgeInput): ScanCameraBridge {
  const now = input.now ?? (() => Date.now());
  const zoomRange = input.zoomRange ?? { min: 1, max: 10 };

  let handles: ScanCameraHandles | null = null;
  let state: ScanCameraUiState = {
    attached: false,
    active: false,
    permission: input.permissions.getStatus(),
    torch: false,
    zoom: zoomRange.min,
    lastError: null,
  };

  const listeners = new Set<(state: ScanCameraUiState) => void>();

  function update(patch: Partial<ScanCameraUiState>): void {
    const next = { ...state, ...patch };
    if (
      next.attached === state.attached &&
      next.active === state.active &&
      next.permission === state.permission &&
      next.torch === state.torch &&
      next.zoom === state.zoom &&
      next.lastError === state.lastError
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener(state);
  }

  return {
    attach(next: ScanCameraHandles): () => void {
      handles = next;
      update({ attached: true, lastError: null });
      return () => {
        if (handles !== next) return;
        handles = null;
        // Losing the preview also loses the torch, so do not claim it is still on.
        update({ attached: false, active: false, torch: false });
      };
    },

    getUiState: () => ({ ...state }),

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setTorch(on: boolean): void {
      update({ torch: on });
    },

    setZoom(zoom: number): void {
      update({ zoom: Math.min(zoomRange.max, Math.max(zoomRange.min, zoom)) });
    },

    reportPermission(permission: ScanPermissionState): void {
      update({ permission });
    },

    reportError(message: string | null): void {
      update({ lastError: message });
    },

    async requestPermission(): Promise<ScanPermissionState> {
      const permission = await input.permissions.request();
      update({ permission });
      return permission;
    },

    async startPreview(): Promise<void> {
      update({ active: true, lastError: null });
    },

    async stopPreview(): Promise<void> {
      // The torch belongs to the session, so stopping the preview releases it.
      update({ active: false, torch: false });
    },

    async captureStill(): Promise<FileBackedDescriptor> {
      if (!handles) {
        throw new Error('The camera preview is not on screen, so there is nothing to capture.');
      }
      if (state.permission !== 'granted') {
        throw new Error('Camera permission has not been granted.');
      }
      if (!state.active) {
        throw new Error('The camera preview is not running, so there is nothing to capture.');
      }
      return input.describeCapture(await handles.capturePhoto());
    },

    async analyzeFrameCompact(): Promise<FrameAnalysisResult> {
      // The reading comes from the mounted preview, which owns the analyzer.
      // Without one - no preview, or a build with the detector missing -
      // reporting `unsupported` keeps auto-capture honestly disabled rather
      // than pretending a document was found.
      const reading = handles?.readLatestFrameAnalysis?.();
      if (!reading) return unavailableFrame(now(), state.active ? 'unsupported' : 'no-document');
      return reading;
    },
  };
}
