import { z } from 'zod';

export const CONFIG_VERSION = 1;

const permission = z.enum(['allow', 'ask', 'deny']);

// Every field has a description: the dashboard and `ruby config explain` render them.
export const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).describe('Config format version. Migrated automatically.'),
    workspace: z
      .string()
      .optional()
      .describe('Directory tools may work in. Defaults to <home>/workspace.'),
    model: z
      .object({
        provider: z.enum(['anthropic', 'fake']).default('anthropic').describe('Model provider.'),
        name: z.string().default('claude-opus-5-5').describe('Model ID sent to the provider.'),
        effort: z
          .enum(['low', 'medium', 'high', 'xhigh', 'max'])
          .optional()
          .default('high')
          .describe('Reasoning effort for models that support it. Lower is cheaper and faster.'),
        fallbacks: z.boolean().default(true).describe('Let the provider retry a declined request on a fallback model.'),
        apiKeyEnv: z
          .string()
          .default('ANTHROPIC_API_KEY')
          .describe('Name of the environment variable holding the API key. Keys never live in config.'),
        baseUrl: z.string().url().optional().describe('Override the provider API base URL.'),
        maxOutputTokens: z.number().int().positive().default(32_000).describe('Output token cap per model call.'),
      })
      .prefault({})
      .describe('Model used for interactive tasks.'),
    budgets: z
      .object({
        maxModelCalls: z.number().int().positive().default(25).describe('Model calls allowed per task.'),
        maxTokens: z.number().int().positive().default(500_000).describe('Total tokens allowed per task.'),
        maxToolCalls: z.number().int().positive().default(50).describe('Tool calls allowed per task.'),
        maxWallMs: z.number().int().positive().default(15 * 60_000).describe('Wall-clock limit per task.'),
      })
      .prefault({})
      .describe('Per-task resource limits.'),
    permissions: z
      .object({
        'fs.read': permission.default('allow'),
        'fs.write': permission.default('ask'),
        'net.fetch': permission.default('ask'),
        exec: permission.default('deny'),
        'message.send': permission.default('ask'),
        'memory.write': permission.default('allow'),
        'schedule.edit': permission.default('ask'),
      })
      .prefault({})
      .describe('Default permission for each capability: allow, ask (owner approval) or deny.'),
    persona: z
      .string()
      .max(4000)
      .optional()
      .describe('Extra persona or standing instructions appended to the system prompt.'),
    api: z
      .object({
        enabled: z.boolean().default(false).describe('Serve the HTTP API. Off by default.'),
        host: z.string().default('127.0.0.1').describe('Bind address. Non-loopback requires at least one API key.'),
        port: z.number().int().min(1).max(65535).default(7311).describe('HTTP port.'),
        rateLimitPerMinute: z.number().int().positive().default(60).describe('Requests per minute allowed for each API key.'),
      })
      .prefault({})
      .describe('Opt-in, key-gated external access.'),
    channels: z
      .object({
        telegram: z
          .object({
            enabled: z.boolean().default(false).describe('Connect a Telegram bot.'),
            tokenEnv: z.string().default('TELEGRAM_BOT_TOKEN').describe('Environment variable holding the bot token from @BotFather.'),
          })
          .prefault({})
          .describe('Telegram bot channel.'),
      })
      .prefault({})
      .describe('Messaging channels. Each is off until enabled.'),
    gateway: z
      .object({
        maxConcurrent: z.number().int().min(1).max(64).default(4).describe('Tasks that may run at once across all conversations.'),
        pairingTtlMinutes: z.number().int().min(1).max(1440).default(60).describe('How long a pairing code stays valid.'),
      })
      .prefault({})
      .describe('Message routing and delivery.'),
    routes: z
      .array(
        z
          .object({
            match: z.object({
              channel: z.string().describe('Channel name, e.g. telegram.'),
              chatId: z.string().optional().describe('Specific chat; omit to match every chat on the channel.'),
            }),
            conversation: z
              .string()
              .regex(/^[a-z0-9-]{1,40}$/)
              .describe('Shared conversation name. Chats routed to the same name share history.'),
          })
          .strict(),
      )
      .default([])
      .describe('Optional rules that link chats into shared conversations. By default every chat is its own conversation.'),
    dashboard: z
      .object({
        enabled: z.boolean().default(false).describe('Serve the dashboard through the API server.'),
      })
      .prefault({})
      .describe('Opt-in web dashboard.'),
  })
  .strict();

export type RubyConfig = z.infer<typeof configSchema>;
export type Permission = z.infer<typeof permission>;
