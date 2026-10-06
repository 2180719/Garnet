// Composition root: the only place modules are wired together.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordChannel, SignalChannel, TelegramChannel } from './channels/index.ts';
import { loadConfig, redact, rubyHome, type Paths, type RubyConfig } from './config/index.ts';
import { RubyError, type Budget, type ChannelAdapter, type ModelAdapter } from './contracts/index.ts';
import { ApiKeys, ApiServer, DemoChat, Gateway, persistentApprover, staticFiles, type LogFn } from './gateway/index.ts';
import { createBackend } from './backend.ts';
import { AnthropicModel, FakeModel, OpenAICompatibleModel } from './models/index.ts';
import { Policy, type Approver } from './policy/index.ts';
import { Agent, LaneQueue } from './runtime/index.ts';
import { ApprovalStore, GatewayStore, JobStore, KeyStore, openDb, SessionStore, type Db } from './store/index.ts';
import { Scheduler } from './scheduler/index.ts';
import { MemoryStore, memoryTool } from './memory/index.ts';
import { importedArchiveSection } from './migrate/index.ts';
import { SkillStore, skillTools } from './skills/index.ts';
import { ArtifactStore, ToolExecutor, ToolRegistry, execTool, fileTools, readArtifactTool } from './tools/index.ts';
import { assertSandboxReady, createSandbox, type Sandbox } from './sandbox/index.ts';
import { isInside, openSecretStore, secretLookup, type SecretLookup, type SecretStore } from './secrets/index.ts';

export const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

export type Ruby = {
  config: RubyConfig;
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
  ownerPolicy: Policy;
  makeAgent: (policy: Policy, budget: Budget) => Agent;
  memory: MemoryStore;
  skills: SkillStore;
  agent: Agent;
  model: ModelAdapter;
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
};

export function createRuby(options: CreateOptions = {}): Ruby {
  const env = options.env ?? process.env;
  const { config, paths } = loadConfig(options.home ?? rubyHome(env));
  if (isInside(paths.workspace, paths.home)) {
    // File tools are scoped to the workspace; if it held config.json, secrets or skill sidecars, one approved write could grant everything.
    throw new RubyError('config', `workspace (${paths.workspace}) must not contain Ruby's home (${paths.home}): tools could change config.json, secrets and skills there. Point "workspace" at a directory of its own.`);
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
  const registry = new ToolRegistry();
  for (const tool of [...fileTools, memoryTool(memory), ...skillTools(skills), readArtifactTool(artifacts)]) registry.register(tool);
  // run_command exists only when the owner opted into exec; the tool set is fixed per session.
  let sandbox: Sandbox | null = null;
  if (config.permissions.exec !== 'deny') {
    const sb = config.sandbox;
    sandbox = createSandbox(sb.backend, { workspace: paths.workspace, image: sb.image, network: sb.network, memory: sb.memory, cpus: sb.cpus, pidsLimit: sb.pidsLimit, ...(sb.user ? { user: sb.user } : {}) });
    registry.register(execTool(sandbox));
  }
  const approvals = new ApprovalStore(db);
  const approver = options.approver ?? persistentApprover(approvals);
  const model = options.model ?? (options.noModel ? new FakeModel() : createModel(config, secret));
  /** Builds an agent with its own policy and budget (interactive, or a scheduled job's narrower grant). */
  const makeAgent = (policy: Policy, budget: Budget): Agent =>
    new Agent({
      store,
      model,
      registry,
      executor: new ToolExecutor({ registry, policy, approver, artifacts }),
      budget,
      workspace: paths.workspace,
      persona: config.persona,
      promptSections: (ns) => [memory.snapshot(ns), skills.index(), importedArchiveSection(paths.workspace)],
      compactAtTokens: config.context.compactAtTokens,
      keepTurns: config.context.keepTurns,
      maxOutputTokens: config.model.maxOutputTokens,
    });
  const ownerPolicy = new Policy(config.permissions);
  const agent = makeAgent(ownerPolicy, config.budgets);
  return {
    config,
    paths,
    env,
    secrets,
    secret,
    db,
    store,
    gatewayStore: new GatewayStore(db),
    approvals,
    jobStore: new JobStore(db),
    ownerPolicy,
    makeAgent,
    keyStore,
    keys: new ApiKeys(keyStore),
    registry,
    sandbox,
    memory,
    skills,
    agent,
    model,
    close: () => db.close(),
  };
}

/** `secret` resolves a name (environment first, then the encrypted store); see src/secrets. */
export function createModel(config: RubyConfig, secret: SecretLookup): ModelAdapter {
  const m = config.model;
  if (m.provider === 'fake') return new FakeModel();
  const apiKey = secret(m.apiKeyEnv);
  if (m.provider === 'openai-compatible') {
    // Local servers often need no key.
    return new OpenAICompatibleModel({ baseUrl: m.baseUrl!, apiKey, model: m.name, contextWindow: m.contextWindow });
  }
  if (!apiKey) {
    throw new RubyError('config', `No API key found. Set the ${m.apiKeyEnv} environment variable or store it with \`ruby secrets set ${m.apiKeyEnv}\`, or run with --fake.`);
  }
  return new AnthropicModel({
    apiKey,
    model: m.name,
    effort: m.effort,
    fallbacks: m.fallbacks,
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
  });
}

/** The website demo uses its own cheap model with the same provider and credentials. */
function createDemo(ruby: Ruby): DemoChat {
  const d = ruby.config.api.demo;
  const model = createModel({ ...ruby.config, model: { ...ruby.config.model, name: d.model, effort: 'low' } }, ruby.secret);
  return new DemoChat({ model, allowedOrigins: d.allowedOrigins, perIpPerHour: d.perIpPerHour, dailyTokenBudget: d.dailyTokenBudget, maxOutputTokens: d.maxOutputTokens });
}

export function createChannels(config: RubyConfig, secret: SecretLookup): ChannelAdapter[] {
  const channels: ChannelAdapter[] = [];
  const tg = config.channels.telegram;
  if (tg.enabled) {
    const token = secret(tg.tokenEnv);
    if (!token) throw new RubyError('config', `Telegram is enabled but ${tg.tokenEnv} is not set (environment or \`ruby secrets set ${tg.tokenEnv}\`).`);
    channels.push(new TelegramChannel({ token }));
  }
  const dc = config.channels.discord;
  if (dc.enabled) {
    const token = secret(dc.tokenEnv);
    if (!token) throw new RubyError('config', `Discord is enabled but ${dc.tokenEnv} is not set (environment or \`ruby secrets set ${dc.tokenEnv}\`).`);
    channels.push(new DiscordChannel({ token }));
  }
  const sig = config.channels.signal;
  if (sig.enabled) channels.push(new SignalChannel({ account: sig.account!, baseUrl: sig.baseUrl }));
  return channels;
}

export type Service = { gateway: Gateway; api: ApiServer | null; scheduler: Scheduler; stop: () => Promise<void> };

/** Each job runs as its own agent: its grant intersected with the owner's permissions, and its own budget. */
function jobAgents(ruby: Ruby): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const job of ruby.config.jobs) {
    const policy = ruby.ownerPolicy.intersect(new Policy(job.permissions));
    agents.set(`job:${job.id}`, ruby.makeAgent(policy, { ...ruby.config.budgets, maxTokens: job.budget.maxTokensPerRun, maxWallMs: job.timeoutMinutes * 60_000 }));
  }
  return agents;
}

/** Wraps a logger so every message is redacted before it is written. */
export function redactingLog(log: LogFn): LogFn {
  return (level, message) => log(level, redact(message));
}

/** Wires the gateway and scheduler without starting anything. `deliver` is false for short-lived CLI processes. */
export function buildService(ruby: Ruby, rawLog: LogFn, channels: ChannelAdapter[], deliver: boolean): { gateway: Gateway; scheduler: Scheduler; channels: ChannelAdapter[] } {
  const { config } = ruby;
  const log = redactingLog(rawLog);
  const agents = jobAgents(ruby);
  const gateway = new Gateway({
    store: ruby.gatewayStore,
    approvals: ruby.approvals,
    sessions: ruby.store,
    agent: ruby.agent,
    agentFor: (key) => agents.get(key),
    lanes: new LaneQueue(config.gateway.maxConcurrent),
    channels,
    routes: config.routes,
    pairingTtlMinutes: config.gateway.pairingTtlMinutes,
    deliveryEnabled: deliver,
    log,
  });
  const scheduler = new Scheduler({
    jobs: config.jobs,
    store: ruby.jobStore,
    workspace: ruby.paths.workspace,
    enabled: config.scheduler.enabled,
    tickSeconds: config.scheduler.tickSeconds,
    log,
    run: (job, text, signal) => gateway.chat(`job:${job.id}`, text, { signal, source: 'scheduler' }),
    notify: (job, text) => {
      if (!job.notify) return;
      const account = job.notify.channel === 'signal' ? (config.channels.signal.account ?? job.notify.account) : job.notify.account;
      gateway.notify({ channel: job.notify.channel, account, chatId: job.notify.chatId }, text);
    },
  });
  return { gateway, scheduler, channels };
}

/** Starts the long-running service: gateway, channels, scheduler and (if enabled) the HTTP API. */
export async function startService(ruby: Ruby, rawLog: LogFn, overrides: { channels?: ChannelAdapter[] } = {}): Promise<Service> {
  const { config } = ruby;
  const log = redactingLog(rawLog);
  const { gateway, scheduler, channels } = buildService(ruby, log, overrides.channels ?? createChannels(config, ruby.secret), true);
  let api: ApiServer | null = null;
  try {
    // Fail fast rather than silently downgrade isolation; remove containers a crash may have left.
    if (ruby.sandbox) {
      await assertSandboxReady(ruby.sandbox, { requireIsolated: config.sandbox.backend === 'docker' });
      await (ruby.sandbox as { cleanup?: () => Promise<unknown> }).cleanup?.();
    }
    await gateway.start();
    scheduler.start();
    if (config.api.enabled) {
      api = new ApiServer({
        gateway,
        keys: ruby.keys,
        keyStore: ruby.keyStore,
        sessions: ruby.store,
        rateLimitPerMinute: config.api.rateLimitPerMinute,
        version: VERSION,
        log,
        admin: createBackend(ruby, gateway, scheduler, VERSION),
        trustProxy: config.api.trustProxy,
        ...(config.api.demo.enabled ? { demo: createDemo(ruby) } : {}),
        ...(config.dashboard.enabled ? { fallback: staticFiles(join(import.meta.dirname, '..', 'dashboard')) } : {}),
      });
      const address = await api.listen(config.api.host, config.api.port);
      log('info', `API listening on http://${address.address}:${address.port}`);
      if (config.dashboard.enabled) log('info', `Dashboard at http://${address.address}:${address.port}/ (run \`ruby dashboard\` for a login link)`);
    }
  } catch (e) {
    await scheduler.stop();
    await gateway.stop(0);
    throw e;
  }
  if (config.jobs.length) {
    log('info', `Scheduler: ${config.jobs.filter((j) => j.enabled).length} of ${config.jobs.length} job(s) enabled${config.scheduler.enabled ? '' : ' (scheduler switched off)'}`);
  }
  if (channels.length === 0 && !api) log('warn', 'No channels or API enabled; Ruby is idle. Enable one in config.json.');
  return {
    gateway,
    api,
    scheduler,
    stop: async () => {
      await scheduler.stop();
      await api?.close();
      await gateway.stop();
    },
  };
}
