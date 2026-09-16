import type { ReactElement } from 'react';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import { colorToken } from './tokens';

type NativeSymbolModule = {
  SFSymbol: (props: {
    name: string;
    weight?: 'regular' | 'semibold' | 'bold';
    scale?: 'small' | 'medium' | 'large';
    color?: ColorValue;
    style?: object;
  }) => ReactElement;
};

let nativeSymbols: NativeSymbolModule | null = null;

try {
  nativeSymbols = require('react-native-sfsymbols') as NativeSymbolModule;
} catch {
  nativeSymbols = null;
}

export type SFSymbolProps = {
  name: string;
  fallbackText: string;
  size?: number;
  color?: ColorValue;
  accessibilityLabel?: string;
};

export function SFSymbol({
  name,
  fallbackText,
  size = 18,
  color = String(colorToken('textSecondary')),
  accessibilityLabel,
}: SFSymbolProps) {
  if (nativeSymbols?.SFSymbol) {
    return (
      <View accessibilityRole="image" accessibilityLabel={accessibilityLabel ?? fallbackText}>
        <nativeSymbols.SFSymbol name={name} color={color} style={{ width: size, height: size }} />
      </View>
    );
  }

  return (
    <Text
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? fallbackText}
      allowFontScaling
      maxFontSizeMultiplier={1.4}
      style={[styles.fallback, { fontSize: size, color: String(color) }]}
    >
      {fallbackText}
    </Text>
  );
}

const styles = StyleSheet.create({
  fallback: {
    textAlign: 'center',
    fontWeight: '700',
    minWidth: 18,
  },
});
