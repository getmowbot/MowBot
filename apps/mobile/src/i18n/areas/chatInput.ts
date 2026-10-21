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
    pc: { title: 'Voir le PC', hint: 'L’écran du PC de {{name}}, en direct.' },
    files: { title: 'Fichiers', hint: 'Les fichiers de son espace de travail.' },
    settings: { title: 'Réglages', hint: 'Mission, modèle et réglages de {{name}}.' },
    mcp: { title: 'Outils (MCP)', hint: 'Les services branchés à tes bots.' },
    vault: { title: 'Coffre', hint: 'Les identifiants et secrets de tes bots.' },
    routines: { title: 'Routines', hint: 'Ce que {{name}} fait à heures fixes.' },
  },
  mentions: {
    bots: 'Bots',
    teams: 'Équipes',
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
    pc: { title: 'View the PC', hint: '{{name}}’s PC screen, live.' },
    files: { title: 'Files', hint: 'The files of its workspace.' },
    settings: { title: 'Settings', hint: '{{name}}’s mission, model and settings.' },
    mcp: { title: 'Tools (MCP)', hint: 'Services connected to your bots.' },
    vault: { title: 'Vault', hint: 'Your bots’ logins and secrets.' },
    routines: { title: 'Routines', hint: 'What {{name}} does on a schedule.' },
  },
  mentions: {
    bots: 'Bots',
    teams: 'Teams',
    files: 'Files',
    none: 'Nothing matches.',
    searching: 'Searching…',
  },
};
