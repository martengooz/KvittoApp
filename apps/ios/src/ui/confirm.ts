import { Alert } from 'react-native';

export interface ConfirmRequest {
  title: string;
  /** What will actually change. Not "Are you sure?" - say what happens. */
  message: string;
  /** Label for the destructive choice, e.g. "Delete receipt". */
  confirmLabel: string;
  cancelLabel?: string;
}

/**
 * Asks the user to confirm a destructive action through a native alert.
 *
 * Injectable so screens stay renderable in tests: `Alert.alert` does nothing
 * under `react-test-renderer`, and a test that cannot answer the prompt could
 * never reach the code past it.
 */
export type ConfirmPort = (request: ConfirmRequest) => Promise<boolean>;

/** The real prompt. Cancel is the dismiss action, so a swipe-away is a no. */
export const nativeConfirm: ConfirmPort = (request) =>
  new Promise((resolve) => {
    Alert.alert(
      request.title,
      request.message,
      [
        { text: request.cancelLabel ?? 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: request.confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

/** Confirms without asking. For tests that are exercising what comes after. */
export const alwaysConfirm: ConfirmPort = () => Promise.resolve(true);

/** Refuses without asking. For tests that assert nothing happened. */
export const neverConfirm: ConfirmPort = () => Promise.resolve(false);
