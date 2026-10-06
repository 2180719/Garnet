import { z } from 'zod';
import { parseCron, validTimeZone } from './cron.ts';

export const CONFIG_VERSION = 1;

const permission = z.enum(['allow', 'ask', 'deny']);

// Every field has a description: the dashboard and `ruby config explain` render them.
const capabilityGrant = z.object({
  'fs.read': permission.default('allow'),
  'fs.write': permission.default('deny'),
  'net.fetch': permission.default('deny'),
  exec: permission.default('deny'),
  'message.send': permission.default('deny'),
  'memory.write': permission.default('deny'),
  'schedule.edit': permission.default('deny'),
});

const jobSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/).describe('Short unique name.'),
    enabled: z.boolean().default(true).describe('Disabled jobs never run and never call the model.'),
    kind: z.enum(['cron', 'heartbeat']).describe('cron: calendar times. heartbeat: every N minutes.'),
    cron: z.string().optional().describe('5-field cron expression (minute hour day month weekday), for kind=cron.'),
    everyMinutes: z.number().int().min(5).max(10_080).optional().describe('Interval for kind=heartbeat.'),
    timezone: z.string().optional().describe('IANA time zone, e.g. Europe/London. Defaults to the host zone.'),
    instructions: z.string().min(1).max(4000).describe('What Ruby should do on each run.'),
    check: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('file_changed'), path: z.string().describe('Workspace-relative file to watch.') }),
        z.object({ type: z.literal('url_changed'), url: z.string().url().describe('URL whose content to watch.') }),
      ])
      .optional()
      .describe('Cheap check run first; the model is called only when it changed.'),
    permissions: capabilityGrant.prefault({}).describe('What the job may do. Intersected with the owner permissions; defaults to read-only.'),
    budget: z
      .object({
        maxTokensPerRun: z.number().int().min(1000).default(100_000).describe('Token cap for one run.'),
        maxTokensPerDay: z.number().int().min(1000).default(500_000).describe('Token cap across all runs in 24 hours.'),
      })
      .prefault({}),
    timeoutMinutes: z.number().int().min(1).max(240).default(10).describe('Runs are cancelled after this long.'),
    notify: z
      .object({ channel: z.string(), chatId: z.string(), account: z.string().default('default') })
      .optional()
      .describe('Where to send results. Without it, results are only kept in run history.'),
    notifyWhen: z.enum(['always', 'on_change']).default('on_change').describe('on_change: only when Ruby has something worth reporting.'),
    catchUp: z.boolean().default(true).describe('After downtime, run missed occurrences once (coalesced). Otherwise skip them.'),
  })
  .strict()
  .superRefine((j, ctx) => {
    if (j.kind === 'cron' && !j.cron) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'cron jobs need a cron expression' });
    if (j.kind === 'heartbeat' && !j.everyMinutes) ctx.addIssue({ code: 'custom', path: ['everyMinutes'], message: 'heartbeats need everyMinutes' });
    if (j.cron) {
      try {
        parseCron(j.cron);
      } catch (e) {
        ctx.addIssue({ code: 'custom', path: ['cron'], message: (e as Error).message });
      }
    }
    if (j.timezone && !validTimeZone(j.timezone)) ctx.addIssue({ code: 'custom', path: ['timezone'], message: `Unknown time zone "${j.timezone}"` });
  });

export type JobConfig = z.infer<typeof jobSchema>;

export const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION).describe('Config format version. Migrated automatically.'),
    workspace: z
      .string()
      .optional()
      .describe('Directory tools may work in. Defaults to <home>/workspace.'),
    model: z
      .object({
        provider: z
          .enum(['anthropic', 'openai-compatible', 'fake'])
          .default('anthropic')
          .describe('anthropic, or openai-compatible for OpenRouter and local servers (Ollama, llama.cpp, vLLM, LM Studio).'),
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
          .describe('Name of the environment variable (or encrypted secret, see `ruby secrets`) holding the API key. Keys never live in config.'),
        baseUrl: z.string().url().optional().describe('Provider API base URL. Required for openai-compatible, e.g. http://127.0.0.1:11434/v1.'),
        contextWindow: z.number().int().min(4096).optional().describe('Context window of an openai-compatible model.'),
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
    context: z
      .object({
        compactAtTokens: z
          .number()
          .int()
          .min(10_000)
          .default(150_000)
          .describe('Summarize older turns before a task when the previous request used this many input tokens.'),
        keepTurns: z.number().int().min(1).max(10).default(2).describe('Recent user turns kept word-for-word after summarizing.'),
      })
      .prefault({})
      .describe('Context window management.'),
    memory: z
      .object({
        memoryChars: z.number().int().min(200).max(20_000).default(2200).describe("Cap for MEMORY.md, Ruby's own notes."),
        userChars: z.number().int().min(200).max(20_000).default(1400).describe('Cap for USER.md, what Ruby knows about you.'),
      })
      .prefault({})
      .describe('Bounded memory, shown to Ruby at the start of each session.'),
    sandbox: z
      .object({
        backend: z.enum(['docker', 'local']).default('docker').describe('docker: isolated container per command. local: runs on the host and is NOT a security boundary.'),
        image: z.string().default('debian:stable-slim').describe('Container image with sh. Pull it yourself first: docker pull <image>.'),
        network: z.enum(['none', 'bridge']).default('none').describe('Container network. none blocks all network access.'),
        memory: z.string().regex(/^[0-9]+[bkmg]?$/i).default('512m').describe('Memory limit per command (swap disabled).'),
        cpus: z.number().positive().default(1).describe('CPU limit per command.'),
        pidsLimit: z.number().int().min(16).default(256).describe('Maximum processes per command.'),
        user: z
          .string()
          .regex(/^[0-9]+:[0-9]+$/)
          .refine((u) => Number(u.split(':')[0]) !== 0, 'the sandbox never runs as root (uid 0)')
          .optional()
          .describe('Container user as uid:gid (docker). Unset: your uid:gid, or the workspace owner when Ruby runs as root, else 65534:65534. Never root.'),
      })
      .prefault({})
      .describe('Where run_command executes. Only used when the exec permission is allow or ask.'),
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
    containment: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Once a conversation has read untrusted content (web pages, search results), ask before consequential actions even if they are set to allow. Off: taint is still recorded and shown, but nothing is escalated.'),
        escalate: z
          .array(z.enum(['fs.read', 'fs.write', 'net.fetch', 'exec', 'message.send', 'memory.write', 'schedule.edit']))
          .default(['fs.write', 'exec', 'message.send', 'memory.write', 'schedule.edit', 'net.fetch'])
          .describe('Capabilities that change from allow to ask in a conversation that has read untrusted content. deny always stays deny.'),
        fetchSeenUrls: z
          .boolean()
          .default(true)
          .describe('In such a conversation, still fetch without asking a URL that a search result or fetched page contained word for word (it carries nothing Ruby composed). URLs you wrote yourself are always allowed.'),
      })
      .prefault({})
      .describe('Prompt-injection containment: untrusted content cannot quietly trigger actions. Lasts until /new starts a fresh conversation.'),
    web: z
      .object({
        allowHosts: z
          .array(z.string().regex(/^(\*\.)?[a-z0-9.-]+$/i, 'a host name such as example.com or *.example.com'))
          .default([])
          .describe('Hosts web_fetch may read without asking when net.fetch is ask, e.g. en.wikipedia.org or *.python.org.'),
        fetch: z
          .object({
            maxBytes: z.number().int().min(10_000).max(50_000_000).default(5_000_000).describe('Largest response body read; longer bodies are cut off at this size.'),
            timeoutSeconds: z.number().int().min(1).max(120).default(20).describe('Time limit for one fetch, redirects included.'),
            maxRedirects: z.number().int().min(0).max(10).default(5).describe('Redirects followed; each target is checked again.'),
          })
          .prefault({})
          .describe('web_fetch limits. Private, loopback, link-local and cloud metadata addresses are always refused.'),
        search: z
          .object({
            backend: z
              .enum(['duckduckgo', 'searxng', 'brave', 'tavily', 'none'])
              .default('duckduckgo')
              .describe('duckduckgo: keyless, reads the HTML results page (unofficial, may be rate limited). searxng: your instance. brave, tavily: API with a key. none: no web_search tool.'),
            searxngUrl: z.string().url().optional().describe('SearXNG base URL, e.g. http://127.0.0.1:8888 (the instance must allow format=json).'),
            apiKeyEnv: z
              .string()
              .optional()
              .describe('Environment variable (or encrypted secret) holding the brave or tavily API key. Defaults to BRAVE_API_KEY or TAVILY_API_KEY.'),
            maxResults: z.number().int().min(1).max(20).default(8).describe('Results returned per search.'),
          })
          .prefault({})
          .describe('web_search backend.'),
      })
      .prefault({})
      .describe('web_fetch and web_search (both need net.fetch). Their output is untrusted.'),
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
        rateLimitPerMinute: z.number().int().positive().default(120).describe('Requests per minute allowed for each API key (the dashboard polls, so keep this comfortably above 60).'),
        trustProxy: z.boolean().default(false).describe('Behind your own reverse proxy: take the client IP from X-Forwarded-For. The rightmost entry (the one your proxy appends) is used, so the proxy must append the client address to X-Forwarded-For.'),
        demo: z
          .object({
            enabled: z.boolean().default(false).describe('Serve a public, keyless demo chat for your website at /v1/demo/chat/completions.'),
            model: z.string().default('claude-haiku-4-5').describe('Cheap model for the demo (same provider and key as the main model).'),
            allowedOrigins: z.array(z.string().url()).default([]).describe('Website origins allowed to call the demo, e.g. https://ruby.example.com.'),
            perIpPerHour: z.number().int().min(1).max(1000).default(20).describe('Messages per visitor IP per hour.'),
            dailyTokenBudget: z.number().int().min(1000).default(200_000).describe('Total demo tokens per day; the demo pauses when spent.'),
            maxOutputTokens: z.number().int().min(50).max(4000).default(400).describe('Reply length cap.'),
          })
          .prefault({})
          .describe('No tools, no memory, no history kept. Off by default.'),
      })
      .prefault({})
      .describe('Opt-in, key-gated external access.'),
    channels: z
      .object({
        telegram: z
          .object({
            enabled: z.boolean().default(false).describe('Connect a Telegram bot.'),
            tokenEnv: z.string().default('TELEGRAM_BOT_TOKEN').describe('Environment variable (or encrypted secret) holding the bot token from @BotFather.'),
          })
          .prefault({})
          .describe('Telegram bot channel.'),
        discord: z
          .object({
            enabled: z.boolean().default(false).describe('Connect a Discord bot (direct messages). Enable the Message Content intent in the developer portal.'),
            tokenEnv: z.string().default('DISCORD_BOT_TOKEN').describe('Environment variable (or encrypted secret) holding the bot token.'),
          })
          .prefault({})
          .describe('Discord bot channel.'),
        signal: z
          .object({
            enabled: z.boolean().default(false).describe('Connect Signal through a local signal-cli daemon.'),
            account: z.string().optional().describe("The bot's Signal number in E.164 form, e.g. +15551234567."),
            baseUrl: z.string().url().default('http://127.0.0.1:8080').describe('signal-cli daemon HTTP address (run: signal-cli -a <number> daemon --http 127.0.0.1:8080).'),
          })
          .prefault({})
          .describe('Signal channel via signal-cli.'),
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
    scheduler: z
      .object({
        enabled: z.boolean().default(true).describe('Global switch for cron jobs and heartbeats. Off stops all new scheduled runs.'),
        tickSeconds: z.number().int().min(5).max(300).default(30).describe('How often the scheduler checks for due jobs.'),
      })
      .prefault({})
      .describe('Scheduled work.'),
    jobs: z
      .array(jobSchema)
      .default([])
      .superRefine((jobs, ctx) => {
        const seen = new Set<string>();
        for (const [i, j] of jobs.entries()) {
          if (seen.has(j.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `Duplicate job id "${j.id}"` });
          seen.add(j.id);
        }
      })
      .describe('Cron jobs and heartbeats. Each runs through the normal agent with its own permissions and budgets.'),
    dashboard: z
      .object({
        enabled: z.boolean().default(false).describe('Serve the dashboard through the API server.'),
      })
      .prefault({})
      .describe('Opt-in web dashboard.'),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.model.provider === 'openai-compatible' && !c.model.baseUrl) {
      ctx.addIssue({ code: 'custom', path: ['model', 'baseUrl'], message: 'openai-compatible needs model.baseUrl' });
    }
    if (c.dashboard.enabled && !c.api.enabled) {
      ctx.addIssue({ code: 'custom', path: ['dashboard', 'enabled'], message: 'The dashboard is served by the API server: enable api too' });
    }
    if (c.web.search.backend === 'searxng' && !c.web.search.searxngUrl) {
      ctx.addIssue({ code: 'custom', path: ['web', 'search', 'searxngUrl'], message: 'The searxng backend needs web.search.searxngUrl' });
    }
    if (c.channels.signal.enabled && !c.channels.signal.account) {
      ctx.addIssue({ code: 'custom', path: ['channels', 'signal', 'account'], message: "Signal needs the bot's number" });
    }
    for (const [i, j] of c.jobs.entries()) {
      if (j.notify && !['telegram', 'signal', 'discord'].includes(j.notify.channel)) {
        ctx.addIssue({ code: 'custom', path: ['jobs', i, 'notify', 'channel'], message: 'notify.channel must be telegram, signal or discord' });
      }
    }
  });

export type RubyConfig = z.infer<typeof configSchema>;
export type Permission = z.infer<typeof permission>;
