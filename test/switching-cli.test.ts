// CLI wiring for switchers: `ruby pair add`, `ruby service --name`, and `ruby import` writing
// config (raised caps, disabled jobs) and pairings through the real composition root.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { main, type Io } from '../src/cli/main.ts';
import { createRuby } from '../src/main.ts';
import { defaultConfig, parseConfig } from '../src/config/index.ts';

async function withHome<T>(fn: (home: string, run: (args: string[]) => Promise<{ code: number; out: string; err: string }>) => Promise<T>): Promise<T> {
  const home = tempDir();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ ...defaultConfig(), model: { ...defaultConfig().model, provider: 'fake' } }));
  const saved = process.env.RUBY_HOME;
  process.env.RUBY_HOME = home;
  const run = async (args: string[]) => {
    let out = '';
    let err = '';
    const io: Io = { out: (t) => (out += t), err: (t) => (err += t), readSecret: async () => '' };
    const code = await main(args, io);
    return { code, out, err };
  };
  try {
    return await fn(home, run);
  } finally {
    if (saved === undefined) delete process.env.RUBY_HOME;
    else process.env.RUBY_HOME = saved;
  }
}

test('`ruby pair add` pairs a known sender, validates IDs and is idempotent', async () => {
  await withHome(async (home, run) => {
    const ok = await run(['pair', 'add', 'telegram', '123456789', '--name', 'Sam']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Paired telegram Sam \(123456789\)/);
    assert.match(ok.out, /telegram channel is not enabled/);
    assert.match((await run(['pair', 'add', 'telegram', '123456789'])).out, /already paired/);
    assert.match((await run(['pair', 'list'])).out, /telegram Sam \(123456789\)/);
    const bad = await run(['pair', 'add', 'telegram', '@sam']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /not a numeric Telegram user ID/);
    assert.equal((await run(['pair', 'add', 'whatsapp', '+15551234567'])).code, 2);
    assert.equal((await run(['pair', 'add', 'telegram'])).code, 2);
    assert.equal((await run(['pair', 'add', 'discord', '<@234567890123456789>'])).code, 0);
    assert.match((await run(['pair', 'add', 'signal', '+4912345678'])).out, /UUID/);
    const ruby = createRuby({ home, noModel: true });
    try {
      assert.deepEqual(
        ruby.gatewayStore.identities().map((i) => `${i.channel}:${i.senderId}:${i.displayName ?? ''}`),
        ['telegram:123456789:Sam', 'discord:234567890123456789:', 'signal:+4912345678:'],
      );
    } finally {
      ruby.close();
    }
  });
});

test('`ruby service show --name` plans a separate instance; bad names are refused', async () => {
  await withHome(async (home, run) => {
    const r = await run(['service', 'show', '--name', 'work']);
    if (process.platform === 'linux') {
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /ruby-work\.service/);
      assert.ok(r.out.includes(`RUBY_HOME=${home}`));
    }
    const bad = await run(['service', 'install', '--name', 'Bad Name']);
    assert.equal(bad.code, process.platform === 'linux' || process.platform === 'darwin' ? 2 : 1);
    assert.equal((await run(['service', 'frobnicate'])).code, 2);
    assert.match((await run(['help'])).out, /--name lets several RUBY_HOMEs run side by side/);
  });
});

test('`ruby import --apply --raise-caps --pairings` writes caps and disabled jobs to config.json', async () => {
  await withHome(async (home, run) => {
    const src = tempDir();
    const put = (rel: string, text: string) => {
      mkdirSync(join(src, rel, '..'), { recursive: true });
      writeFileSync(join(src, rel), text);
    };
    put('memories/MEMORY.md', Array.from({ length: 60 }, (_, i) => `Fact ${i} ${'z'.repeat(40)}`).join('\n§\n'));
    put('.env', 'TELEGRAM_ALLOWED_USERS=111222333\nOPENROUTER_API_KEY=sk-SECRET\n');
    put('cron/jobs.json', JSON.stringify({ jobs: [{ id: 'x', name: 'Brief', prompt: 'Brief me', schedule: { kind: 'cron', expr: '0 8 * * *' }, deliver: 'telegram:111222333' }] }));
    const dry = await run(['import', 'hermes', '--from', src]);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /Dry run/);
    assert.equal(parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).jobs.length, 0);
    const r = await run(['import', 'hermes', '--from', src, '--apply', '--raise-caps', '--pairings']);
    assert.equal(r.code, 0, r.err);
    const config = parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
    assert.ok(config.memory.memoryChars > 2200);
    assert.deepEqual(
      config.jobs.map((j) => [j.id, j.enabled, j.cron, j.notify?.chatId]),
      [['hermes-brief', false, '0 8 * * *', '111222333']],
    );
    assert.ok(!readFileSync(join(home, 'config.json'), 'utf8').includes('sk-SECRET'));
    assert.match((await run(['pair', 'list'])).out, /telegram {2}\(111222333\)/);
    assert.match((await run(['jobs', 'list'])).out, /hermes-brief\s+disabled/);
    // a second run adds nothing
    const again = await run(['import', 'hermes', '--from', src, '--apply', '--pairings']);
    assert.match(again.out, /job hermes-brief: exists/);
    assert.match(again.out, /already paired/);
  });
});
