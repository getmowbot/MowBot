import type { Widen } from '../catalog';

/** Un bot demande, dans la conversation, que l'utilisateur prenne la main sur son PC. */
export const fr = {
  title: '{{name}} a besoin de toi sur son PC',
  take: 'Prendre le contrôle',
  release: 'Rendre la main',
  showScreen: 'Voir l’écran',
  inControl: 'Tu as la main. Rends-la quand tu as fini : {{name}} reprendra.',
  otherDevice: 'Un autre de tes appareils a la main sur ce PC.',
  returned: 'Main rendue',
} as const;

export const en: Widen<typeof fr> = {
  title: '{{name}} needs you on its PC',
  take: 'Take control',
  release: 'Give back control',
  showScreen: 'Show the screen',
  inControl: 'You have control. Give it back when you’re done: {{name}} will pick up.',
  otherDevice: 'Another of your devices has control of this PC.',
  returned: 'Control given back',
};
