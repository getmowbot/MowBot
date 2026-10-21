export const keys = {
  me: ['me'] as const,
  bots: ['bots'] as const,
  teams: ['teams'] as const,
  computers: ['computers'] as const,
  providers: ['providers'] as const,
  tasks: ['tasks'] as const,
  feed: ['feed'] as const,
  messages: (botId: string) => ['messages', botId] as const,
  /** The answer a bot is streaming, fed by events even when its chat is not open. */
  live: (botId: string) => ['live', botId] as const,
  /** Home page cards, in the user's order. */
  canvases: ['canvases'] as const,
  notifications: ['notifications'] as const,
  /** Questions bots asked the user that wait for an answer. */
  questions: ['questions'] as const,
  /** Every routine, or one bot's (`['routines', botId]`). */
  routines: ['routines'] as const,
  routineRuns: (routineId: string) => ['routine-runs', routineId] as const,
  /** Bots' scripts the hub runs on their PCs (also tells which home cards are live). */
  automations: ['automations'] as const,
  system: ['system'] as const,
  devices: ['devices'] as const,
  /** Whether the phone lets the app notify (asked of the phone, not the hub). */
  pushPermission: ['push-permission'] as const,
  /** A folder of a workspace (`path` '' = its root). */
  files: (workspaceId: string, path = '') => ['files', workspaceId, path] as const,
  /** What a bot's own Chrome window shows (live view). */
  botBrowser: (botId: string) => ['bot-browser', botId] as const,
  /** The vault's entries (never their values). */
  vault: ['vault'] as const,
  /** One vault entry's history, newest first. */
  vaultEvents: (itemId: string) => ['vault-events', itemId] as const,
  /** Sites with cookies in a running computer's Chrome (not fed by events). */
  computerSites: (computerId: string) => ['computer-sites', computerId] as const,
};
