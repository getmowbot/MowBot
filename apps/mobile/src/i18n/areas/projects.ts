import type { Widen } from '../catalog';

/** Les projets : des dossiers des ordinateurs de l’utilisateur, partagés par l’app desktop. */
export const fr = {
  title: 'Projets',
  intro:
    'Des dossiers de ton ordinateur où tes bots travaillent, comme avec un assistant de code : ils lisent, modifient, cherchent et lancent des commandes.',
  desktopNote: 'Les dossiers se partagent depuis l’app desktop MowBot, sur ton ordinateur.',
  count_one: '{{count}} projet',
  count_other: '{{count}} projets',
  none: 'Aucun',
  loadFailed: 'Impossible de charger les projets.',
  notFound: 'Ce dossier n’est plus partagé.',
  emptyState: {
    title: 'Aucun projet partagé pour l’instant.',
    install: 'Installe l’app desktop MowBot sur ton ordinateur et relie-la à ce hub.',
    share: 'Partage un dossier depuis l’app : il apparaît ici, sur tous tes appareils.',
  },
  online: 'en ligne',
  offline: 'hors ligne',
  lastSeen: 'vu {{time}}',
  neverSeen: 'jamais connecté',
  modes: {
    ask: 'Commandes sur accord',
    auto: 'Commandes sans demander',
  },
  info: {
    title: 'Dossier',
    name: 'Nom',
    path: 'Emplacement',
    computer: 'Ordinateur',
    offlineNote:
      '{{computer}} est hors ligne : tes bots y travailleront dès que l’app desktop sera ouverte.',
    unshareNote: 'Pour ne plus partager ce dossier, retire-le dans l’app desktop de {{computer}}.',
  },
  rename: {
    title: 'Renommer le projet',
    message: 'Tes bots le désignent par ce nom.',
    action: 'Renommer',
    notSaved: 'Nom non enregistré.',
  },
  mode: {
    title: 'Commandes',
    auto: 'Commandes sans demander',
    hint: 'Sinon, chaque commande attend ton accord. Les fichiers se lisent et s’écrivent librement.',
    notSaved: 'Réglage non enregistré.',
  },
  scope: {
    title: 'Qui peut l’utiliser',
    notSaved: 'Bots concernés non enregistrés.',
  },
  computers: {
    title: 'Ordinateurs reliés',
    unknown: 'Ordinateur délié',
    projects_one: '{{count}} dossier partagé',
    projects_other: '{{count}} dossiers partagés',
    noProjects: 'Aucun dossier partagé',
    unlink: 'Délier',
    unlinkLabel: 'Délier {{name}}',
    unlinkConfirm: 'Délier « {{name}} » ?',
    unlinkHint:
      'Son app desktop est déconnectée et ses projets disparaissent : tes bots ne peuvent plus y travailler. Les fichiers restent sur l’ordinateur.',
  },
  problems: {
    name: 'Donne-lui un nom.',
    nameLong: 'Ce nom est trop long (80 caractères au plus).',
    scope: 'Choisis au moins une équipe ou un bot.',
    not_found: 'Introuvable : ce projet n’est peut-être plus partagé.',
  },
  /** Le projet où travaille un bot, choisi dans sa conversation. */
  active: {
    title: 'Projet de travail',
    message: 'Les outils de {{name}} sur ton ordinateur y vont par défaut.',
    offline: 'Hors ligne : {{name}} y accède dès que l’app desktop est ouverte sur cet ordinateur.',
    none: 'Aucun projet',
    label: 'Projet de travail : {{project}}',
    notSaved: 'Projet non changé.',
  },
} as const;

export const en: Widen<typeof fr> = {
  title: 'Projects',
  intro:
    'Folders of your computer where your bots work, like a code assistant: they read, edit, search and run commands.',
  desktopNote: 'Folders are shared from the MowBot desktop app, on your computer.',
  count_one: '{{count}} project',
  count_other: '{{count}} projects',
  none: 'None',
  loadFailed: 'Couldn’t load the projects.',
  notFound: 'This folder is no longer shared.',
  emptyState: {
    title: 'No shared projects yet.',
    install: 'Install the MowBot desktop app on your computer and link it to this hub.',
    share: 'Share a folder from the app: it shows up here, on all your devices.',
  },
  online: 'online',
  offline: 'offline',
  lastSeen: 'seen {{time}}',
  neverSeen: 'never connected',
  modes: {
    ask: 'Commands on approval',
    auto: 'Commands without asking',
  },
  info: {
    title: 'Folder',
    name: 'Name',
    path: 'Location',
    computer: 'Computer',
    offlineNote: '{{computer}} is offline: your bots will work there once the desktop app is open.',
    unshareNote: 'To stop sharing this folder, remove it in the desktop app of {{computer}}.',
  },
  rename: {
    title: 'Rename the project',
    message: 'Your bots refer to it by this name.',
    action: 'Rename',
    notSaved: 'Name not saved.',
  },
  mode: {
    title: 'Commands',
    auto: 'Run commands without asking',
    hint: 'Otherwise, each command waits for your approval. Files are read and written freely.',
    notSaved: 'Setting not saved.',
  },
  scope: {
    title: 'Who can use it',
    notSaved: 'Bots not saved.',
  },
  computers: {
    title: 'Linked computers',
    unknown: 'Unlinked computer',
    projects_one: '{{count}} shared folder',
    projects_other: '{{count}} shared folders',
    noProjects: 'No shared folders',
    unlink: 'Unlink',
    unlinkLabel: 'Unlink {{name}}',
    unlinkConfirm: 'Unlink “{{name}}”?',
    unlinkHint:
      'Its desktop app is disconnected and its projects go away: your bots can no longer work there. The files stay on the computer.',
  },
  problems: {
    name: 'Give it a name.',
    nameLong: 'This name is too long (80 characters at most).',
    scope: 'Pick at least one team or bot.',
    not_found: 'Not found: this project may no longer be shared.',
  },
  active: {
    title: 'Working project',
    message: '{{name}}’s tools on your computer go there by default.',
    offline: 'Offline: {{name}} reaches it once the desktop app is open on that computer.',
    none: 'No project',
    label: 'Working project: {{project}}',
    notSaved: 'Project not changed.',
  },
};
