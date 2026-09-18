import { describe, expect, test } from '@jest/globals';

import type { FrameDocumentReading } from '../modules/kvitto-frames/src';
import {
  FRAME_READING_MAX_AGE_MS,
  toFrameAnalysis,
} from '../src/features/scan/frame-analysis';

function reading(overrides: Partial<FrameDocumentReading> = {}): FrameDocumentReading {
  return {
    status: 'ready',
    evidenceScore: 0.72,
    coverage: 0.41,
    durationMs: 14,
    timestampMs: 5_000,
    quad: {
      topLeftX: 0.1,
      topLeftY: 0.9,
      topRightX: 0.9,
      topRightY: 0.9,
      bottomRightX: 0.9,
      bottomRightY: 0.1,
      bottomLeftX: 0.1,
      bottomLeftY: 0.1,
    },
    ...overrides,
  };
}

// Frame timestamps count from an arbitrary origin, so a test has to say where
// wall time sits relative to the frame clock, exactly as the preview does.
const OFFSET = 1_000_000;

describe('frame reading to scan analysis', () => {
  test('a fresh reading is trusted and carries its quad through unflipped', () => {
    const analysis = toFrameAnalysis(reading(), {
      nowMs: OFFSET + 5_050,
      frameClockOffsetMs: OFFSET,
    });

    expect(analysis).not.toBeNull();
    expect(analysis?.status).toBe('ready');
    expect(analysis?.pluginLinked).toBe(true);
    expect(analysis?.evidenceScore).toBeCloseTo(0.72);
    expect(analysis?.coverage).toBeCloseTo(0.41);
    expect(analysis?.source).toBe('vision-frame-plugin');
    // Vision's bottom-left origin, kept: the same quad goes back in as
    // `forcedQuad` for perspective correction, so flipping here would crop a
    // live-frame capture differently from a still.
    expect(analysis?.normalizedQuad?.topLeft).toEqual({ x: 0.1, y: 0.9 });
    expect(analysis?.normalizedQuad?.bottomRight).toEqual({ x: 0.9, y: 0.1 });
  });

  test('clears the score and the quad once the reading goes stale', () => {
    // The analyzer holds its last reading until the next replaces it. When
    // frames stop - preview paused, app backgrounded, pipeline stalled - that
    // reading would otherwise keep arming auto-capture over a scene that is no
    // longer in front of the camera.
    const analysis = toFrameAnalysis(reading(), {
      nowMs: OFFSET + 5_000 + FRAME_READING_MAX_AGE_MS + 1,
      frameClockOffsetMs: OFFSET,
    });

    expect(analysis?.status).toBe('no-document');
    expect(analysis?.evidenceScore).toBe(0);
    expect(analysis?.coverage).toBe(0);
    expect(analysis?.normalizedQuad).toBeNull();
  });

  test('a reading from the future is disagreement between clocks, not freshness', () => {
    const analysis = toFrameAnalysis(reading(), {
      nowMs: OFFSET + 5_000 - FRAME_READING_MAX_AGE_MS - 1,
      frameClockOffsetMs: OFFSET,
    });

    expect(analysis?.status).toBe('no-document');
    expect(analysis?.evidenceScore).toBe(0);
  });

  test('a reading right on the age limit still counts', () => {
    const analysis = toFrameAnalysis(reading(), {
      nowMs: OFFSET + 5_000 + FRAME_READING_MAX_AGE_MS,
      frameClockOffsetMs: OFFSET,
    });

    expect(analysis?.status).toBe('ready');
    expect(analysis?.evidenceScore).toBeCloseTo(0.72);
  });

  test('no reading yet means no analysis, not an empty one', () => {
    // The difference matters upstream: the bridge reports `unsupported` for
    // null, which keeps auto-capture disabled, whereas a zero-score reading
    // would claim the detector had looked and found nothing.
    expect(toFrameAnalysis(null, { nowMs: 1, frameClockOffsetMs: 0 })).toBeNull();
    expect(toFrameAnalysis(undefined, { nowMs: 1, frameClockOffsetMs: 0 })).toBeNull();
  });

  test('a frame with no document keeps its status and reports no quad', () => {
    const analysis = toFrameAnalysis(
      reading({ status: 'no-document', evidenceScore: 0, coverage: 0, quad: undefined }),
      { nowMs: OFFSET + 5_010, frameClockOffsetMs: OFFSET },
    );

    expect(analysis?.status).toBe('no-document');
    expect(analysis?.normalizedQuad).toBeNull();
    // Still linked: the detector ran and answered. Reporting otherwise would
    // be indistinguishable from having no detector at all.
    expect(analysis?.pluginLinked).toBe(true);
  });

  test('an unrecognised status degrades to unsupported rather than passing through', () => {
    const analysis = toFrameAnalysis(reading({ status: 'something-new' }), {
      nowMs: OFFSET + 5_010,
      frameClockOffsetMs: OFFSET,
    });

    expect(analysis?.status).toBe('unsupported');
  });

  test('timing is reported against wall time, not the frame clock', () => {
    const analysis = toFrameAnalysis(reading({ durationMs: 20 }), {
      nowMs: OFFSET + 5_010,
      frameClockOffsetMs: OFFSET,
    });

    expect(analysis?.timing.startedAtMs).toBe(OFFSET + 5_000);
    expect(analysis?.timing.endedAtMs).toBe(OFFSET + 5_020);
    expect(analysis?.timing.durationMs).toBe(20);
  });
});
