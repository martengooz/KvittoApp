import type { ReactNode } from 'react';
import { useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';

import { CaptionText } from './typography';
import { colorToken } from './tokens';
import { haptic } from './haptics';

export interface SwipeAction {
  /** Spoken and shown. Include the subject: "Delete ICA Maxi", not "Delete". */
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

export type SwipeRowProps = {
  children: ReactNode;
  /** Revealed by swiping from the right edge, the iOS convention for actions. */
  actions: SwipeAction[];
};

/**
 * A list row whose actions are revealed by swiping.
 *
 * The actions are ordinary `Pressable`s inside the revealed panel rather than
 * gesture-driven callbacks. That keeps them reachable by VoiceOver, which
 * cannot perform a swipe, and testable by `react-test-renderer`, which cannot
 * either - the swipe only decides whether the panel is visible.
 */
export function SwipeRow({ children, actions }: SwipeRowProps) {
  const swipeable = useRef<SwipeableMethods | null>(null);

  if (actions.length === 0) return <>{children}</>;

  const renderActions = () => (
    <View style={styles.actions}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={() => {
            // Closing first keeps the row from staying open over a deleted item.
            swipeable.current?.close();
            action.onPress();
          }}
          style={({ pressed }) => [
            styles.action,
            action.destructive ? styles.actionDestructive : styles.actionNeutral,
            pressed ? styles.actionPressed : null,
          ]}
        >
          <CaptionText style={styles.actionLabel}>{action.label}</CaptionText>
        </Pressable>
      ))}
    </View>
  );

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={renderActions}
      onSwipeableWillOpen={() => haptic('impact')}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  action: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  actionNeutral: {
    backgroundColor: colorToken('surfaceSecondary'),
  },
  actionDestructive: {
    backgroundColor: colorToken('danger'),
  },
  actionPressed: {
    opacity: 0.7,
  },
  actionLabel: {
    textAlign: 'center',
  },
});
