import { NitroModules } from 'react-native-nitro-modules';

import type {
  FrameDocumentQuad,
  FrameDocumentReading,
  KvittoFrameDocumentAnalyzer,
} from './specs/FrameDocumentAnalyzer.nitro';

export type { FrameDocumentQuad, FrameDocumentReading, KvittoFrameDocumentAnalyzer };

/**
 * VisionCamera reports orientation as a name; Vision wants a rotation.
 *
 * The names describe how far the buffer is rotated away from upright, which is
 * the same thing `CGImagePropertyOrientation` encodes, so this is a plain
 * mapping rather than an inversion.
 */
export const FRAME_ORIENTATION_DEGREES: Readonly<Record<string, number>> = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};

/**
 * Creates the live document detector.
 *
 * Throws where the native module is unavailable - a host test, or any build
 * without the pod linked. Callers that can carry on without live detection
 * should use {@link tryCreateFrameDocumentAnalyzer} instead.
 */
export function createFrameDocumentAnalyzer(): KvittoFrameDocumentAnalyzer {
  return NitroModules.createHybridObject<KvittoFrameDocumentAnalyzer>('KvittoFrameDocumentAnalyzer');
}

/**
 * The same, but null instead of a throw.
 *
 * Auto-capture is an accelerator, not the feature: a scan screen with no
 * detector still previews, still shoots, and still processes. Losing the
 * detector must not take the camera with it.
 */
export function tryCreateFrameDocumentAnalyzer(): KvittoFrameDocumentAnalyzer | null {
  try {
    return createFrameDocumentAnalyzer();
  } catch {
    return null;
  }
}
