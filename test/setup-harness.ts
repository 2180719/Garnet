// A wired setup wizard for tests: temp home, fake service, scripted fetch and pairing, all through SetupDeps.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../src/config/index.ts';
import type { ServiceResult } from '../src/service/index.ts';
import type { Io } from '../src/cli/main.ts';
import { AnswerPrompter, makeStyle, type Answer } from '../src/cli/setup/prompt.ts';
import { runSetup, type Pairing, type SetupDeps } from '../src/cli/setup/wizard.ts';
import { tempDir } from './helpers.ts';

export const kdf = { N: 2 ** 10, r: 8, p: 1 };
export const KEY = 'sk-ant-api03-NEVER-PRINT-THIS-0123456789';
export const TG = '123456789:AAThisIsNotARealTelegramToken_xyz';

export type Call = { url: string; headers: Record<string, string> };

export function harness(opts: { home?: string; env?: NodeJS.ProcessEnv; responses?: ((url: string) => { status: number; body: unknown })[]; installed?: boolean; pending?: Pairing[]; sources?: SetupDeps['importSources'] } = {}) {
  const home = opts.home ?? tempDir();
  const keyDir = tempDir();
  const env: NodeJS.ProcessEnv = opts.env ?? {};
  let out = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (out += t) };
  const calls: Call[] = [];
  const responses = [...(opts.responses ?? [])];
  const svc = { installs: 0, restarts: 0, installed: opts.installed ?? false };
  const ok = (cmd: string[]): ServiceResult => ({ ok: true, files: [], commands: [{ cmd, code: 0, stdout: '', stderr: '' }], notes: [] });
  const imports: string[][] = [];
  const approved: string[] = [];
  const pending = [...(opts.pending ?? [])];
  const deps: SetupDeps = {
    home,
    env,
    style: makeStyle(false),
    defaultKeyFile: join(keyDir, 'garnet', 'secrets.key'),
    kdf,
    now: () => new Date('2026-10-06T12:00:00Z'),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      const r = (responses.shift() ?? (() => ({ status: 200, body: { data: [] } })))(url);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
    service: {
      label: 'systemd user service',
      installed: () => svc.installed,
      install: async () => {
        svc.installs++;
        svc.installed = true;
        return ok(['systemctl', '--user', 'enable', '--now', 'garnet.service']);
      },
      restart: async () => {
        svc.restarts++;
        return ok(['systemctl', '--user', 'restart', 'garnet.service']);
      },
    },
    importSources: opts.sources ?? (() => []),
    runImport: (args, persona) => {
      imports.push(args);
      if (args.includes('--apply') && persona.get() === undefined) persona.set('You are a careful assistant imported from elsewhere.');
      return 0;
    },
    pairing: () => ({
      pending: () => pending.filter((p) => !approved.includes(p.code)),
      approve: (code) => {
        approved.push(code);
        return pending.find((p) => p.code === code) ?? null;
      },
      close: () => {},
    }),
  };
  const run = (answers: Record<string, Answer | Answer[]>, secrets: Record<string, string> = {}, interactive = true) => {
    const p = new AnswerPrompter(answers, { interactive, secrets });
    return { p, done: runSetup(p, io, deps) };
  };
  return { home, env, deps, io, run, calls, svc, imports, approved, out: () => out, config: () => parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))) };
}

