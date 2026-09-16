import { Platform, PlatformColor, type ColorValue } from 'react-native';

export type SystemColorToken =
  | 'background'
  | 'surface'
  | 'surfaceSecondary'
  | 'textPrimary'
  | 'textSecondary'
  | 'accent'
  | 'accentPressed'
  | 'danger';

const iosColorMap: Record<SystemColorToken, string> = {
  background: 'systemGroupedBackground',
  surface: 'secondarySystemGroupedBackground',
  surfaceSecondary: 'tertiarySystemGroupedBackground',
  textPrimary: 'label',
  textSecondary: 'secondaryLabel',
  accent: 'systemBlue',
  accentPressed: 'systemIndigo',
  danger: 'systemRed',
};

const fallbackColorMap: Record<SystemColorToken, string> = {
  background: '#f4f5f7',
  surface: '#ffffff',
  surfaceSecondary: '#e8ebf0',
  textPrimary: '#0f1c24',
  textSecondary: '#415564',
  accent: '#0066cc',
  accentPressed: '#264d8f',
  danger: '#b52a2a',
};

export function colorToken(token: SystemColorToken): ColorValue {
  if (Platform.OS === 'ios') {
    return PlatformColor(iosColorMap[token]);
  }

  return fallbackColorMap[token];
}
