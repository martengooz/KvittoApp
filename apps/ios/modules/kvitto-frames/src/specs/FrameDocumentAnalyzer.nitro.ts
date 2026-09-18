import type { HybridObject, UInt64 } from 'react-native-nitro-modules';

/**
 * A document quad in Vision's normalized coordinates: origin bottom-left, both
 * axes 0-1.
 *
 * Kept in Vision's space rather than flipped, because the rest of the app
 * speaks it too - a quad detected here can be handed straight back to
 * `processReceiptImage` as `forcedQuad`. Flipping would make a crop taken from
 * a live frame mean something different from one taken from a still.
 */
export interface FrameDocumentQuad {
  topLeftX: number;
  topLeftY: number;
  topRightX: number;
  topRightY: number;
  bottomRightX: number;
  bottomRightY: number;
  bottomLeftX: number;
  bottomLeftY: number;
}

export interface FrameDocumentReading {
  /** `ready` when a quad was found, `no-document` when the frame had none. */
  status: string;
  /** 0-1. How much this reading argues a receipt is squarely in frame. */
  evidenceScore: number;
  /** 0-1. Fraction of the frame the quad covers. */
  coverage: number;
  /** How long the Vision request took, in milliseconds. */
  durationMs: number;
  /** Frame presentation timestamp, in milliseconds. */
  timestampMs: number;
  quad?: FrameDocumentQuad;
}

/**
 * Runs Vision's rectangle detector against camera frames.
 *
 * The split of `analyze` and `latest` is the point of the design. `analyze`
 * runs on the camera's own thread and must return before the next frame or the
 * pipeline stalls, so it returns nothing and stores its result. `latest` is
 * read from the JS thread by the scan controller, which wants the most recent
 * reading and does not care which frame produced it.
 */
export interface KvittoFrameDocumentAnalyzer extends HybridObject<{ ios: 'swift' }> {
  /**
   * Shortest gap between two Vision requests, in milliseconds.
   *
   * Detection costs more than a frame interval on a 60fps preview, and running
   * it on every frame buys nothing: a hand holding a phone does not move far in
   * 16ms. Frames arriving inside the gap are skipped, not queued.
   */
  minIntervalMs: number;

  /**
   * Analyzes one frame. Called from the frame worklet.
   *
   * @param pixelBufferPointer a `CVPixelBufferRef` from `Frame.getNativeBuffer()`.
   *   The caller owns it and must release it; this does not.
   * @param orientationDegrees clockwise rotation needed to make the buffer
   *   upright, derived from `Frame.orientation`.
   */
  analyze(
    pixelBufferPointer: UInt64,
    orientationDegrees: number,
    isMirrored: boolean,
    timestampMs: number,
  ): void;

  /** The most recent reading, or undefined before the first one. */
  readonly latest?: FrameDocumentReading;

  /** Frames skipped by the interval gate since the last reset. */
  readonly skippedFrames: number;

  /** Forgets the last reading, e.g. when the preview is torn down. */
  reset(): void;
}
