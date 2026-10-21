import type { Widen } from '../catalog';

/** Ce que propose le champ de message : les commandes en /, les mentions en @. */
export const fr = {
  suggestions: 'Suggestions',
  commands: {
    stop: { title: 'Arrêter', hint: 'Interrompt ce que fait {{name}}.' },
    clear: {
      title: 'Vider la conversation',
      hint: 'Repartir de zéro : {{name}} oublie tout ce qui a été dit.',
    },
    project: { title: 'Projet', hint: 'Le dossier de ton ordinateur où {{name}} travaille.' },
    model: { title: 'Modèle', hint: 'Le modèle avec lequel {{name}} réfléchit.' },
    pc: { title: 'Voir le PC', hint: 'L’écran du PC de {{name}}, en direct.' },
    files: { title: 'Fichiers', hint: 'Les fichiers de son espace de travail.' },
    settings: { title: 'Réglages', hint: 'Mission, modèle et réglages de {{name}}.' },
    mcp: { title: 'Outils (MCP)', hint: 'Les services branchés à tes bots.' },
    vault: { title: 'Coffre', hint: 'Les identifiants et secrets de tes bots.' },
    routines: { title: 'Routines', hint: 'Ce que {{name}} fait à heures fixes.' },
  },
  /** `/model`: the models of the providers, to pick the bot's. */
  model: {
    current: 'modèle actuel',
    loading: 'Chargement des modèles…',
    unreachable: 'liste indisponible',
    more_one: '{{count}} autre : précise ta recherche',
    more_other: '{{count}} autres : précise ta recherche',
    none: 'Aucun modèle ne correspond à « {{query}} ».',
    noProvider: 'Aucun fournisseur de modèles : ajoute-en un dans Réglages → Modèles.',
    noModels: 'Tes fournisseurs ne proposent aucun modèle.',
    set: '{{name}} utilise maintenant {{model}}.',
    failed: 'Le modèle n’a pas pu être changé.',
  },
  mentions: {
    bots: 'Bots',
    teams: 'Équipes',
    projects: 'Projets',
    files: 'Fichiers',
    none: 'Rien ne correspond.',
    searching: 'Recherche…',
  },
};

export const en: Widen<typeof fr> = {
  suggestions: 'Suggestions',
  commands: {
    stop: { title: 'Stop', hint: 'Interrupts what {{name}} is doing.' },
    clear: {
      title: 'Clear conversation',
      hint: 'Start over: {{name}} forgets everything that was said.',
    },
    project: { title: 'Project', hint: 'The folder of your computer where {{name}} works.' },
    model: { title: 'Model', hint: 'The model {{name}} thinks with.' },
    pc: { title: 'View the PC', hint: '{{name}}’s PC screen, live.' },
    files: { title: 'Files', hint: 'The files of its workspace.' },
    settings: { title: 'Settings', hint: '{{name}}’s mission, model and settings.' },
    mcp: { title: 'Tools (MCP)', hint: 'Services connected to your bots.' },
    vault: { title: 'Vault', hint: 'Your bots’ logins and secrets.' },
    routines: { title: 'Routines', hint: 'What {{name}} does on a schedule.' },
  },
  model: {
    current: 'current model',
    loading: 'Loading models…',
    unreachable: 'list unavailable',
    more_one: '{{count}} more: keep typing to narrow it down',
    more_other: '{{count}} more: keep typing to narrow it down',
    none: 'No model matches “{{query}}”.',
    noProvider: 'No model provider yet: add one in Settings → Models.',
    noModels: 'Your providers offer no models.',
    set: '{{name}} now uses {{model}}.',
    failed: 'The model could not be changed.',
  },
  mentions: {
    bots: 'Bots',
    teams: 'Teams',
    projects: 'Projects',
    files: 'Files',
    none: 'Nothing matches.',
    searching: 'Searching…',
  },
};
