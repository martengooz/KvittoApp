import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';
import type { ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BodyText, CaptionText, TitleText } from './typography';
import { colorToken } from './tokens';

type ScreenScaffoldProps = ViewProps & {
  children: ReactNode;
  /**
   * Whether to inset for the status bar and notch at the top.
   *
   * Off by default, because almost every screen in this app sits under a
   * navigation or tab header and React Navigation has already inset the
   * content below it. Claiming the top edge as well adds the same inset twice
   * and leaves a band of empty background between the header and the first
   * control.
   *
   * A screen with `headerShown: false` in its route contract - the filters
   * sheet - has nothing above it and turns this on.
   */
  insetTop?: boolean;
};

export function ScreenScaffold({ children, style, insetTop = false, ...props }: ScreenScaffoldProps) {
  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={insetTop ? ['top', 'left', 'right', 'bottom'] : ['left', 'right', 'bottom']}
    >
      <View style={[styles.content, style]} {...props}>
        {children}
      </View>
    </SafeAreaView>
  );
}

type SurfaceCardProps = {
  title: string;
  body: string;
};

export function SurfaceCard({ title, body }: SurfaceCardProps) {
  return (
    <View accessibilityRole="summary" accessibilityLabel={`${title}. ${body}`} style={styles.card}>
      <TitleText style={styles.cardTitle}>{title}</TitleText>
      <BodyText>{body}</BodyText>
    </View>
  );
}

type PrimaryButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export function PrimaryButton({ label, onPress, disabled = false }: PrimaryButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        pressed ? styles.buttonPressed : undefined,
        disabled ? styles.buttonDisabled : undefined,
      ]}
    >
      <BodyText tone="primary" style={styles.buttonLabel}>
        {label}
      </BodyText>
    </Pressable>
  );
}

type LoadingStateProps = {
  message: string;
};

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <ScreenScaffold accessibilityRole="progressbar" accessibilityLabel={message}>
      <CaptionText>{message}</CaptionText>
    </ScreenScaffold>
  );
}

type DiagnosticsRecoveryStateProps = {
  title: string;
  details: string;
  onRetry: () => void;
};

export function DiagnosticsRecoveryState({ title, details, onRetry }: DiagnosticsRecoveryStateProps) {
  return (
    <ScreenScaffold>
      <SurfaceCard title={title} body={details} />
      <PrimaryButton label="Retry startup" onPress={onRetry} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colorToken('background'),
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 22,
    gap: 16,
  },
  card: {
    width: '100%',
    borderRadius: 16,
    backgroundColor: colorToken('surface'),
    borderColor: colorToken('surfaceSecondary'),
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 20,
    paddingHorizontal: 18,
    gap: 8,
  },
  cardTitle: {
    marginBottom: 4,
  },
  button: {
    minHeight: 48,
    borderRadius: 14,
    minWidth: 180,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colorToken('accent'),
    paddingHorizontal: 16,
  },
  buttonPressed: {
    backgroundColor: colorToken('accentPressed'),
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonLabel: {
    color: '#ffffff',
    fontWeight: '700',
  },
});
