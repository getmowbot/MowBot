import type { Widen } from '../catalog';

/** Notifications push de ce téléphone : activation, ce qu'il reçoit, confidentialité. */
export const fr = {
  title: 'Notifications',
  on: 'Activées',
  off: 'Désactivées',
  subtitle: 'Ce que tes bots te signalent sur ce téléphone, même quand l’app est fermée.',
  master: 'Notifications sur ce téléphone',
  blocked: 'Les notifications de MowBot sont coupées dans les réglages du téléphone.',
  openSettings: 'Ouvrir les réglages',
  unavailable: {
    web: 'Les notifications ne fonctionnent que dans l’app, sur un téléphone.',
    simulator:
      'Les notifications ne fonctionnent que sur un vrai téléphone, pas sur un simulateur.',
    expoGoAndroid:
      'Sur Android, Expo Go ne reçoit plus de notifications : il faut une version installée de l’app (build de développement).',
  },
  what: 'Ce que tu reçois',
  finished: 'Quand un bot a fini ce que tu lui as demandé',
  needsYou: 'Quand un bot a besoin de toi',
  needsYouHint: 'Questions, identifiants à saisir.',
  notifications: 'Notifications des bots',
  notificationsHint: 'Urgentes et normales. Les normales respectent les heures calmes.',
  privacy: 'Confidentialité',
  hideContent: 'Masquer le contenu',
  hideContentHint:
    'Seulement « Chef a fini », « Chef a besoin de toi » : le texte des bots ne passe pas par Apple et Expo.',
  notSaved: 'Réglage non enregistré.',
  /** Android : nom du canal, dans les réglages du téléphone. */
  channel: 'Tes bots',
} as const;

export const en: Widen<typeof fr> = {
  title: 'Notifications',
  on: 'On',
  off: 'Off',
  subtitle: 'What your bots tell you on this phone, even when the app is closed.',
  master: 'Notifications on this phone',
  blocked: 'MowBot’s notifications are turned off in the phone’s settings.',
  openSettings: 'Open settings',
  unavailable: {
    web: 'Notifications only work in the app, on a phone.',
    simulator: 'Notifications only work on a real phone, not in a simulator.',
    expoGoAndroid:
      'On Android, Expo Go no longer receives notifications: it takes an installed build of the app (development build).',
  },
  what: 'What you get',
  finished: 'When a bot finishes what you asked',
  needsYou: 'When a bot needs you',
  needsYouHint: 'Questions, logins to enter.',
  notifications: 'Bots’ notifications',
  notificationsHint: 'Urgent and normal ones. Normal ones respect quiet hours.',
  privacy: 'Privacy',
  hideContent: 'Hide the content',
  hideContentHint:
    'Only “Chef is done”, “Chef needs you”: your bots’ words don’t go through Apple and Expo.',
  notSaved: 'Setting not saved.',
  channel: 'Your bots',
};
