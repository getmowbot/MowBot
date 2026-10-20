import { StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { reveal } from '../reveal';
import { T } from '../ui/text';

/** Why the form was refused, under the form, above its buttons. */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <Animated.View entering={reveal()} accessibilityLiveRegion="polite">
      <T variant="footnote" tone="danger" style={styles.text}>
        {message}
      </T>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  text: { paddingHorizontal: 4 },
});
