// Composition root: the only place modules are wired together.
import { mkdirSync } from 'node:fs';
import { loadConfig, rubyHome, type Paths, type RubyConfig } from './config/index.ts';
import { RubyError, type ModelAdapter } from './contracts/index.ts';
import { AnthropicModel, FakeModel } from './models/index.ts';
import { Policy, deferAll, type Approver } from './policy/index.ts';
import { Agent } from './runtime/index.ts';
import { openDb, SessionStore, type Db } from './store/index.ts';
import { ToolExecutor, ToolRegistry, fileTools } from './tools/index.ts';

export type Ruby = {
  config: RubyConfig;
  paths: Paths;
  db: Db;
  store: SessionStore;
  registry: ToolRegistry;
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
};

export function createRuby(options: CreateOptions = {}): Ruby {
  const env = options.env ?? process.env;
  const { config, paths } = loadConfig(options.home ?? rubyHome(env));
  mkdirSync(paths.workspace, { recursive: true });
  const db = openDb(options.memoryDb ? ':memory:' : paths.database);
  const store = new SessionStore(db);
  const registry = new ToolRegistry();
  for (const tool of fileTools) registry.register(tool);
  const policy = new Policy(config.permissions);
  const executor = new ToolExecutor({ registry, policy, approver: options.approver ?? deferAll });
  const model = options.model ?? createModel(config, env);
  const agent = new Agent({
    store,
    model,
    registry,
    executor,
    budget: config.budgets,
    workspace: paths.workspace,
    persona: config.persona,
    maxOutputTokens: config.model.maxOutputTokens,
  });
  return { config, paths, db, store, registry, agent, model, close: () => db.close() };
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
