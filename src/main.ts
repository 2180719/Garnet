// Composition root: the only place modules are wired together.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramChannel } from './channels/index.ts';
import { loadConfig, redact, rubyHome, type Paths, type RubyConfig } from './config/index.ts';
import { RubyError, type ChannelAdapter, type ModelAdapter } from './contracts/index.ts';
import { ApiKeys, ApiServer, Gateway, type LogFn } from './gateway/index.ts';
import { AnthropicModel, FakeModel } from './models/index.ts';
import { Policy, deferAll, type Approver } from './policy/index.ts';
import { Agent, LaneQueue } from './runtime/index.ts';
import { GatewayStore, KeyStore, openDb, SessionStore, type Db } from './store/index.ts';
import { MemoryStore, memoryTool } from './memory/index.ts';
import { SkillStore, skillTools } from './skills/index.ts';
import { ArtifactStore, ToolExecutor, ToolRegistry, fileTools, readArtifactTool } from './tools/index.ts';

export const VERSION = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;

export type Ruby = {
  config: RubyConfig;
  paths: Paths;
  env: NodeJS.ProcessEnv;
  db: Db;
  store: SessionStore;
  gatewayStore: GatewayStore;
  keyStore: KeyStore;
  keys: ApiKeys;
  registry: ToolRegistry;
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
  mkdirSync(paths.workspace, { recursive: true });
  const db = openDb(options.memoryDb ? ':memory:' : paths.database);
  const store = new SessionStore(db);
  const keyStore = new KeyStore(db);
  const memory = new MemoryStore({ root: join(paths.home, 'memory'), limits: { memory: config.memory.memoryChars, user: config.memory.userChars } });
  const skills = new SkillStore({ root: join(paths.home, 'skills') });
  const artifacts = new ArtifactStore(join(paths.home, 'artifacts'));
  const registry = new ToolRegistry();
  for (const tool of [...fileTools, memoryTool(memory), ...skillTools(skills), readArtifactTool(artifacts)]) registry.register(tool);
  const policy = new Policy(config.permissions);
  const executor = new ToolExecutor({ registry, policy, approver: options.approver ?? deferAll, artifacts });
  const model = options.model ?? (options.noModel ? new FakeModel() : createModel(config, env));
  const agent = new Agent({
    store,
    model,
    registry,
    executor,
    budget: config.budgets,
    workspace: paths.workspace,
    persona: config.persona,
    promptSections: (ns) => [memory.snapshot(ns), skills.index()],
    compactAtTokens: config.context.compactAtTokens,
    keepTurns: config.context.keepTurns,
    maxOutputTokens: config.model.maxOutputTokens,
  });
  return {
    config,
    paths,
    env,
    db,
    store,
    gatewayStore: new GatewayStore(db),
    keyStore,
    keys: new ApiKeys(keyStore),
    registry,
    memory,
    skills,
    agent,
    model,
    close: () => db.close(),
  };
}

export function createModel(config: RubyConfig, env: NodeJS.ProcessEnv): ModelAdapter {
  const m = config.model;
  if (m.provider === 'fake') return new FakeModel();
  const apiKey = env[m.apiKeyEnv];
  if (!apiKey) {
    throw new RubyError('config', `No API key found. Set the ${m.apiKeyEnv} environment variable, or run with --fake.`);
  }
  return new AnthropicModel({
    apiKey,
    model: m.name,
    effort: m.effort,
    fallbacks: m.fallbacks,
    ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
  });
}

export function createChannels(config: RubyConfig, env: NodeJS.ProcessEnv): ChannelAdapter[] {
  const channels: ChannelAdapter[] = [];
  const tg = config.channels.telegram;
  if (tg.enabled) {
    const token = env[tg.tokenEnv];
    if (!token) throw new RubyError('config', `Telegram is enabled but ${tg.tokenEnv} is not set.`);
    channels.push(new TelegramChannel({ token }));
  }
  return channels;
}

export type Service = { gateway: Gateway; api: ApiServer | null; stop: () => Promise<void> };

/** Starts the long-running service: gateway, channels and (if enabled) the HTTP API. */
export async function startService(ruby: Ruby, log: LogFn, overrides: { channels?: ChannelAdapter[] } = {}): Promise<Service> {
  const { config } = ruby;
  const channels = overrides.channels ?? createChannels(config, ruby.env);
  const gateway = new Gateway({
    store: ruby.gatewayStore,
    sessions: ruby.store,
    agent: ruby.agent,
    lanes: new LaneQueue(config.gateway.maxConcurrent),
    channels,
    routes: config.routes,
    pairingTtlMinutes: config.gateway.pairingTtlMinutes,
    log: (level, message) => log(level, redact(message)),
  });
  let api: ApiServer | null = null;
  try {
    await gateway.start();
    if (config.api.enabled) {
      api = new ApiServer({
        gateway,
        keys: ruby.keys,
        keyStore: ruby.keyStore,
        sessions: ruby.store,
        rateLimitPerMinute: config.api.rateLimitPerMinute,
        version: VERSION,
        log,
      });
      const address = await api.listen(config.api.host, config.api.port);
      log('info', `API listening on http://${address.address}:${address.port}`);
    }
  } catch (e) {
    await gateway.stop(0);
    throw e;
  }
  if (channels.length === 0 && !api) log('warn', 'No channels or API enabled; Ruby is idle. Enable one in config.json.');
  return {
    gateway,
    api,
    stop: async () => {
      await api?.close();
      await gateway.stop();
    },
  };
}
