import type { FrameDocumentReading } from '../../../modules/kvitto-frames/src';
import type { FrameAnalysisResult, NormalizedQuad } from '../../../modules/kvitto-native/src';

/**
 * How old a reading may be before it stops counting, in milliseconds.
 *
 * The analyzer keeps its last reading until the next one replaces it, which is
 * what the scan controller wants while frames keep arriving. It is the wrong
 * answer once they stop - a paused preview, a backgrounded app, a stalled
 * pipeline - because the last thing the camera saw would keep arming
 * auto-capture over a scene that is no longer in front of it.
 */
export const FRAME_READING_MAX_AGE_MS = 900;

function quadOf(reading: FrameDocumentReading): NormalizedQuad | null {
  const quad = reading.quad;
  if (!quad) return null;
  return {
    topLeft: { x: quad.topLeftX, y: quad.topLeftY },
    topRight: { x: quad.topRightX, y: quad.topRightY },
    bottomRight: { x: quad.bottomRightX, y: quad.bottomRightY },
    bottomLeft: { x: quad.bottomLeftX, y: quad.bottomLeftY },
  };
}

function isStatus(value: string): value is FrameAnalysisResult['status'] {
  return value === 'ready' || value === 'no-document' || value === 'unsupported' || value === 'cancelled';
}

export interface ToFrameAnalysisOptions {
  /** `Date.now()` at the moment the reading is being consumed. */
  nowMs: number;
  /**
   * `Date.now()` minus the frame clock, so a frame timestamp can be compared
   * against wall time. Frame timestamps come from `CMTime` and count from an
   * arbitrary origin, usually boot - they are not epoch milliseconds.
   */
  frameClockOffsetMs: number;
  maxAgeMs?: number;
}

/**
 * Turns a native frame reading into the shape the scan controller consumes.
 *
 * Deliberately a plain function rather than a method on the preview component.
 * The preview cannot be mounted in a host test - VisionCamera needs a camera -
 * so anything that lives there is untestable off a device, and this is the part
 * with rules in it.
 */
export function toFrameAnalysis(
  reading: FrameDocumentReading | null | undefined,
  options: ToFrameAnalysisOptions,
): FrameAnalysisResult | null {
  if (!reading) return null;

  const maxAge = options.maxAgeMs ?? FRAME_READING_MAX_AGE_MS;
  const observedAtMs = reading.timestampMs + options.frameClockOffsetMs;
  const ageMs = options.nowMs - observedAtMs;

  // A future-dated reading means the two clocks disagree rather than that the
  // reading is fresh, so treat it as unusable rather than as newest.
  const stale = ageMs > maxAge || ageMs < -maxAge;

  const status: FrameAnalysisResult['status'] = stale
    ? 'no-document'
    : isStatus(reading.status)
      ? reading.status
      : 'unsupported';

  return {
    status,
    // True because the analyzer answered at all. The scan controller refuses to
    // trust a reading without this, which is what kept auto-capture disabled
    // for as long as the detector was a stub.
    pluginLinked: true,
    evidenceScore: stale ? 0 : reading.evidenceScore,
    coverage: stale ? 0 : reading.coverage,
    normalizedQuad: stale ? null : quadOf(reading),
    source: 'vision-frame-plugin',
    timing: {
      startedAtMs: Math.round(observedAtMs),
      endedAtMs: Math.round(observedAtMs + reading.durationMs),
      durationMs: Math.round(reading.durationMs),
    },
  };
}
