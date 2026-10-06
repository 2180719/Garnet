// Composition root: the only place modules are wired together.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordChannel, SignalChannel, TelegramChannel, UPLOAD_LIMITS } from './channels/index.ts';
import { loadConfig, redact, garnetHome, type Paths, type GarnetConfig } from './config/index.ts';
import { assistantName, projectInstructionsSection } from './context/index.ts';
import { derivedCachePrices, errorMessage, formatUsd, startOfDayIso, GarnetError, resolvePricing, type Budget, type Pricing, type ChannelAdapter, type ModelAdapter, type OutboundMessage } from './contracts/index.ts';
import { ApiKeys, ApiServer, assertSendAllowed, ChatDirectory, DemoChat, Gateway, persistentApprover, sendMessageTool, staticFiles, type LogFn } from './gateway/index.ts';
import { createBackend } from './backend.ts';
import { AnthropicModel, FakeModel, OpenAICompatibleModel, onboardingScript } from './models/index.ts';
import { Policy, type Approver } from './policy/index.ts';
import { Agent, LaneQueue, sessionTaint } from './runtime/index.ts';
import { ApprovalStore, GatewayStore, JobStore, KeyStore, mediaIdsInUse, openDb, pruneOperationalRows, SessionStore, StatsStore, type Db } from './store/index.ts';
import { JobBook, scheduleTool, Scheduler } from './scheduler/index.ts';
import { MemoryStore, memoryTool } from './memory/index.ts';
import { importedArchiveSection } from './migrate/index.ts';
import { ONBOARDING_TITLE, bootstrapPrompt, profileTool } from './onboarding/index.ts';
import { SkillStore, skillTools } from './skills/index.ts';
import { CommandTranscriber, MediaIngest, MediaStore, OpenAITranscriber, sendFileTool, type Transcriber } from './media/index.ts';
import { ArtifactStore, ToolExecutor, ToolRegistry, WebFetcher, execTool, fileTools, readArtifactTool, searchBackend, webFetchTool, webSearchTool } from './tools/index.ts';
import { assertSandboxReady, createSandbox, type Sandbox } from './sandbox/index.ts';
import { isInside, openSecretStore, secretLookup, type SecretLookup, type SecretStore } from './secrets/index.ts';

export const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

/** Proactive sends for tools: queue a message to a chat and, with `record`, note it in that chat's conversation. */
export type Outbound = {
  notify: (
    target: { channel: string; account: string; chatId: string },
    text: string,
    record?: { from: string; skipSession?: string; taint?: readonly string[] },
    attachments?: OutboundMessage['attachments'],
  ) => string;
};

export type Garnet = {
  config: GarnetConfig;
  paths: Paths;
  env: NodeJS.ProcessEnv;
  /** The encrypted secret store at <home>/secrets (decrypted only when a secret is needed). */
  secrets: SecretStore;
  /** Resolves a secret name: process environment first, then the encrypted store. */
  secret: SecretLookup;
  db: Db;
  store: SessionStore;
  gatewayStore: GatewayStore;
  keyStore: KeyStore;
  keys: ApiKeys;
  registry: ToolRegistry;
  sandbox: Sandbox | null;
  approvals: ApprovalStore;
  jobStore: JobStore;
  /** Config jobs plus jobs created from chat, CLI or dashboard. */
  jobBook: JobBook;
  /** Paired chats and delivery targets for proactive messages. */
  directory: ChatDirectory;
  /** The owner's time zone (config `timezone`, else the host's). */
  timezone: string;
  /** Proactive sends; rebound to `Gateway.notify` by `buildService`. */
  outbound: Outbound;
  ownerPolicy: Policy;
  makeAgent: (policy: Policy, budget: Budget) => Agent;
  memory: MemoryStore;
  skills: SkillStore;
  /** Inbound file handling; null when `media.enabled` is false. */
  media: MediaIngest | null;
  /** The attachment files under <home>/media; null when `media.enabled` is false. */
  mediaStore: MediaStore | null;
  agent: Agent;
  model: ModelAdapter;
  /** USD per million tokens for the main model (config or built-in); undefined means cost shows `?`. */
  pricing: Pricing | undefined;
  close: () => void;
};

export type CreateOptions = {
  home?: string;
  /** Overrides the configured model (tests, `--fake`). */
  model?: ModelAdapter;
  approver?: Approver;
  env?: NodeJS.ProcessEnv;
  /** Use an in-memory database (tests). */
  memoryDb?: boolean;
  /** Skip creating the model (admin commands that never call it). */
  noModel?: boolean;
  /** First-run wake-up: registers `set_profile` and adds the bootstrap prompt to sessions titled `ONBOARDING_TITLE` only. */
  onboarding?: boolean;
};

export function createGarnet(options: CreateOptions = {}): Garnet {
  const env = options.env ?? process.env;
  const { config, paths } = loadConfig(options.home ?? garnetHome(env));
  if (isInside(paths.workspace, paths.home)) {
    // File tools are scoped to the workspace; if it held config.json, secrets or skill sidecars, one approved write could grant everything.
    throw new GarnetError('config', `workspace (${paths.workspace}) must not contain Garnet's home (${paths.home}): tools could change config.json, secrets and skills there. Point "workspace" at a directory of its own.`);
  }
  const secrets = openSecretStore(paths.home, env);
  const secret = secretLookup(env, secrets);
  mkdirSync(paths.workspace, { recursive: true });
  const db = openDb(options.memoryDb ? ':memory:' : paths.database);
  const store = new SessionStore(db);
  const keyStore = new KeyStore(db);
  const memory = new MemoryStore({ root: join(paths.home, 'memory'), limits: { memory: config.memory.memoryChars, user: config.memory.userChars } });
  const skills = new SkillStore({ root: join(paths.home, 'skills') });
  const artifacts = new ArtifactStore(join(paths.home, 'artifacts'));
  const gatewayStore = new GatewayStore(db);
  const jobStore = new JobStore(db);
  const timezone = ownerTimeZone(config);
  const jobBook = new JobBook({ configJobs: config.jobs, store: jobStore, timezone, maxAgentJobs: config.scheduler.maxAgentJobs });
  const directory = new ChatDirectory({ store: gatewayStore, sessions: store, routes: config.routes });
  // Proactive sends (send_message, send_file). Without a gateway in this process (terminal chat, CLI) the message
  // is queued for the running service and recorded directly; buildService rebinds this to Gateway.notify.
  const outbound: Outbound = {
    notify: (target, text, record, attachments) => {
      const out = gatewayStore.enqueue({ ...target, text, ...(attachments?.length ? { attachments } : {}) });
      if (record) directory.record(target, text, record);
      return out.deliveryId;
    },
  };
  const registry = new ToolRegistry();
  for (const tool of [...fileTools, memoryTool(memory), ...skillTools(skills), readArtifactTool(artifacts)]) registry.register(tool);
  // Like the other optional tools, set_profile exists only when its permission is not deny (the tool set is fixed per session).
  const onboarding = Boolean(options.onboarding) && config.permissions['memory.write'] !== 'deny';
  if (onboarding) registry.register(profileTool(paths.home));
  // Like run_command, these exist only when their permission is not deny (the tool set is fixed per session).
  if (config.permissions['schedule.edit'] !== 'deny') {
    const target = (t: { channel: string; account: string; chatId: string; name: string | null }) => ({ ...t, label: ChatDirectory.label({ ...t, senderId: null }) });
    registry.register(
      scheduleTool({
        book: jobBook,
        originOf: (sessionId) => {
          const o = directory.origin(sessionId);
          return { conversation: o.conversation, isJob: o.isJob, chat: o.chat && target(o.chat) };
        },
        resolveTarget: (to, sessionId) => target(directory.resolve(to, sessionId)),
        labelOf: (n) => {
          const known = directory.chats().find((c) => c.channel === n.channel && c.chatId === n.chatId);
          return ChatDirectory.label(known ?? { ...n, senderId: null, name: null });
        },
      }),
    );
  }
  const messagesPerHour = config.gateway.messagesPerHour;
  if (config.permissions['message.send'] !== 'deny') {
    registry.register(sendMessageTool({ directory, store: gatewayStore, perHour: messagesPerHour, notify: (t, text, record) => outbound.notify(t, text, record) }));
  }
  const mediaStore = config.media.enabled ? new MediaStore(join(paths.home, 'media'), config.media.maxBytes) : null;
  if (mediaStore) {
    registry.register(
      sendFileTool({
        media: mediaStore,
        target: (sessionId) => {
          // The chat this conversation is in, or a job's delivery chat (config or stored job).
          const o = directory.origin(sessionId);
          if (o.isJob) {
            const n = jobBook.find(o.conversation!.slice('job:'.length))?.job.notify;
            if (!n) return null;
            return { channel: n.channel, account: n.channel === 'signal' ? (config.channels.signal.account ?? n.account) : n.account, chatId: n.chatId };
          }
          return o.chat && { channel: o.chat.channel, account: o.chat.account, chatId: o.chat.chatId };
        },
        maxUploadBytes: (channel) => UPLOAD_LIMITS[channel],
        // Files share send_message's hourly limit and its log.
        enqueue: (target, text, attachments, sessionId) => {
          assertSendAllowed(gatewayStore, messagesPerHour, new Date());
          const deliveryId = outbound.notify(target, text, undefined, attachments);
          gatewayStore.recordSent({ sessionId, ...target, deliveryId });
        },
      }),
    );
  }
  // run_command exists only when the owner opted into exec; the tool set is fixed per session.
  let sandbox: Sandbox | null = null;
  if (config.permissions.exec !== 'deny') {
    const sb = config.sandbox;
    sandbox = createSandbox(sb.backend, { workspace: paths.workspace, image: sb.image, network: sb.network, memory: sb.memory, cpus: sb.cpus, pidsLimit: sb.pidsLimit, ...(sb.user ? { user: sb.user } : {}) });
    registry.register(execTool(sandbox));
  }
  // web_fetch and web_search exist only when net.fetch is not denied. They run in-process (the sandbox has no network).
  const trustedEndpoints = registerWebTools(registry, config, secret);
  const approvals = new ApprovalStore(db);
  const approver = options.approver ?? persistentApprover(approvals);
  // The demo provider has no real model: the wake-up conversation plays its offline script instead of echoing.
  const model = options.model ?? (options.noModel ? new FakeModel() : onboarding && config.model.provider === 'fake' ? new FakeModel(onboardingScript()) : createModel(config, secret));
  const media = mediaStore
    ? new MediaIngest({
        store: mediaStore,
        transcriber: createTranscriber(config, secret),
        pdfText: config.media.pdfText.command ? { argv: config.media.pdfText.command, timeoutMs: config.media.pdfText.timeoutSeconds * 1000 } : null,
        modelMedia: model.capabilities.media,
        maxTextChars: config.media.maxTextChars,
        saveText: (sessionId, text) => artifacts.save(sessionId, text),
      })
    : null;
  const pricing = resolvePricing(config.model.provider, config.model.name, config.model.pricing);
  const stats = new StatsStore(db);
  /**
   * The daily spending cap (budgets.dailyUsd), for the owner's calendar day: refuses new model-calling
   * tasks, and stops a running one before its next model call, once today's known cost reaches it.
   * Fails safe: with no price, or a finished task whose cost cannot be known, it refuses rather than count $0.
   */
  const refuse = (): string | null => {
    const cap = config.budgets.dailyUsd;
    if (cap === undefined) return null;
    const tz = ownerTimeZone(config);
    if (!pricing) return `Daily spending cap is set (${formatUsd(cap)}, budgets.dailyUsd) but the model has no known price, so spending cannot be measured. Set model.pricing in config.json (or remove the cap); model tasks are refused until then.`;
    const { known, unknown } = stats.costSince(startOfDayIso(tz), pricing);
    if (unknown > 0) return `Daily spending cap is set (${formatUsd(cap)}, budgets.dailyUsd) but ${unknown} model call record(s) today have an unknown cost (the provider did not report all token counts, or pricing is incomplete), so spending cannot be measured. Set model.pricing in config.json (or remove the cap); new model tasks are refused until tomorrow (${tz}).`;
    if (known === null || known < cap) return null;
    return `Daily spending cap reached: ${formatUsd(known)} spent today (${tz}) of ${formatUsd(cap)} (budgets.dailyUsd). Model tasks are refused until midnight ${tz}; the owner can raise or remove the cap in config.json.`;
  };
  /** Builds an agent with its own policy and budget (interactive, or a scheduled job's narrower grant). */
  const makeAgent = (policy: Policy, budget: Budget): Agent =>
    new Agent({
      store,
      model,
      registry,
      executor: new ToolExecutor({ registry, policy, approver, artifacts }),
      budget,
      refuse,
      recordSpend: (usage) => stats.recordSpend(usage),
      workspace: paths.workspace,
      persona: config.persona,
      promptSections: (ns, sessionId) => [
        projectInstructionsSection(paths.workspace),
        memory.snapshot(ns),
        skills.index(),
        importedArchiveSection(paths.workspace),
        // The wake-up instructions belong to the onboarding session only, never to other sessions.
        onboarding && store.getSession(sessionId)?.title === ONBOARDING_TITLE ? bootstrapPrompt() : '',
      ],
      compactAtTokens: config.context.compactAtTokens,
      keepTurns: config.context.keepTurns,
      maxOutputTokens: config.model.maxOutputTokens,
      ...(mediaStore ? { loadAttachment: (ref: { id: string }) => mediaStore.read(ref.id) } : {}),
      maxAttachmentsInContext: config.media.maxInContext,
      timeZone: ownerTimeZone(config),
    });
  const ownerPolicy = new Policy(config.permissions, { containment: config.containment, allowHosts: config.web.allowHosts, trustedEndpoints });
  const agent = makeAgent(ownerPolicy, config.budgets);
  return {
    config,
    paths,
    env,
    secrets,
    secret,
    db,
    store,
    gatewayStore,
    approvals,
    jobStore,
    jobBook,
    directory,
    timezone,
    outbound,
    ownerPolicy,
    makeAgent,
    keyStore,
    keys: new ApiKeys(keyStore),
    registry,
    sandbox,
    memory,
    skills,
    media,
    mediaStore,
    agent,
    model,
    pricing,
    close: () => db.close(),
  };
}

/** The owner's time zone: `timezone` in config, else the host's. */
export function ownerTimeZone(config: GarnetConfig): string {
  return config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Registers web_fetch and web_search per config; returns the search endpoint(s) the owner chose (see `PolicyOptions.trustedEndpoints`). */
function registerWebTools(registry: ToolRegistry, config: GarnetConfig, secret: SecretLookup): string[] {
  if (config.permissions['net.fetch'] === 'deny') return [];
  const w = config.web;
  const timeoutMs = w.fetch.timeoutSeconds * 1000;
  const fetcher = new WebFetcher({ maxBytes: w.fetch.maxBytes, timeoutMs, maxRedirects: w.fetch.maxRedirects });
  registry.register(webFetchTool(fetcher, { timeoutMs }));
  if (w.search.backend === 'none') return [];
  const backend = searchBackend({ backend: w.search.backend, searxngUrl: w.search.searxngUrl, apiKeyEnv: w.search.apiKeyEnv }, secret);
  registry.register(webSearchTool(backend, fetcher, { maxResults: w.search.maxResults, timeoutMs }));
  return [backend.endpoint];
}

/** `secret` resolves a name (environment first, then the encrypted store); see src/secrets. */
export function createModel(config: GarnetConfig, secret: SecretLookup): ModelAdapter {
  const m = config.model;
  if (m.provider === 'fake') return new FakeModel();
  const apiKey = secret(m.apiKeyEnv);
  if (m.provider === 'openai-compatible') {
    // Local servers often need no key.
    return new OpenAICompatibleModel({ baseUrl: m.baseUrl!, apiKey, model: m.name, contextWindow: m.contextWindow, vision: m.vision, pdf: m.pdf });
  }
  if (!apiKey) {
    throw new GarnetError('config', `No API key found. Set the ${m.apiKeyEnv} environment variable or store it with \`garnet secrets set ${m.apiKeyEnv}\`, or run with --fake.`);
  }
  return new AnthropicModel({
    apiKey,
    model: m.name,
    effort: m.effort,
    fallbacks: m.fallbacks,
    vision: m.vision,
    pdf: m.pdf,
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
  });
}

/** Speech to text for voice notes, from `media.transcription`; null when none is configured. */
export function createTranscriber(config: GarnetConfig, secret: SecretLookup): Transcriber | null {
  const t = config.media.transcription;
  const timeoutMs = t.timeoutSeconds * 1000;
  if (t.backend === 'command' && t.command) return new CommandTranscriber(t.command, timeoutMs);
  if (t.backend !== 'openai-compatible' || !t.baseUrl) return null;
  const apiKey = t.apiKeyEnv ? secret(t.apiKeyEnv) : undefined;
  if (t.apiKeyEnv && !apiKey) {
    // Not fatal at startup (admin commands never transcribe); each voice note gets this explanation instead.
    const why = `${t.apiKeyEnv} is not set (environment or \`garnet secrets set ${t.apiKeyEnv}\`)`;
    return { label: 'openai-compatible (missing key)', transcribe: () => Promise.reject(new GarnetError('config', why)) };
  }
  return new OpenAITranscriber({ baseUrl: t.baseUrl, path: t.path, apiKey, model: t.model, language: t.language, timeoutMs });
}
/** The website demo uses its own cheap model with the same provider and credentials. */
function createDemo(garnet: Garnet): DemoChat {
  const d = garnet.config.api.demo;
  const model = createModel({ ...garnet.config, model: { ...garnet.config.model, name: d.model, effort: 'low' } }, garnet.secret);
  return new DemoChat({ model, allowedOrigins: d.allowedOrigins, perIpPerHour: d.perIpPerHour, dailyTokenBudget: d.dailyTokenBudget, maxOutputTokens: d.maxOutputTokens });
}

export function createChannels(config: GarnetConfig, secret: SecretLookup): ChannelAdapter[] {
  const channels: ChannelAdapter[] = [];
  const tg = config.channels.telegram;
  if (tg.enabled) {
    const token = secret(tg.tokenEnv);
    if (!token) throw new GarnetError('config', `Telegram is enabled but ${tg.tokenEnv} is not set (environment or \`garnet secrets set ${tg.tokenEnv}\`).`);
    channels.push(new TelegramChannel({ token }));
  }
  const dc = config.channels.discord;
  if (dc.enabled) {
    const token = secret(dc.tokenEnv);
    if (!token) throw new GarnetError('config', `Discord is enabled but ${dc.tokenEnv} is not set (environment or \`garnet secrets set ${dc.tokenEnv}\`).`);
    channels.push(new DiscordChannel({ token }));
  }
  const sig = config.channels.signal;
  if (sig.enabled) channels.push(new SignalChannel({ account: sig.account!, baseUrl: sig.baseUrl }));
  return channels;
}

export type Service = { gateway: Gateway; api: ApiServer | null; scheduler: Scheduler; stop: () => Promise<void> };

export type RetentionReport = ReturnType<typeof pruneOperationalRows> & { media: number };

/**
 * Applies `config.retention`: old finished inbox, outbox, job-run, approval and
 * sent-message rows, and media files nothing refers to. The session event log
 * is never touched, and neither is anything still pending or referenced.
 */
export function runRetention(garnet: Pick<Garnet, 'config' | 'db' | 'mediaStore'>, now: number = Date.now()): RetentionReport {
  const r = garnet.config.retention;
  const rows = pruneOperationalRows(
    garnet.db,
    { inbox: r.inboxDays, outbox: r.outboxDays, sentMessages: r.sentMessagesDays, jobRuns: r.jobRunsDays, approvals: r.approvalsDays },
    now,
  );
  // Rows go first, so a file only a pruned delivery referred to becomes unreferenced in the same pass.
  const media = garnet.mediaStore && r.mediaDays > 0 ? garnet.mediaStore.prune(now - r.mediaDays * 86_400_000, mediaIdsInUse(garnet.db)) : 0;
  return { ...rows, media };
}

const RETENTION_EVERY_MS = 86_400_000;

/**
 * Each job runs as its own agent: its grant intersected with the owner's
 * permissions, and its own budget. Built on first use (jobs created from chat
 * appear while Garnet runs) and rebuilt when the job's grant or budget changes.
 */
function jobAgents(garnet: Garnet): (key: string) => Agent | undefined {
  const agents = new Map<string, { sig: string; agent: Agent }>();
  return (key) => {
    if (!key.startsWith('job:')) return undefined;
    const job = garnet.jobBook.find(key.slice(4))?.job;
    if (!job) return undefined;
    const sig = JSON.stringify([job.permissions, job.budget, job.timeoutMinutes]);
    const cached = agents.get(key);
    if (cached?.sig === sig) return cached.agent;
    const policy = garnet.ownerPolicy.intersect(new Policy(job.permissions));
    const agent = garnet.makeAgent(policy, { ...garnet.config.budgets, maxTokens: job.budget.maxTokensPerRun, maxWallMs: job.timeoutMinutes * 60_000 });
    agents.set(key, { sig, agent });
    return agent;
  };
}

/** Wraps a logger so every message is redacted before it is written. */
export function redactingLog(log: LogFn): LogFn {
  return (level, message) => log(level, redact(message));
}

/** Wires the gateway and scheduler without starting anything. `deliver` is false for short-lived CLI processes. */
export function buildService(garnet: Garnet, rawLog: LogFn, channels: ChannelAdapter[], deliver: boolean): { gateway: Gateway; scheduler: Scheduler; channels: ChannelAdapter[] } {
  const { config } = garnet;
  const log = redactingLog(rawLog);
  const agentFor = jobAgents(garnet);
  const gateway = new Gateway({
    store: garnet.gatewayStore,
    approvals: garnet.approvals,
    sessions: garnet.store,
    agent: garnet.agent,
    agentFor,
    lanes: new LaneQueue(config.gateway.maxConcurrent),
    channels,
    routes: config.routes,
    pairingTtlMinutes: config.gateway.pairingTtlMinutes,
    deliveryEnabled: deliver,
    model: { id: garnet.model.id, contextWindow: garnet.model.capabilities.contextWindow, pricing: garnet.pricing },
    assistantName: assistantName(config.persona),
    log,
    ...(garnet.media ? { media: garnet.media } : {}),
  });
  const sandbox = garnet.sandbox;
  const scheduler = new Scheduler({
    jobs: () => garnet.jobBook.jobs(),
    // Script-only jobs run in the same sandbox as run_command, and only when exec is not denied.
    runScript: sandbox ? (job, signal) => sandbox.run({ command: job.script!.command, cwd: '.', timeoutMs: job.script!.timeoutSeconds * 1000, signal }) : null,
    store: garnet.jobStore,
    workspace: garnet.paths.workspace,
    enabled: config.scheduler.enabled,
    tickSeconds: config.scheduler.tickSeconds,
    timeZone: ownerTimeZone(config),
    log,
    run: (job, text, signal) => {
      // A job created by a conversation that had read untrusted content carries that taint into every run.
      const taint = garnet.jobBook.taintOf(job.id);
      return gateway.chat(`job:${job.id}`, text, { signal, source: 'scheduler', ...(taint.length ? { taint } : {}) });
    },
    notify: (job, text) => {
      if (!job.notify) return;
      const account = job.notify.channel === 'signal' ? (config.channels.signal.account ?? job.notify.account) : job.notify.account;
      // Recorded in the chat's conversation so a reply to it has context.
      // The job's inherited taint plus whatever its own run read: the note must not launder it into the owner's chat.
      const runSession = garnet.gatewayStore.conversation(`job:${job.id}`);
      const taint = [...new Set([...garnet.jobBook.taintOf(job.id), ...(runSession ? sessionTaint(garnet.store.events(runSession)).sources : [])])];
      gateway.notify({ channel: job.notify.channel, account, chatId: job.notify.chatId }, text, { from: `scheduled job "${job.id}"`, ...(taint.length ? { taint } : {}) });
    },
  });
  garnet.jobBook.onRemoved((id) => scheduler.cancel(id));
  // Tools now send through the gateway: delivery right away, and notes recorded on the conversation's lane.
  garnet.outbound.notify = (target, text, record, attachments) => gateway.notify(target, text, record, attachments);
  return { gateway, scheduler, channels };
}

/** Starts the long-running service: gateway, channels, scheduler and (if enabled) the HTTP API. */
export async function startService(garnet: Garnet, rawLog: LogFn, overrides: { channels?: ChannelAdapter[] } = {}): Promise<Service> {
  const { config } = garnet;
  const log = redactingLog(rawLog);
  const { gateway, scheduler, channels } = buildService(garnet, log, overrides.channels ?? createChannels(config, garnet.secret), true);
  let api: ApiServer | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  const pruneNow = (): void => {
    try {
      const r = runRetention(garnet);
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      if (total > 0) log('info', `Retention: removed ${r.inbox} inbox, ${r.outbox} outbox, ${r.sentMessages} sent-message, ${r.jobRuns} job-run, ${r.approvals} approval row(s) and ${r.media} media file(s).`);
    } catch (e) {
      log('warn', `Pruning old records failed: ${errorMessage(e)}`);
    }
  };
  try {
    // Fail fast rather than silently downgrade isolation; remove containers a crash may have left.
    if (garnet.sandbox) {
      await assertSandboxReady(garnet.sandbox, { requireIsolated: config.sandbox.backend === 'docker' });
      await (garnet.sandbox as { cleanup?: () => Promise<unknown> }).cleanup?.();
    }
    await gateway.start();
    scheduler.start();
    retentionTimer = setInterval(pruneNow, RETENTION_EVERY_MS);
    retentionTimer.unref();
    pruneNow();
    if (config.api.enabled) {
      api = new ApiServer({
        gateway,
        keys: garnet.keys,
        keyStore: garnet.keyStore,
        sessions: garnet.store,
        rateLimitPerMinute: config.api.rateLimitPerMinute,
        version: VERSION,
        log,
        admin: createBackend(garnet, gateway, scheduler, VERSION),
        trustProxy: config.api.trustProxy,
        // Base64 data URLs are a third larger than the file; leave room for the rest of the request.
        ...(config.media.enabled ? { maxChatBodyBytes: Math.ceil(config.media.maxBytes * 1.4) + 1_000_000 } : {}),
        corsOrigins: config.api.corsOrigins,
        ...(config.api.demo.enabled ? { demo: createDemo(garnet) } : {}),
        ...(config.dashboard.enabled ? { fallback: staticFiles(join(import.meta.dirname, '..', 'dashboard')) } : {}),
      });
      const address = await api.listen(config.api.host, config.api.port);
      log('info', `API listening on http://${address.address}:${address.port}`);
      if (config.dashboard.enabled) log('info', `Dashboard at http://${address.address}:${address.port}/ (run \`garnet dashboard\` for a login link)`);
    }
  } catch (e) {
    if (retentionTimer) clearInterval(retentionTimer);
    await scheduler.stop();
    await gateway.stop(0);
    throw e;
  }
  const jobs = garnet.jobBook.jobs();
  if (jobs.length) {
    log('info', `Scheduler: ${jobs.filter((j) => j.enabled).length} of ${jobs.length} job(s) enabled (${garnet.timezone})${config.scheduler.enabled ? '' : ' (scheduler switched off)'}`);
  }
  if (config.budgets.dailyUsd !== undefined && !garnet.pricing) log('warn', 'budgets.dailyUsd is set but the model has no known price (set model.pricing): model tasks are refused until it is set.');
  if (garnet.pricing) {
    const derived = derivedCachePrices(garnet.pricing);
    if (derived.length) log('warn', `model.pricing has no ${derived.join(' or ')}: derived from input (cache read 0.1x, cache write 1.25x, Anthropic's standard multipliers). Set them to your provider's prices for exact costs.`);
  }
  for (const p of garnet.jobBook.problems()) log('warn', `job ${p.id} is not scheduled: ${p.problem}`);
  if (channels.length === 0 && !api) log('warn', 'No channels or API enabled; Garnet is idle. Enable one in config.json.');
  return {
    gateway,
    api,
    scheduler,
    stop: async () => {
      if (retentionTimer) clearInterval(retentionTimer);
      await scheduler.stop();
      await api?.close();
      await gateway.stop();
    },
  };
}
