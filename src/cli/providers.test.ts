import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig, parseConfig, writeConfig } from '../config/index.ts';
import type { Io } from './main.ts';
import { providers } from './providers.ts';

test('`providers add` gives each openai-compatible provider its own key name unless --key-env says otherwise', async () => {
  const home = join(tempDir(), 'garnet');
  writeConfig(home, defaultConfig());
  const io: Io = { out: () => {}, err: () => {} };
  const add = async (name: string, ...extra: string[]) =>
    assert.equal(await providers(['add', name, '--provider', 'openai-compatible', '--model', 'm', '--offline', '--base-url', `https://${name}.example/v1`, ...extra], io, { home }), 0);
  await add('work-a');
  await add('work-b');
  await add('work-c', '--key-env', 'SHARED_KEY');
  const c = parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
  assert.equal(c.providers['work-a']!.apiKeyEnv, 'WORK_A_API_KEY');
  assert.equal(c.providers['work-b']!.apiKeyEnv, 'WORK_B_API_KEY');
  assert.equal(c.providers['work-c']!.apiKeyEnv, 'SHARED_KEY');
});
