import { Text, type TextProps, StyleSheet } from 'react-native';
import { colorToken } from './tokens';

type AppTextProps = TextProps & {
  tone?: 'primary' | 'secondary';
};

export function TitleText({ style, tone = 'primary', ...props }: AppTextProps) {
  return <Text allowFontScaling maxFontSizeMultiplier={1.8} style={[styles.title, toneStyles[tone], style]} {...props} />;
}

export function BodyText({ style, tone = 'secondary', ...props }: AppTextProps) {
  return <Text allowFontScaling maxFontSizeMultiplier={2.0} style={[styles.body, toneStyles[tone], style]} {...props} />;
}

export function CaptionText({ style, tone = 'secondary', ...props }: AppTextProps) {
  return <Text allowFontScaling maxFontSizeMultiplier={2.2} style={[styles.caption, toneStyles[tone], style]} {...props} />;
}

const styles = StyleSheet.create({
  title: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  body: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '500',
  },
  caption: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
});

const toneStyles = StyleSheet.create({
  primary: {
    color: colorToken('textPrimary'),
  },
  secondary: {
    color: colorToken('textSecondary'),
  },
});
