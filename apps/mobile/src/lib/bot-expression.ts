import { type Expression, isBusy, springs } from '@mowbot/design';
import type { BotMood } from './bot-mood';

/**
 * The expression a mood change brings: a beat of joy when a bot goes back to idle from a busy
 * mood (it is done), the new mood otherwise.
 */
export function expressionAfter(was: BotMood, mood: BotMood): Expression {
  return mood === 'idle' && isBusy(was) ? 'happy' : mood;
}

export interface Glance {
  /** Peak horizontal stretch of the eyes (scaleX). */
  peak: number;
  /** Time to reach it, then to settle back (ms). */
  rise: number;
  fall: number;
}

/**
 * How much a glance stretches the eyes sideways. The web stretches them with the gaze speed
 * (1 + |speed| × 0.035, up to 1.28); here the speed is the spring's peak for a horizontal move
 * of `dx` (gaze units), and the timings follow its speed curve. `soft`: the slow drift spring.
 */
export function glanceStretch(dx: number, soft: boolean): Glance {
  const { stiffness, mass } = soft ? springs.drift : springs.gaze;
  const omega = Math.sqrt(stiffness / mass);
  // A (near) critically damped spring peaks at about a third of distance × ω, after 1/ω.
  const speed = Math.abs(dx) * omega * 0.35;
  return { peak: 1 + Math.min(0.28, speed * 0.035), rise: 1000 / omega, fall: 4000 / omega };
}

/** 0 → 1 → 0 over a cycle, easing in and out (a bounce, a pulse). */
export function bump(progress: number): number {
  'worklet';
  return (1 - Math.cos(2 * Math.PI * progress)) / 2;
}

/** Three keyframes over a cycle (start, middle, end), easing out between each. */
export function keyframes(progress: number, from: number, middle: number, to: number): number {
  'worklet';
  const late = progress > 0.5;
  const local = late ? progress * 2 - 1 : progress * 2;
  const eased = 1 - (1 - local) * (1 - local);
  return late ? middle + (to - middle) * eased : from + (middle - from) * eased;
}
