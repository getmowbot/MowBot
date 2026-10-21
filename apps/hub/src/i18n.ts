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
  /** The page the browser lands on after signing in to an MCP server. */
  mcpSignIn: {
    lang: Locale;
    refused: string;
    incomplete: string;
    connected(server: string): string;
    connectedBody: string;
    failed: string;
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
    mcpSignIn: {
      lang: 'fr',
      refused: 'Connexion refusée',
      incomplete: 'Réponse incomplète.',
      connected: (server) => `Connecté à ${server}`,
      connectedBody: 'Tes bots peuvent utiliser ses outils. Tu peux fermer cette page.',
      failed: 'Connexion impossible',
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
    mcpSignIn: {
      lang: 'en',
      refused: 'Sign-in refused',
      incomplete: 'Incomplete answer.',
      connected: (server) => `Connected to ${server}`,
      connectedBody: 'Your bots can use its tools. You can close this page.',
      failed: 'Could not sign in',
    },
  },
};
