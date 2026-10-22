import { Text, type TextProps } from 'react-native';
import { colors, themed, type } from '../../theme';

const TONES = themed(
  () =>
    ({
      default: colors.text,
      muted: colors.textMuted,
      faint: colors.textFaint,
      accent: colors.accentStrong,
      ink: colors.accentInk,
      danger: colors.danger,
    }) as const,
);

export type Tone = keyof typeof TONES;

export interface TProps extends TextProps {
  variant?: keyof typeof type;
  tone?: Tone;
}

/** Text in the app's type scale; React Native's default black text never shows. */
export function T({ variant = 'body', tone = 'default', style, ...props }: TProps) {
  return <Text {...props} style={[type[variant], { color: TONES[tone] }, style]} />;
}
