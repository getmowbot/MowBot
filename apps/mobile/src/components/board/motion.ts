import { FadeOut, LinearTransition } from 'react-native-reanimated';
import { springs } from '../../theme';

/** Cards sliding into their new place (reordered, one above removed) on the soft spring. */
export const settle = LinearTransition.springify()
  .stiffness(springs.soft.stiffness)
  .damping(springs.soft.damping)
  .mass(springs.soft.mass);

/** Leaving cards (answered, deleted) fade quickly. */
export const leave = FadeOut.duration(160);
