// `garnet chat`: the interactive terminal UI on a TTY, a plain line chat otherwise.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createGarnet, type CreateOptions, type Garnet } from '../../main.ts';
import { loadConfig, readPersona, validTimeZone } from '../../config/index.ts';
import { FakeModel, onboardingScript } from '../../models/index.ts';
import { KICKOFF_MESSAGE, ONBOARDING_TITLE, OnboardingWatch, applyProfile } from '../../onboarding/index.ts';
import type { Approver } from '../../policy/index.ts';
import { InteractiveChat, type TtyInput, type TtyOutput } from './app.ts';
import { InputHistory } from './history.ts';
import { PlainChat } from './plain.ts';
import { askBasics } from '../setup/persona.ts';
import { TerminalPrompter, makeStyle, wantsColor, type Prompter } from '../setup/prompt.ts';
import type { OnboardFlow } from './flow.ts';
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
  /** Builds Garnet (tests pass a home directory, an in-memory database or a scripted model). */
  createGarnet?: (options: CreateOptions) => Garnet;
  /** Install process signal handlers in interactive mode (default true). */
  processHooks?: boolean;
  /** Asks the fallback form questions after the interactive chat gave up (tests; default: a terminal prompter). */
  formPrompter?: Prompter;
};

export const CHAT_USAGE = 'Usage: garnet chat [--fake] [--session <id>] [--plain] [--onboard]\n';

export async function chat(args: string[], io: ChatIo, overrides: ChatOverrides = {}): Promise<number> {
  let values: { fake?: boolean; session?: string; plain?: boolean; onboard?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args, options: { fake: { type: 'boolean' }, session: { type: 'string' }, plain: { type: 'boolean' }, onboard: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${CHAT_USAGE}`);
    return 2;
  }
  if (values.help) {
    io.out(`${CHAT_USAGE}\n  --fake           use the offline fake model\n  --session <id>   continue an earlier session (see \`garnet sessions\`)\n  --plain          line-based output even on a terminal\n  --onboard        wake-up chat: the agent introduces itself and asks to set up its name and your preferences\n                   (also \`garnet wake\`; falls back to a short form if tools fail)\n`);
    return 0;
  }
  if (values.onboard && values.session) {
    io.err('--onboard starts a new session; it cannot be combined with --session.\n');
    return 2;
  }
  const { stdin, stdout, env } = io;
  const interactive = Boolean(!values.plain && stdout?.isTTY && stdin.isTTY && stdin.setRawMode && env.TERM !== 'dumb');

  // The runtime needs an approver before the UI exists; this forwards to it.
  let approve: Approver = async () => 'denied';
  const garnet = (overrides.createGarnet ?? createGarnet)({
    ...(values.fake ? { model: new FakeModel(values.onboard ? onboardingScript() : []) } : {}),
    ...(values.onboard ? { onboarding: true } : {}),
    approver: (req) => approve(req),
  });
  try {
    if (values.onboard && garnet.config.permissions['memory.write'] === 'deny') {
      io.err('The wake-up chat saves with set_profile and memory, which need the memory.write permission, and it is set to deny here.\nAllow it in config.json (permissions) or run `garnet setup` for the form.\n');
      return 1;
    }
    const existing = values.session ? garnet.store.getSession(values.session) : undefined;
    if (values.session && !existing) {
      io.err(`No session "${values.session}". Run \`garnet sessions\` to list them.\n`);
      return 1;
    }
    const session = existing ?? garnet.store.createSession(values.onboard ? ONBOARDING_TITLE : 'Terminal chat');
    const home = garnet.paths.home;
    const profile = (): string => {
      const c = loadConfig(home).config;
      return JSON.stringify([readPersona(c.persona), c.timezone ?? null]);
    };
    const before = values.onboard ? profile() : '';
    // Leaving the wake-up chat early (or never answering) must not look like a finished setup.
    const stillToDo = (): void => {
      // A set_profile that saved the same values as before is still a finished setup.
      if (values.onboard && profile() === before && !watch.summary().ok.includes('set_profile')) io.err('\n  Still to do: your name and preferences were not saved. Run `garnet wake` to try again, or `garnet setup` for the short form.\n');
    };
    const watch = new OnboardingWatch(() => garnet.store.events(session.id));
    // Same questions as the setup form, saved through the same persona code as `set_profile`.
    const saveForm = async (p: Pick<Prompter, 'text'>, say: (text: string) => void): Promise<void> => {
      // Defaults are whatever is already saved (by the agent or an earlier run), so nothing the owner said is asked for twice.
      const saved = loadConfig(home).config;
      const b = await askBasics(p, readPersona(saved.persona));
      const tz = await p.text({
        id: 'timezone',
        message: 'And your time zone?',
        help: 'Optional. An IANA name such as Europe/Lisbon. Press Enter to keep the current one.',
        default: saved.timezone ?? '',
        validate: (v) => (!v || validTimeZone(v) ? null : 'Use an IANA name like Europe/Lisbon or America/New_York.'),
      });
      applyProfile(home, { name: b.name, owner: b.owner, notes: b.notes, ...(tz && tz !== saved.timezone ? { timezone: tz } : {}) });
      say(`  Saved: ${b.name}${b.owner ? `, working for ${b.owner}` : ''}${tz ? `, time zone ${tz}` : ''}. This applies from the next session; run \`garnet wake\` to try the conversation again.\n`);
    };
    const flow: OnboardFlow | undefined = values.onboard ? { kickoff: KICKOFF_MESSAGE, check: (status) => watch.afterTurn(status), form: saveForm } : undefined;
    if (interactive && stdout) {
      const app = new InteractiveChat({
        garnet,
        sessionId: session.id,
        resumed: Boolean(existing),
        stdin,
        stdout,
        theme: themeFor(env, true),
        history: new InputHistory(join(garnet.paths.home, 'chat_history.jsonl')),
        processHooks: overrides.processHooks ?? true,
        ...(flow ? { onboard: flow } : {}),
      });
      approve = app.approve;
      const code = await app.run();
      if (app.fallbackReason !== null) {
        // The terminal is restored; ask the same questions as the setup form.
        const p = overrides.formPrompter ?? new TerminalPrompter({ input: stdin as NodeJS.ReadStream, output: stdout as unknown as NodeJS.WriteStream, style: makeStyle(wantsColor(stdout, env)) });
        try {
          await saveForm(p, (t) => io.err(t));
        } catch (e) {
          io.err(`Could not save: ${e instanceof Error ? e.message : String(e)}. Run \`garnet setup\` to set the name and persona.\n`);
        }
      } else {
        stillToDo();
      }
      return code;
    }
    const plain = new PlainChat({ garnet, sessionId: session.id, input: stdin, out: io.out, err: io.err, prompt: Boolean(stdin.isTTY), ...(flow ? { onboard: flow } : {}) });
    approve = plain.approve;
    const code = await plain.run();
    if (!plain.fellBack) stillToDo();
    return code;
  } finally {
    garnet.close();
  }
}
