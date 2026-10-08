// Fullscreen screens for `garnet setup` and `garnet config`.
import { loadConfig, writeConfig } from '../../config/index.ts';
import { GarnetError } from '../../contracts/index.ts';
import { themeFor } from '../chat/theme.ts';
import { openSecretStore } from '../../secrets/index.ts';
import { configScreen, type SecretStatus } from './config-browser.ts';
import { FullscreenSession, wantsFullscreen, type FsInput, type FsOutput } from './fullscreen.ts';

export { TuiPrompter, SETUP_STAGES, stageOf, type LogLine } from './prompter.ts';
export { FullscreenSession, wantsFullscreen, FULLSCREEN_ON, FULLSCREEN_OFF, type FsInput, type FsOutput } from './fullscreen.ts';

export type TuiStreams = { stdin: FsInput; stdout: FsOutput & { isTTY?: boolean }; env: NodeJS.ProcessEnv };

/**
 * Whether a secret NAME resolves: in the environment, or in the encrypted store. Names only, never values.
 * The store is read once, so redrawing does not repeat the key derivation.
 */
export function secretStatusFor(home: string, env: NodeJS.ProcessEnv): (name: string) => SecretStatus {
  // The store is opened (one key derivation) the first time a name is not in the environment, then reused.
  let stored: Set<string> | 'locked' | null = null;
  return (name) => {
    if (env[name]) return 'set';
    if (stored === null) {
      try {
        const store = openSecretStore(home, env);
        stored = new Set(store.exists() ? store.names() : []);
      } catch {
        stored = 'locked';
      }
    }
    return stored === 'locked' ? 'locked' : stored.has(name) ? 'set' : 'missing';
  };
}

/** `garnet config` with no subcommand: browse and edit config.json. Returns an exit code. */
export async function runConfigBrowser(streams: TuiStreams, opts: { processHooks?: boolean } = {}): Promise<number> {
  const { config, paths } = loadConfig();
  const session = new FullscreenSession({ input: streams.stdin, output: streams.stdout, processHooks: opts.processHooks ?? true });
  try {
    await session.run(
      configScreen(config, { save: (c) => writeConfig(paths.home, c), file: paths.configFile, theme: themeFor(streams.env, true), secretStatus: secretStatusFor(paths.home, streams.env) }),
      'Config',
    );
    return 0;
  } catch (e) {
    if (e instanceof GarnetError && e.category === 'cancelled') return 130;
    throw e;
  } finally {
    session.close();
  }
}

export function configWantsTui(streams: Pick<TuiStreams, 'stdin' | 'stdout' | 'env'>, plain: boolean): boolean {
  return wantsFullscreen(streams, streams.env, plain);
}
