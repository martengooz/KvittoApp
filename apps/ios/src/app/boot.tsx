import { Animated, StyleSheet, View } from 'react-native';
import { useEffect, useMemo, useRef } from 'react';
import { ScreenScaffold, SurfaceCard } from '../ui/controls';
import { BodyText, CaptionText, TitleText } from '../ui/typography';
import { MOTION_DURATIONS, useReduceMotionPreference, withReduceMotion } from '../ui/motion';

export type PlaceholderScreenProps = {
  title: string;
  subtitle: string;
};

export function PlaceholderScreen({ title, subtitle }: PlaceholderScreenProps) {
  const reduceMotion = useReduceMotionPreference();
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: withReduceMotion(MOTION_DURATIONS.normal, reduceMotion),
      useNativeDriver: true,
    }).start();
  }, [opacity, reduceMotion]);

  const diagnostics = useMemo(
    () => 'Packet 7 shell is active: tabs, stacks, startup guards, and native-safe accessibility defaults.',
    [],
  );

  return (
    <ScreenScaffold>
      <Animated.View style={[styles.wrapper, { opacity }]}>
        <TitleText accessibilityRole="header">{title}</TitleText>
        <BodyText>{subtitle}</BodyText>
        <SurfaceCard title="Shell diagnostics" body={diagnostics} />
        <View accessibilityRole="text">
          <CaptionText>
            Dynamic Type, reduce motion preferences, safe areas, and semantic accessibility labels are enabled by default.
          </CaptionText>
        </View>
      </Animated.View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    gap: 16,
  },
});
