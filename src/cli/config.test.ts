import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig, loadConfig } from '../config/index.ts';
import { main, type Io } from './main.ts';

function cli(home: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t) };
  return async (...args: string[]) => {
    const prev = process.env.GARNET_HOME;
    process.env.GARNET_HOME = home;
    try {
      out.length = err.length = 0;
      const code = await main(['config', ...args], io);
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      if (prev === undefined) delete process.env.GARNET_HOME;
      else process.env.GARNET_HOME = prev;
    }
  };
}

test('garnet config set/get/unset: atomic file, prints the change, errors leave the file alone', async () => {
  const home = tempDir();
  const run = cli(home);
  let r = await run('set', 'api.port', '8123');
  assert.equal(r.code, 0);
  assert.match(r.out, /api\.port: \d+ -> 8123/);
  assert.equal(loadConfig(home).config.api.port, 8123);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  r = await run('get', 'api.port');
  assert.equal(r.out.trim(), '8123');
  const before = readFileSync(join(home, 'config.json'), 'utf8');
  r = await run('set', 'api.port', '0');
  assert.equal(r.code, 1);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
  r = await run('set', 'model.apiKeyEnv', key);
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(key) && !r.err.includes(key));
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), before);
  r = await run('unset', 'api.port');
  assert.equal(r.code, 0);
  assert.equal(loadConfig(home).config.api.port, defaultConfig().api.port);
  r = await run('get', 'nope.nothing');
  assert.equal(r.code, 1);
  r = await run('set', 'api.port');
  assert.equal(r.code, 2);
});
