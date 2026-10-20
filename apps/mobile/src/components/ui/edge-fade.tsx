import MaskedView from '@react-native-masked-view/masked-view';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { isIOS } from '../../lib/platform';

interface Props {
  /** The screen edge the fade grows toward. */
  edge: 'top' | 'bottom';
  /** Where it sits (absolute), under the floating chrome. */
  style?: StyleProp<ViewStyle>;
}

const toward = {
  top: { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
  bottom: { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
} as const;

/**
 * What scrolls under floating chrome melts away: a blur that grows toward the screen's edge
 * (iOS; Android has no live blur in Expo Go) over a darkening of the background color.
 */
export function EdgeFade({ edge, style }: Props) {
  const direction = toward[edge];
  return (
    <View pointerEvents="none" style={style}>
      {isIOS && (
        <MaskedView
          style={StyleSheet.absoluteFill}
          maskElement={
            <LinearGradient
              colors={['transparent', 'black', 'black']}
              locations={[0, 0.5, 1]}
              {...direction}
              style={StyleSheet.absoluteFill}
            />
          }
        >
          <BlurView tint="dark" intensity={28} style={StyleSheet.absoluteFill} />
        </MaskedView>
      )}
      <LinearGradient
        colors={['rgba(6, 7, 10, 0)', 'rgba(6, 7, 10, 0.55)', 'rgba(6, 7, 10, 0.88)']}
        locations={[0, 0.55, 1]}
        {...direction}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}
