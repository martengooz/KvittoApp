import { withReduceMotion, MOTION_DURATIONS } from '../src/ui/motion';

describe('reduce motion helpers', () => {
  it('returns zero durations when reduce motion is enabled', () => {
    expect(withReduceMotion(MOTION_DURATIONS.fast, true)).toBe(0);
    expect(withReduceMotion(MOTION_DURATIONS.normal, true)).toBe(0);
  });

  it('preserves durations when reduce motion is disabled', () => {
    expect(withReduceMotion(MOTION_DURATIONS.fast, false)).toBe(MOTION_DURATIONS.fast);
    expect(withReduceMotion(MOTION_DURATIONS.slow, false)).toBe(MOTION_DURATIONS.slow);
  });
});
