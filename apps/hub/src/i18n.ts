import type { Locale, TaskStatus } from '@mowbot/contract';
import type { Db } from './db/client';
import { owner } from './db/schema';

/** The owner's language: what the apps show and what bots answer in. */
export async function ownerLocale(db: Db): Promise<Locale> {
  const [row] = await db.select({ locale: owner.locale }).from(owner).limit(1);
  return row?.locale ?? 'fr';
}

/** The owner's texts, in their language. */
export async function hubTexts(db: Db): Promise<HubTexts> {
  return HUB_TEXTS[await ownerLocale(db)];
}

/**
 * The texts the hub writes for the user to read: notifications, pushes, notes in the
 * conversations (bots' prompts stay in French). Anything the apps can word themselves is sent
 * as a code instead.
 */
export interface HubTexts {
  task: string;
  taskStatus: Record<TaskStatus, string>;
  replyIn: string;
  asks(bot: string): string;
  needsLogin(bot: string): string;
  loginToSave(what: string): string;
  needsTakeover(bot: string): string;
  takeoverReturned(computer: string): string;
  sessionsSaved(sites: string): string;
  sessionsSavedBody(count: number, computer: string): string;
  routineOff(name: string): string;
  routineOffBody(bot: string, failures: number, error: string): string;
  budgetBot(bot: string): string;
  budgetBotBody(spent: number, budget: number): string;
  budgetAll: string;
  budgetAllBody(spent: number, budget: number): string;
  finished(bot: string): string;
  failed(bot: string): string;
  /** The hub telling a bot to go on after the step limit (the n-th time in a row). */
  resumed(count: number, max: number): string;
  /** To a bot's lead: it kept hitting the step limit. */
  stuck(bot: string, times: number): string;
  needsYou(bot: string): string;
  newNotice(bot: string): string;
  vaultSaved(what: string): string;
  vaultDeclined(what: string): string;
  stoppedBy(bot: string, reason: string): string;
  automationWoke(name: string, text: string): string;
  automationPaused(name: string, failures: number): string;
  automationDone(name: string, reason: string): string;
  automationDeadline: string;
  automationFinished: string;
  /** A bot asks to run a command in a project of the user's computer. */
  commandAsk(bot: string, project: string, computer: string, command: string): string;
  /** Allow once, allow everything in the project (auto mode), refuse. */
  commandAnswers: readonly [string, string, string];
  /** The user picked the project the bot works in (null: none), as the conversation shows it. */
  projectChosen(project: string | null): string;
  /** Files both the user and the bots changed in a mirrored project (notification title). */
  mirrorConflicts(project: string, count: number): string;
  mirrorConflictsBody(files: string, where: string): string;
  /** The same, as the bots' conversations show it. */
  mirrorConflictsNote(project: string, count: number): string;
  /** Files deleted all at once in a mirror were put back (bots' conversations). */
  mirrorRestored(project: string, count: number): string;
  /** The page the browser lands on after signing in to an MCP server. */
  mcpSignIn: {
    lang: Locale;
    refused: string;
    incomplete: string;
    connected(server: string): string;
    connectedBody: string;
    failed: string;
  };
  /** The card of a web page a bot shares from its PC (share_preview). */
  preview: {
    /** For times ("18:42"). */
    locale: string;
    open: string;
    subtitle(address: string, until: string): string;
    text: string;
  };
}

export const HUB_TEXTS: Record<Locale, HubTexts> = {
  fr: {
    task: 'Tâche',
    taskStatus: {
      todo: 'à faire',
      doing: 'en cours',
      blocked: 'bloquée',
      done: 'terminée',
      cancelled: 'annulée',
    },
    replyIn: 'en français',
    asks: (bot) => `${bot} te pose une question`,
    needsLogin: (bot) => `${bot} a besoin d'un identifiant`,
    loginToSave: (what) => `${what} : à ranger dans le coffre depuis la conversation.`,
    needsTakeover: (bot) => `${bot} a besoin que tu prennes la main sur son PC`,
    takeoverReturned: (computer) => `🖱️ Main rendue sur ${computer}`,
    sessionsSaved: (sites) => `Coffre : ${sites}`,
    sessionsSavedBody: (count, computer) =>
      count > 1
        ? `Sessions ouvertes pendant ta prise de main sur ${computer}, enregistrées pour les bots des autres PC.`
        : `Session ouverte pendant ta prise de main sur ${computer}, enregistrée pour les bots des autres PC.`,
    routineOff: (name) => `Routine « ${name} » désactivée`,
    routineOffBody: (bot, failures, error) =>
      `${bot} a échoué ${failures} fois de suite : ${error}`,
    budgetBot: (bot) => `${bot} a atteint son budget du jour`,
    budgetBotBody: (spent, budget) =>
      `${spent} jetons dépensés sur ${budget}. Ses routines reprendront demain.`,
    budgetAll: 'Budget du jour atteint',
    budgetAllBody: (spent, budget) =>
      `${spent} jetons dépensés sur ${budget}. Les routines reprendront demain.`,
    finished: (bot) => `${bot} a fini`,
    failed: (bot) => `${bot} n'a pas pu finir`,
    resumed: (count, max) => `Reprise automatique après la limite d'étapes (${count}/${max})`,
    stuck: (bot, times) =>
      `**${bot} tourne en rond** · limite d'étapes atteinte ${times} fois de suite`,
    needsYou: (bot) => `${bot} a besoin de toi`,
    newNotice: (bot) => `${bot} : nouvelle notification`,
    vaultSaved: (what) => `🔒 ${what} rangé dans le coffre`,
    vaultDeclined: (what) => `Refusé : ${what}`,
    stoppedBy: (bot, reason) => `**Arrêté par ${bot}** · ${reason}`,
    automationWoke: (name, text) => `**Automatisation « ${name} »** · ${text}`,
    automationPaused: (name, failures) =>
      `**Automatisation « ${name} » en pause** · ${failures} échecs de suite`,
    automationDone: (name, reason) => `**Automatisation « ${name} » terminée** · ${reason}`,
    automationDeadline: 'échéance atteinte',
    automationFinished: 'terminée',
    commandAsk: (bot, project, computer, command) =>
      `${bot} veut lancer une commande dans « ${project} »${computer ? ` sur ${computer}` : ''} :\n${command}`,
    commandAnswers: ['Autoriser', 'Tout autoriser dans ce projet', 'Refuser'],
    projectChosen: (project) =>
      project ? `📁 Projet actif : ${project}` : '📁 Aucun projet actif',
    mirrorConflicts: (project, count) =>
      count > 1 ? `${count} conflits dans « ${project} »` : `Un conflit dans « ${project} »`,
    mirrorConflictsBody: (files, where) =>
      `Toi et les bots avez changé ${files}. Ta version est gardée ; celle des bots est dans ${where}.`,
    mirrorConflictsNote: (project, count) =>
      `⚠️ ${count > 1 ? `${count} conflits` : 'Un conflit'} dans ${project} : la version de l'utilisateur est gardée`,
    mirrorRestored: (project, count) =>
      `↩️ ${count} fichiers de ${project} supprimés d'un coup : remis depuis l'ordinateur`,
    mcpSignIn: {
      lang: 'fr',
      refused: 'Connexion refusée',
      incomplete: 'Réponse incomplète.',
      connected: (server) => `Connecté à ${server}`,
      connectedBody: 'Tes bots peuvent utiliser ses outils. Tu peux fermer cette page.',
      failed: 'Connexion impossible',
    },
    preview: {
      locale: 'fr-FR',
      open: 'Ouvrir',
      subtitle: (address, until) => `Aperçu · ${address} · jusqu'à ${until}`,
      text: 'Un lien privé, qui marche sur ton téléphone comme sur ton ordinateur. Il s’arrête quand le PC du bot s’éteint ou se met en veille.',
    },
  },
  en: {
    task: 'Task',
    taskStatus: {
      todo: 'to do',
      doing: 'in progress',
      blocked: 'blocked',
      done: 'done',
      cancelled: 'cancelled',
    },
    replyIn: 'en anglais (English)',
    asks: (bot) => `${bot} has a question for you`,
    needsLogin: (bot) => `${bot} needs a login`,
    loginToSave: (what) => `${what}: to save in the vault from the conversation.`,
    needsTakeover: (bot) => `${bot} needs you to take control of its PC`,
    takeoverReturned: (computer) => `🖱️ Handed ${computer} back`,
    sessionsSaved: (sites) => `Vault: ${sites}`,
    sessionsSavedBody: (count, computer) =>
      count > 1
        ? `Sessions opened while you had control of ${computer}, saved for the bots of other PCs.`
        : `Session opened while you had control of ${computer}, saved for the bots of other PCs.`,
    routineOff: (name) => `Routine “${name}” turned off`,
    routineOffBody: (bot, failures, error) => `${bot} failed ${failures} times in a row: ${error}`,
    budgetBot: (bot) => `${bot} reached its daily budget`,
    budgetBotBody: (spent, budget) =>
      `${spent} tokens spent out of ${budget}. Its routines resume tomorrow.`,
    budgetAll: 'Daily budget reached',
    budgetAllBody: (spent, budget) =>
      `${spent} tokens spent out of ${budget}. Routines resume tomorrow.`,
    finished: (bot) => `${bot} is done`,
    failed: (bot) => `${bot} couldn't finish`,
    resumed: (count, max) => `Resumed on its own after the step limit (${count}/${max})`,
    stuck: (bot, times) =>
      `**${bot} is going in circles** · step limit reached ${times} times in a row`,
    needsYou: (bot) => `${bot} needs you`,
    newNotice: (bot) => `${bot}: new notification`,
    vaultSaved: (what) => `🔒 ${what} saved in the vault`,
    vaultDeclined: (what) => `Declined: ${what}`,
    stoppedBy: (bot, reason) => `**Stopped by ${bot}** · ${reason}`,
    automationWoke: (name, text) => `**Automation “${name}”** · ${text}`,
    automationPaused: (name, failures) =>
      `**Automation “${name}” paused** · ${failures} failures in a row`,
    automationDone: (name, reason) => `**Automation “${name}” finished** · ${reason}`,
    automationDeadline: 'deadline reached',
    automationFinished: 'finished',
    commandAsk: (bot, project, computer, command) =>
      `${bot} wants to run a command in “${project}”${computer ? ` on ${computer}` : ''}:\n${command}`,
    commandAnswers: ['Allow', 'Allow everything in this project', 'Refuse'],
    projectChosen: (project) =>
      project ? `📁 Active project: ${project}` : '📁 No active project',
    mirrorConflicts: (project, count) =>
      count > 1 ? `${count} conflicts in “${project}”` : `A conflict in “${project}”`,
    mirrorConflictsBody: (files, where) =>
      `You and the bots both changed ${files}. Your version is kept; the bots’ is in ${where}.`,
    mirrorConflictsNote: (project, count) =>
      `⚠️ ${count > 1 ? `${count} conflicts` : 'A conflict'} in ${project}: the user’s version is kept`,
    mirrorRestored: (project, count) =>
      `↩️ ${count} files of ${project} deleted at once: put back from the computer`,
    mcpSignIn: {
      lang: 'en',
      refused: 'Sign-in refused',
      incomplete: 'Incomplete answer.',
      connected: (server) => `Connected to ${server}`,
      connectedBody: 'Your bots can use its tools. You can close this page.',
      failed: 'Could not sign in',
    },
    preview: {
      locale: 'en-GB',
      open: 'Open',
      subtitle: (address, until) => `Preview · ${address} · until ${until}`,
      text: 'A private link that works on your phone as well as your computer. It stops when the bot’s PC turns off or goes to sleep.',
    },
  },
};
