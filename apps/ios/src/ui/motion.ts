import { AccessibilityInfo } from 'react-native';
import { useEffect, useState } from 'react';

export const MOTION_DURATIONS = {
  fast: 140,
  normal: 220,
  slow: 320,
} as const;

export function withReduceMotion(durationMs: number, reduceMotion: boolean): number {
  return reduceMotion ? 0 : durationMs;
}

export function useReduceMotionPreference(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) {
          setReduceMotion(enabled);
        }
      })
      .catch(() => {
        if (mounted) {
          setReduceMotion(false);
        }
      });

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);

    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
