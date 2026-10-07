// Fullscreen screens for `garnet setup` and `garnet config`.
import { loadConfig, writeConfig } from '../../config/index.ts';
import { GarnetError } from '../../contracts/index.ts';
import { themeFor } from '../chat/theme.ts';
import { configScreen } from './config-browser.ts';
import { FullscreenSession, wantsFullscreen, type FsInput, type FsOutput } from './fullscreen.ts';

export { TuiPrompter, SETUP_STAGES, stageOf, type LogLine } from './prompter.ts';
export { FullscreenSession, wantsFullscreen, FULLSCREEN_ON, FULLSCREEN_OFF, type FsInput, type FsOutput } from './fullscreen.ts';

export type TuiStreams = { stdin: FsInput; stdout: FsOutput & { isTTY?: boolean }; env: NodeJS.ProcessEnv };

/** `garnet config` with no subcommand: browse and edit config.json. Returns an exit code. */
export async function runConfigBrowser(streams: TuiStreams, opts: { processHooks?: boolean } = {}): Promise<number> {
  const { config, paths } = loadConfig();
  const session = new FullscreenSession({ input: streams.stdin, output: streams.stdout, processHooks: opts.processHooks ?? true });
  try {
    await session.run(
      configScreen(config, { save: (c) => writeConfig(paths.home, c), file: paths.configFile, theme: themeFor(streams.env, true) }),
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
