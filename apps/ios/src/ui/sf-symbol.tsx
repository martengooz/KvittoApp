import type { ComponentType } from 'react';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import { colorToken } from './tokens';

type SymbolViewComponent = ComponentType<{
  name: string;
  size?: number;
  tintColor?: ColorValue;
  weight?: 'regular' | 'semibold' | 'bold';
  resizeMode?: 'scaleAspectFit';
  accessibilityRole?: 'image';
  accessibilityLabel?: string;
  fallback?: React.ReactNode;
  style?: object;
}>;

/**
 * `expo-symbols` reaches for a native module at import time, so it is resolved
 * lazily. Off-device (host tests, tooling) the wrapper falls back to text rather
 * than failing to import.
 */
let symbolView: SymbolViewComponent | null | undefined;

function resolveSymbolView(): SymbolViewComponent | null {
  if (symbolView !== undefined) return symbolView;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    symbolView = (require('expo-symbols') as { SymbolView: SymbolViewComponent }).SymbolView;
  } catch {
    symbolView = null;
  }
  return symbolView;
}

export type SFSymbolProps = {
  name: string;
  /** Shown when the symbol cannot be rendered, and used as the accessible name. */
  fallbackText: string;
  size?: number;
  color?: ColorValue;
  accessibilityLabel?: string;
};

function SymbolFallback({ text, size, color }: { text: string; size: number; color: ColorValue }) {
  return (
    <Text allowFontScaling maxFontSizeMultiplier={1.4} style={[styles.fallback, { fontSize: size, color }]}>
      {text}
    </Text>
  );
}

export function SFSymbol({
  name,
  fallbackText,
  size = 18,
  /*
   * Passed through as a `ColorValue`, not stringified. `colorToken` returns a
   * `PlatformColor`, which is an opaque object: `String(...)` turns it into
   * "[object Object]", React Native cannot parse that as a colour, and the
   * element silently falls back to a default. That is how every tab-bar icon
   * came to render the same shade regardless of which tab was selected.
   */
  color = colorToken('textSecondary'),
  accessibilityLabel,
}: SFSymbolProps) {
  const SymbolView = resolveSymbolView();
  const label = accessibilityLabel ?? fallbackText;

  if (!SymbolView) {
    return (
      <View accessibilityRole="image" accessibilityLabel={label}>
        <SymbolFallback text={fallbackText} size={size} color={color} />
      </View>
    );
  }

  // Rendered without a wrapping View: a tab bar icon slot lays out the element
  // it is given, and an extra container leaves the native symbol unpositioned.
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      resizeMode="scaleAspectFit"
      style={{ width: size, height: size }}
      accessibilityRole="image"
      accessibilityLabel={label}
      // A symbol missing from this iOS version still renders something legible.
      fallback={<SymbolFallback text={fallbackText} size={size} color={color} />}
    />
  );
}

const styles = StyleSheet.create({
  fallback: {
    textAlign: 'center',
    fontWeight: '700',
    minWidth: 18,
  },
});
