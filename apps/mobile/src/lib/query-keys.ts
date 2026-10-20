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
};
