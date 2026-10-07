// `garnet sandbox check`: probes the configured command sandbox (read-only) and says how to fix it.
import { mkdirSync } from 'node:fs';
import { garnetHome, loadConfig } from '../config/index.ts';
import { errorMessage } from '../contracts/index.ts';
import { sandboxOptions } from '../main.ts';
import { createSandbox } from '../sandbox/index.ts';
import { openSecretStore, secretLookup } from '../secrets/index.ts';
import type { Io } from './main.ts';

export async function sandboxCommand(args: string[], io: Io): Promise<number> {
  if (args[0] !== 'check' || args.length > 1) {
    io.err('Usage: garnet sandbox check\n');
    return 2;
  }
  try {
    const home = garnetHome();
    const { config, paths } = loadConfig(home);
    const sb = config.sandbox;
    mkdirSync(paths.workspace, { recursive: true }); // as `garnet start` does
    const note = config.permissions.exec === 'deny' ? ' (note: permissions.exec is deny, so run_command is off)' : '';
    const secret = secretLookup(process.env, openSecretStore(paths.home, process.env));
    const status = await createSandbox(sb.backend, sandboxOptions(config, paths.workspace, secret)).check();
    if (status.ok) {
      io.out(`Sandbox ${sb.backend}: ${status.detail}${note}\n`);
      return 0;
    }
    io.err(`Sandbox ${sb.backend} is not ready: ${status.detail}${note}\n`);
    return 1;
  } catch (e) {
    io.err(`Sandbox check failed: ${errorMessage(e)}\n`);
    return 1;
  }
}
