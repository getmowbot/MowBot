import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { BotRow } from '../bots/service';
import {
  type AutomationRow,
  type AutomationService,
  MIN_INTERVAL_SECONDS,
} from '../proactivity/automations';

const describe = (row: AutomationRow) =>
  [
    `- ${row.name} (${row.status === 'active' ? 'active' : row.status === 'paused' ? 'en pause' : 'terminée'}) : toutes les ${row.intervalSeconds} s`,
    `  commande : ${row.command}`,
    row.until ? `  jusqu'au ${row.until.toISOString()}` : '',
    row.lastResult ? `  dernier passage : ${row.lastResult}` : '',
    row.stoppedReason ? `  arrêt : ${row.stoppedReason}` : '',
  ]
    .filter(Boolean)
    .join('\n');

/**
 * Automations: a script the bot wrote, run by the hub on its PC at a steady pace, without
 * waking the bot. Its JSON output updates a canvas, notifies the user or wakes the bot.
 */
export function buildAutomationTools(ctx: {
  self: BotRow;
  automations: AutomationService;
}): ToolSet {
  const { self, automations } = ctx;
  const tools: ToolSet = {};
  if (!self.computerId) return tools;

  tools.automation_create = tool({
    description: [
      "Fait tourner un de tes scripts sur ton PC à intervalle régulier, sans te réveiller (pas de modèle, pas de jetons) : pour un score en direct, un cours, un suivi de colis, une surveillance de prix. Écris d'abord le script (python3, node ou bash, dans ton dossier) et teste-le avec bash.",
      'Le script affiche sur sa dernière ligne un objet JSON :',
      '- "canvas": {"title"?: "...", "content": {...}} : le nouveau contenu du canvas suivi, au même format que canvas_set (ex. {"kind": "score", "home": {"name": "PSG"}, "away": {"name": "OM"}, "home_score": 2, "away_score": 1, "status": "72e"}, ou {"kind": "html", "html": "..."}) ;',
      '- "notify": {"title": "...", "body"?: "...", "priority"?: "normal" | "urgent"} : prévient l\'utilisateur (téléphone compris) ;',
      '- "wake": "..." : te réveille avec ce message, quand il faut réfléchir ou agir ;',
      '- "done": true ou "raison" : c\'est fini (match terminé…), l\'automatisation s\'arrête.',
      "Il peut tout combiner, ou n'afficher que {} quand il n'y a rien de neuf. Les {{vault:ref.champ}} de la commande sont remplis au lancement. Un premier passage est fait tout de suite : corrige le script s'il échoue. Arrête l'automatisation (done, until ou automation_delete) dès qu'elle ne sert plus.",
    ].join('\n'),
    inputSchema: z.object({
      name: z.string().trim().min(1).max(80).describe('Ex. « Score PSG-OM en direct »'),
      command: z
        .string()
        .min(1)
        .max(2_000)
        .describe('Commande lancée dans /workspace, ex. python3 bots/marco/score.py'),
      every_seconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(86_400),
      canvas: z
        .string()
        .max(60)
        .optional()
        .describe('Clé du canvas à tenir à jour (déjà épinglé avec canvas_set)'),
      until: z.iso
        .datetime({ offset: true })
        .optional()
        .describe('Arrêt automatique à cette date (ISO 8601), en plus de done'),
    }),
    execute: async ({ name, command, every_seconds, canvas, until }) => {
      const row = await automations.create(self, {
        name,
        command,
        intervalSeconds: every_seconds,
        canvasKey: canvas,
        until: until ? new Date(until) : null,
      });
      const first = await automations.run(row.id);
      return `Automatisation « ${row.name} » créée (toutes les ${every_seconds} s). Premier passage : ${first}`;
    },
  });

  tools.automation_update = tool({
    description:
      'Change une de tes automatisations (commande, rythme, échéance) ou la met en pause / la relance. Une commande changée est essayée tout de suite.',
    inputSchema: z.object({
      automation: z.string().min(1).describe('Nom ou id'),
      command: z.string().min(1).max(2_000).optional(),
      every_seconds: z.number().int().min(MIN_INTERVAL_SECONDS).max(86_400).optional(),
      until: z.iso.datetime({ offset: true }).nullable().optional(),
      active: z.boolean().optional(),
    }),
    execute: async ({ automation, command, every_seconds, until, active }) => {
      const row = await automations.find(self.id, automation);
      const updated = await automations.update(row.id, {
        ...(command !== undefined ? { command } : {}),
        ...(every_seconds !== undefined ? { intervalSeconds: every_seconds } : {}),
        ...(until !== undefined ? { until: until ? new Date(until) : null } : {}),
        ...(active !== undefined ? { status: active ? 'active' : 'paused' } : {}),
      });
      if (command !== undefined && updated.status === 'active') {
        return `Mise à jour. Passage d'essai : ${await automations.run(updated.id)}`;
      }
      return `Automatisation « ${updated.name} » mise à jour (${updated.status}).`;
    },
  });

  tools.automation_list = tool({
    description: 'Tes automatisations, leur rythme et leur dernier passage.',
    inputSchema: z.object({}),
    execute: async () => {
      const mine = await automations.list(self.id);
      return mine.length ? mine.map(describe).join('\n') : 'Aucune automatisation.';
    },
  });

  tools.automation_delete = tool({
    description: 'Arrête et supprime une de tes automatisations (quand elle ne sert plus).',
    inputSchema: z.object({ automation: z.string().min(1).describe('Nom ou id') }),
    execute: async ({ automation }) => {
      const row = await automations.find(self.id, automation);
      await automations.remove(row.id);
      return `Automatisation « ${row.name} » supprimée.`;
    },
  });

  return tools;
}
