import {
  type EntryExitAnimationFunction,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { springs } from '../theme';

const SOFT = springs.soft;

/**
 * Elements arrive by settling into place: fade, slight rise and scale, on a critically damped
 * spring (no bounce). `step` staggers siblings. Never put it on a Liquid Glass view: fading a
 * glass view's parent from 0 kills the effect (Surface materializes on its own instead).
 */
export function reveal(step = 0): EntryExitAnimationFunction {
  const delay = step * 45;
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 10 }, { scale: 0.985 }] },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: 260 })),
        transform: [
          { translateY: withDelay(delay, withSpring(0, SOFT)) },
          { scale: withDelay(delay, withSpring(1, SOFT)) },
        ],
      },
    };
  };
}
