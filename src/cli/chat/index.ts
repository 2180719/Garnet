// `ruby chat`: the interactive terminal UI on a TTY, a plain line chat otherwise.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createRuby, type CreateOptions, type Ruby } from '../../main.ts';
import { FakeModel } from '../../models/index.ts';
import type { Approver } from '../../policy/index.ts';
import { InteractiveChat, type TtyInput, type TtyOutput } from './app.ts';
import { InputHistory } from './history.ts';
import { PlainChat } from './plain.ts';
import { themeFor } from './theme.ts';

export type ChatIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  stdin: TtyInput;
  /** The real terminal, when output goes to one; null forces plain mode. */
  stdout: (TtyOutput & { isTTY?: boolean }) | null;
  env: NodeJS.ProcessEnv;
};

export type ChatOverrides = {
  /** Builds Ruby (tests pass a home directory, an in-memory database or a scripted model). */
  createRuby?: (options: CreateOptions) => Ruby;
  /** Install process signal handlers in interactive mode (default true). */
  processHooks?: boolean;
};

export const CHAT_USAGE = 'Usage: ruby chat [--fake] [--session <id>] [--plain]\n';

export async function chat(args: string[], io: ChatIo, overrides: ChatOverrides = {}): Promise<number> {
  let values: { fake?: boolean; session?: string; plain?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args, options: { fake: { type: 'boolean' }, session: { type: 'string' }, plain: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${CHAT_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(`${CHAT_USAGE}\n  --fake           use the offline fake model\n  --session <id>   continue an earlier session (see \`ruby sessions\`)\n  --plain          line-based output even on a terminal\n`);
    return 0;
  }
  const { stdin, stdout, env } = io;
  const interactive = Boolean(!values.plain && stdout?.isTTY && stdin.isTTY && stdin.setRawMode && env.TERM !== 'dumb');

  // The runtime needs an approver before the UI exists; this forwards to it.
  let approve: Approver = async () => 'denied';
  const ruby = (overrides.createRuby ?? createRuby)({
    ...(values.fake ? { model: new FakeModel() } : {}),
    approver: (req) => approve(req),
  });
  try {
    const existing = values.session ? ruby.store.getSession(values.session) : undefined;
    if (values.session && !existing) {
      io.err(`No session "${values.session}". Run \`ruby sessions\` to list them.\n`);
      return 1;
    }
    const session = existing ?? ruby.store.createSession('Terminal chat');
    if (interactive && stdout) {
      const app = new InteractiveChat({
        ruby,
        sessionId: session.id,
        resumed: Boolean(existing),
        stdin,
        stdout,
        theme: themeFor(env, true),
        history: new InputHistory(join(ruby.paths.home, 'chat_history.jsonl')),
        processHooks: overrides.processHooks ?? true,
      });
      approve = app.approve;
      return await app.run();
    }
    const plain = new PlainChat({ ruby, sessionId: session.id, input: stdin, out: io.out, err: io.err, prompt: Boolean(stdin.isTTY) });
    approve = plain.approve;
    return await plain.run();
  } finally {
    ruby.close();
  }
}
