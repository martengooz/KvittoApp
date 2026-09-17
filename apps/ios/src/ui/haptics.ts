import * as Haptics from 'expo-haptics';

/**
 * What the feedback means, not which generator to use. Callers describe the
 * outcome and this file decides how it feels, so the vocabulary stays
 * consistent across screens instead of each one picking a generator.
 */
export type HapticSignal =
  /** A destructive or irreversible action completed. */
  | 'success'
  /** Something was refused, or completed with a caveat worth noticing. */
  | 'warning'
  /** An action failed. */
  | 'error'
  /** A selection changed - a chip, a filter, a segmented choice. */
  | 'selection'
  /** A control was engaged, such as a row revealing its swipe actions. */
  | 'impact';

/**
 * Fires haptic feedback, and never throws.
 *
 * Feedback is decoration: a simulator has no Taptic Engine, and a device can
 * refuse in Low Power Mode. Letting that reject would turn a cosmetic detail
 * into a failed save, so every call is swallowed. There is nothing useful to
 * report to the user about a vibration that did not happen.
 */
export function haptic(signal: HapticSignal): void {
  try {
    switch (signal) {
      case 'success':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        return;
      case 'warning':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
        return;
      case 'error':
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        return;
      case 'selection':
        void Haptics.selectionAsync().catch(() => undefined);
        return;
      case 'impact':
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        return;
    }
  } catch {
    // The module is unavailable off-device; the action itself still happened.
  }
}
