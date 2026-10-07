import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig, writeConfig, type GarnetConfig } from '../config/index.ts';
import { PASSPHRASE_ENV, openSecretStore } from '../secrets/index.ts';
import { planService } from '../service/index.ts';
import { diagnose, doctor, formatFindings, nodeOk, type DoctorDeps, type Finding } from './doctor.ts';
import type { Io } from './main.ts';
import { makeStyle } from './setup/prompt.ts';

const KEY = 'sk-ant-NEVER-PRINT-THIS-0123456789';

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps & { commands: string[][]; sandboxChecks: number } {
  const install = tempDir('garnet-install-');
  const commands: string[][] = [];
  const d = {
    home: join(tempDir(), 'garnet'),
    env: { PATH: '' } as NodeJS.ProcessEnv,
    platform: 'linux' as NodeJS.Platform,
    nodeVersion: '22.18.0',
    userHome: tempDir(),
    entry: join(install, 'src', 'cli', 'bin.ts'),
    version: '0.1.0',
    run: async (cmd: string[]) => {
      commands.push(cmd);
      return { code: 0, stdout: 'active', stderr: '' };
    },
    sqlite: () => ({ ok: true, detail: 'node:sqlite with FTS5' }),
    sandboxChecks: 0,
    sandboxCheck: async () => {
      d.sandboxChecks++;
      return { ok: false, detail: 'Docker is not available (docker version failed). Install and start Docker.' };
    },
    commands,
    ...over,
  };
  return d;
}

const find = (fs: Finding[], area: string) => fs.filter((f) => f.area === area);

function configure(home: string, edit: (c: GarnetConfig) => void = () => {}) {
  const c = defaultConfig();
  edit(c);
  writeConfig(home, c);
}

test('nodeOk compares major.minor against 22.18', () => {
  assert.equal(nodeOk('22.18.0'), true);
  assert.equal(nodeOk('v22.22.1'), true);
  assert.equal(nodeOk('24.0.0'), true);
  assert.equal(nodeOk('22.17.9'), false);
  assert.equal(nodeOk('20.19.0'), false);
});

test('a fresh machine: old node, no home; each problem says how to fix it', async () => {
  const d = deps({ nodeVersion: '20.11.0', sqlite: () => ({ ok: false, detail: 'node:sqlite is not usable: No such built-in module' }) });
  const fs = await diagnose(d);
  assert.equal(find(fs, 'node')[0]!.status, 'fail');
  assert.match(find(fs, 'node')[0]!.fix!, /nodejs\.org/);
  assert.equal(find(fs, 'sqlite')[0]!.status, 'fail');
  assert.equal(find(fs, 'home')[0]!.status, 'fail');
  assert.equal(find(fs, 'home')[0]!.fix, 'Run `garnet setup`.');
  assert.equal(find(fs, 'path')[0]!.status, 'warn');
  // Stops after home: nothing else can be checked.
  assert.equal(find(fs, 'config').length, 0);
});

test('a healthy setup: key from the env file, channels, service running', async () => {
  const d = deps();
  configure(d.home, (c) => {
    c.channels.telegram.enabled = true;
  });
  chmodSync(d.home, 0o700);
  writeFileSync(join(d.home, 'env'), `ANTHROPIC_API_KEY=${KEY}\n`, { mode: 0o600 });
  d.env.ANTHROPIC_API_KEY = KEY; // main() loads the env file before dispatch
  d.env.TELEGRAM_BOT_TOKEN = 'from-shell';
  const plan = planService({ platform: 'linux', home: d.home, userHome: d.userHome, nodePath: process.execPath, entry: d.entry });
  assert.ok(!('unsupported' in plan));
  mkdirSync(join(plan.path, '..'), { recursive: true });
  writeFileSync(plan.path, plan.contents);
  const fs = await diagnose(d);
  const bad = fs.filter((f) => f.status === 'fail' || f.status === 'warn');
  assert.deepEqual(bad.map((f) => f.area), ['path'], JSON.stringify(bad));
  assert.match(find(fs, 'model')[0]!.message, /key ANTHROPIC_API_KEY \(.*\/env\)/);
  assert.match(find(fs, 'channels')[0]!.message, /telegram · token TELEGRAM_BOT_TOKEN \(environment\)/);
  assert.equal(find(fs, 'service')[0]!.status, 'ok');
  assert.deepEqual(d.commands, [['systemctl', '--user', 'status', 'garnet.service', '--no-pager']]);
  assert.equal(d.sandboxChecks, 0, 'exec is denied by default, so docker is not probed');
  assert.equal(JSON.stringify(fs).includes(KEY), false);
});

test('a named instance (`service install --name`) is found by its GARNET_HOME; another home on the default name is not ours', async () => {
  const d = deps();
  configure(d.home);
  const unit = (name: string | undefined, home: string) => {
    const p = planService({ platform: 'linux', home, userHome: d.userHome, nodePath: process.execPath, entry: d.entry, name });
    assert.ok(!('unsupported' in p));
    mkdirSync(join(p.path, '..'), { recursive: true });
    writeFileSync(p.path, p.contents);
  };
  unit(undefined, '/somewhere/else');
  let fs = await diagnose(d);
  assert.equal(find(fs, 'service')[0]!.status, 'info');
  assert.match(find(fs, 'service')[0]!.message, /not installed for this GARNET_HOME \(1 other Garnet instance installed/);
  assert.match(find(fs, 'service')[0]!.fix!, /--name <name>/);
  unit('work', d.home);
  fs = await diagnose(d);
  assert.equal(find(fs, 'service')[0]!.status, 'ok');
  assert.match(find(fs, 'service')[0]!.message, /garnet-work\.service/);
  assert.deepEqual(d.commands.at(-1), ['systemctl', '--user', 'status', 'garnet-work.service', '--no-pager']);
  d.run = async () => ({ code: 3, stdout: '', stderr: 'inactive' });
  fs = await diagnose(d);
  assert.match(find(fs, 'service')[0]!.fix!, /journalctl --user -u garnet-work\.service -e.*garnet service restart --name work/);
});

test('problems: invalid config, missing key, open env file, locked store, stale service, sandbox down', async () => {
  const d = deps();
  mkdirSync(d.home, { recursive: true, mode: 0o755 });
  chmodSync(d.home, 0o755);
  writeFileSync(join(d.home, 'config.json'), '{"version":1,"model":{"provider":"nope"}}');
  let fs = await diagnose(d);
  assert.equal(find(fs, 'config')[0]!.status, 'fail');
  assert.match(find(fs, 'config')[0]!.message, /model\.provider/);
  assert.equal(find(fs, 'home')[0]!.status, 'warn');

  configure(d.home, (c) => {
    c.permissions.exec = 'ask';
  });
  writeFileSync(join(d.home, 'env'), 'X=1\n', { mode: 0o644 });
  chmodSync(join(d.home, 'env'), 0o644);
  openSecretStore(d.home, { [PASSPHRASE_ENV]: 'a long enough passphrase' }, { kdf: { N: 2 ** 10, r: 8, p: 1 } }).set('ANTHROPIC_API_KEY', KEY);
  const plan = planService({ platform: 'linux', home: d.home, userHome: d.userHome, nodePath: process.execPath, entry: d.entry });
  assert.ok(!('unsupported' in plan));
  mkdirSync(join(plan.path, '..'), { recursive: true });
  writeFileSync(plan.path, 'old unit');
  fs = await diagnose(d);
  assert.equal(find(fs, 'env')[0]!.status, 'fail');
  assert.equal(find(fs, 'secrets')[0]!.status, 'fail');
  assert.match(find(fs, 'secrets')[0]!.message, /locked|GARNET_SECRETS/);
  assert.equal(find(fs, 'model')[0]!.status, 'fail');
  assert.match(find(fs, 'model')[0]!.fix!, /Unlock the store/);
  assert.equal(find(fs, 'service')[0]!.status, 'warn');
  assert.match(find(fs, 'service')[0]!.message, /out of date/);
  assert.equal(find(fs, 'sandbox')[0]!.status, 'fail');
  assert.equal(d.sandboxChecks, 1);
});

test('openai-compatible: warns before an Anthropic key would be sent to another server; local needs no key', async () => {
  const d = deps({ env: { PATH: '', ANTHROPIC_API_KEY: KEY } });
  configure(d.home, (c) => {
    c.model = { ...c.model, provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1', name: 'm' };
  });
  let fs = await diagnose(d);
  assert.equal(find(fs, 'model')[0]!.status, 'warn');
  assert.match(find(fs, 'model')[0]!.message, /would send ANTHROPIC_API_KEY to llm\.example\.com/);
  configure(d.home, (c) => {
    c.model = { ...c.model, provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', name: 'm', apiKeyEnv: 'LOCAL_MODEL_API_KEY' };
  });
  fs = await diagnose(d);
  assert.equal(find(fs, 'model')[0]!.status, 'ok');
  assert.match(find(fs, 'model')[0]!.message, /no key/);
});

test('PATH: finds this install’s shim, and warns when another `garnet` shadows it', async () => {
  const d = deps();
  const other = tempDir();
  const ours = tempDir();
  writeFileSync(join(other, 'garnet'), '#!/bin/sh\necho garnet 3.3\n', { mode: 0o755 });
  writeFileSync(join(ours, 'garnet'), `#!/bin/sh\nexec node ${d.entry} "$@"\n`, { mode: 0o755 });
  d.env.PATH = `${ours}:${other}`;
  let f = find(await diagnose(d), 'path')[0]!;
  assert.equal(f.status, 'ok');
  d.env.PATH = `${other}:${ours}`;
  f = find(await diagnose(d), 'path')[0]!;
  assert.equal(f.status, 'warn');
  assert.match(f.message, /different program/);
  assert.equal(f.fix, `Put ${ours} earlier in PATH.`);
});

test('PATH: an install under another command name (install.sh --name) is checked by that name', async () => {
  const d = deps();
  const ours = tempDir();
  writeFileSync(join(ours, 'garnet-agent'), `#!/bin/sh\nexec node ${d.entry} "$@"\n`, { mode: 0o755 });
  d.env.PATH = ours;
  d.env.GARNET_COMMAND_NAME = 'garnet-agent';
  const f = find(await diagnose(d), 'path')[0]!;
  assert.equal(f.status, 'ok');
  assert.match(f.message, /`garnet-agent` on PATH is this install/);
});

test('formatting and exit code: symbols plus words, fixes indented, 1 when anything fails', async () => {
  const text = formatFindings(
    [
      { area: 'node', status: 'ok', message: 'Node.js 22.18.0' },
      { area: 'config', status: 'fail', message: 'broken', fix: 'Run `garnet setup`.' },
      { area: 'path', status: 'warn', message: 'shadowed' },
    ],
    makeStyle(false),
  );
  assert.match(text, /✓ node +Node\.js 22\.18\.0\n {2}✗ config +broken\n {6}→ Run `garnet setup`\.\n {2}! path +shadowed\n\n1 problem, 1 warning\.\n$/);
  let out = '';
  const io: Io = { out: (t) => (out += t), err: (t) => (out += t) };
  const d = deps();
  assert.equal(await doctor([], io, d), 1);
  assert.match(out, /DOCTOR/);
  out = '';
  assert.equal(await doctor(['--json'], io, d), 1);
  assert.ok(Array.isArray(JSON.parse(out)));
});

test('named providers: the active one is checked strictly, the others only inform', async () => {
  const d = deps({ env: { PATH: '', GEMINI_API_KEY: 'AIza-test' } });
  mkdirSync(d.home, { recursive: true, mode: 0o700 });
  configure(d.home, (c) => {
    c.providers = { work: { provider: 'gemini', name: 'gemini-2.5-pro', effort: 'high', fallbacks: true, maxOutputTokens: 32_000 } };
    c.activeProvider = 'work';
  });
  let models = find(await diagnose(d), 'model');
  const work = models.find((f) => /\[work, active\]/.test(f.message))!;
  assert.equal(work.status, 'ok');
  assert.match(work.message, /gemini · gemini-2\.5-pro · key GEMINI_API_KEY \(environment\)/);
  const other = models.find((f) => /\[default\]/.test(f.message))!;
  assert.equal(other.status, 'info', 'the unused default has no key, which is not a failure');

  configure(d.home, (c) => {
    c.providers = { work: { provider: 'gemini', name: 'gemini-2.5-pro', effort: 'high', fallbacks: true, maxOutputTokens: 32_000 } };
    c.activeProvider = 'work';
  });
  models = find(await diagnose({ ...d, env: { PATH: '' } }), 'model');
  const missing = models.find((f) => /\[work, active\]/.test(f.message))!;
  assert.equal(missing.status, 'fail');
  assert.match(missing.message, /GEMINI_API_KEY is not set/);
  assert.match(missing.fix ?? '', /GEMINI_API_KEY/);
});

test('a workspace containing home fails; an API bound beyond loopback is a warning', async () => {
  const d = deps();
  mkdirSync(d.home, { recursive: true, mode: 0o700 });
  configure(d.home, (c) => {
    c.model.provider = 'fake';
    c.workspace = '..';
    c.api.enabled = true;
    c.api.host = '0.0.0.0';
  });
  const fs = await diagnose(d);
  assert.match(find(fs, 'workspace')[0]!.message, /contains Garnet's home/);
  assert.equal(find(fs, 'workspace')[0]!.status, 'fail');
  assert.equal(find(fs, 'api')[0]!.status, 'warn');
  assert.match(find(fs, 'api')[0]!.message, /0\.0\.0\.0/);
});

test('deprecated RUBY_* variables, a legacy ~/.ruby home and a leftover ruby.service are reported', async () => {
  const userHome = tempDir();
  const home = join(userHome, '.ruby');
  const unitDir = join(userHome, '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(join(unitDir, 'ruby.service'), `[Unit]\nDescription=Ruby personal agent\n[Service]\nEnvironment="RUBY_HOME=${home}"\n`);
  const d = deps({ home, userHome });
  d.env.RUBY_NODE = '/usr/bin/node';
  const fs = await diagnose(d);
  assert.ok(find(fs, 'env').some((f) => f.status === 'warn' && f.message === 'RUBY_NODE is deprecated, rename to GARNET_NODE'));
  assert.ok(find(fs, 'home').some((f) => /legacy data directory/.test(f.message) && /mv .*\.ruby .*\.garnet/.test(f.fix ?? '')));
  assert.ok(find(fs, 'service').some((f) => f.status === 'warn' && /legacy service/.test(f.message)));
});

test('a GARNET_* variable nothing reads is flagged: settings live in config.json', async () => {
  const d = deps();
  d.env.GARNET_MODEL = 'claude-opus-4-1';
  d.env.GARNET_HOME = d.home;
  const fs = await diagnose(d);
  const hits = find(fs, 'env').filter((f) => f.status === 'warn' && /GARNET_MODEL/.test(f.message));
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.fix ?? '', /garnet config set/);
  assert.ok(!find(fs, 'env').some((f) => /GARNET_HOME/.test(f.message)));
});

test('media checks: transcription command on PATH, openai-compatible key, PDF text command', async () => {
  const d = deps();
  mkdirSync(d.home, { recursive: true, mode: 0o700 });
  const binDir = tempDir('bin-');
  d.env.PATH = binDir;

  configure(d.home, (c) => {
    c.model.provider = 'fake';
    c.media.transcription.backend = 'command';
    c.media.transcription.command = ['whisper-cli', '-m', '/models/ggml-base.bin'];
    c.media.pdfText.command = ['pdftotext', '-layout', '{input}', '-'];
  });

  // Without the commands on PATH, both should fail
  let fs = await diagnose(d);
  assert.match(find(fs, 'media')[0]!.message, /whisper-cli/);
  assert.equal(find(fs, 'media')[0]!.status, 'fail');
  assert.match(find(fs, 'media')[1]!.message, /pdftotext/);
  assert.equal(find(fs, 'media')[1]!.status, 'fail');

  // Create the commands
  writeFileSync(join(binDir, 'whisper-cli'), '#!/bin/sh\necho ok', { mode: 0o755 });
  writeFileSync(join(binDir, 'pdftotext'), '#!/bin/sh\necho ok', { mode: 0o755 });
  fs = await diagnose(d);
  assert.match(find(fs, 'media')[0]!.message, /whisper-cli/);
  assert.equal(find(fs, 'media')[0]!.status, 'ok');
  assert.match(find(fs, 'media')[1]!.message, /pdftotext/);
  assert.equal(find(fs, 'media')[1]!.status, 'ok');
});

test('media checks: openai-compatible transcription needs baseUrl and key', async () => {
  const d = deps();
  mkdirSync(d.home, { recursive: true, mode: 0o700 });
  configure(d.home, (c) => {
    c.model.provider = 'fake';
    c.media.transcription.backend = 'openai-compatible';
    c.media.transcription.baseUrl = 'http://127.0.0.1:8000/v1';
    c.media.transcription.apiKeyEnv = 'WHISPER_API_KEY';
  });

  // Without the key set
  let fs = await diagnose(d);
  const media = find(fs, 'media');
  assert.ok(media.some((f) => f.status === 'warn' && /WHISPER_API_KEY/.test(f.message)));

  // With the key in environment
  d.env.WHISPER_API_KEY = 'test-key';
  fs = await diagnose(d);
  const media2 = find(fs, 'media');
  assert.ok(media2.some((f) => f.status === 'ok' && /openai-compatible/.test(f.message)));
});

test('media disabled: no checks run', async () => {
  const d = deps();
  mkdirSync(d.home, { recursive: true, mode: 0o700 });
  configure(d.home, (c) => {
    c.model.provider = 'fake';
    c.media.enabled = false;
  });

  const fs = await diagnose(d);
  const media = find(fs, 'media');
  assert.equal(media.length, 1);
  assert.match(media[0]!.message, /off/);
  assert.equal(media[0]!.status, 'info');
});

test('media: an absolute or relative-with-slash command is access-checked directly, not joined with PATH', async () => {
  const d = deps();
  const bin = tempDir();
  const tool = join(bin, 'pdftotext');
  writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
  configure(d.home, (c) => {
    c.media.pdfText.command = [tool, '-layout'];
    c.media.transcription = { ...c.media.transcription, backend: 'command', command: [join(bin, 'missing')] };
  });
  const media = find(await diagnose(d), 'media');
  assert.ok(media.some((f) => f.status === 'ok' && f.message.includes('PDF text extraction')), 'absolute path found with an empty PATH');
  assert.ok(media.some((f) => f.status === 'fail' && /Transcription command .*missing is not an executable file/.test(f.message)));
});

const sshConfig = (c: GarnetConfig, ssh: Partial<GarnetConfig['sandbox']['ssh']> = {}) => {
  c.permissions.exec = 'ask';
  c.sandbox.backend = 'ssh';
  c.sandbox.ssh = { ...c.sandbox.ssh, host: 'build.example.com', user: 'garnet', workdir: '/srv/garnet', agent: true, ...ssh };
};

test('ssh sandbox: probed only when exec is allowed; the result and the fix are reported', async () => {
  const off = deps();
  configure(off.home, (c) => {
    sshConfig(c);
    c.permissions.exec = 'deny';
  });
  assert.equal(find(await diagnose(off), 'sandbox')[0]!.status, 'info');
  assert.equal(off.sandboxChecks, 0, 'exec denied: ssh is not probed');

  const seen: string[] = [];
  const d = deps({
    sandboxCheck: async (config) => {
      seen.push(config.sandbox.backend);
      return { ok: true, detail: 'ssh garnet@build.example.com:22, workdir /srv/garnet, host key checking strict.' };
    },
  });
  configure(d.home, (c) => sshConfig(c));
  const fs = await diagnose(d);
  assert.deepEqual(seen, ['ssh']);
  assert.equal(find(fs, 'sandbox').length, 1);
  assert.equal(find(fs, 'sandbox')[0]!.status, 'ok');
  assert.match(find(fs, 'sandbox')[0]!.message, /^SSH sandbox: ssh garnet@build/);

  const down = deps({ sandboxCheck: async () => ({ ok: false, detail: 'ssh to garnet@build.example.com:22 failed (exit 255: Host key verification failed.). Verify the key.' }) });
  configure(down.home, (c) => sshConfig(c));
  const f = find(await diagnose(down), 'sandbox')[0]!;
  assert.equal(f.status, 'fail');
  assert.match(f.message, /SSH sandbox: .*Host key verification failed/);
});

test('ssh sandbox: a missing passphrase secret fails without probing, a present one is looked up but never printed', async () => {
  const d = deps();
  configure(d.home, (c) => sshConfig(c, { agent: false, identityFile: '/k', passphraseEnv: 'GARNET_SSH_KEY_PASSPHRASE' }));
  let f = find(await diagnose(d), 'sandbox')[0]!;
  assert.equal(f.status, 'fail');
  assert.match(f.message, /GARNET_SSH_KEY_PASSPHRASE is not set/);
  assert.equal(d.sandboxChecks, 0);

  let resolved: string | undefined;
  const e = deps({
    env: { PATH: '', GARNET_SSH_KEY_PASSPHRASE: 'pw-NEVER-PRINT' },
    sandboxCheck: async (_c, _w, secret) => {
      resolved = secret('GARNET_SSH_KEY_PASSPHRASE');
      return { ok: true, detail: 'ssh ok' };
    },
  });
  configure(e.home, (c) => sshConfig(c, { agent: false, identityFile: '/k', passphraseEnv: 'GARNET_SSH_KEY_PASSPHRASE' }));
  const fs = await diagnose(e);
  assert.equal(resolved, 'pw-NEVER-PRINT');
  assert.equal(JSON.stringify(fs).includes('pw-NEVER-PRINT'), false);
  f = find(fs, 'sandbox')[0]!;
  assert.equal(f.status, 'ok');
});

test('ssh sandbox: unsafe host key checking is a warning, and a backend that throws is a failure', async () => {
  const d = deps({ sandboxCheck: async () => ({ ok: true, detail: 'ssh ok' }) });
  configure(d.home, (c) => sshConfig(c, { hostKeyChecking: 'off' }));
  const fs = find(await diagnose(d), 'sandbox');
  assert.deepEqual(fs.map((f) => f.status), ['warn', 'ok']);
  assert.match(fs[0]!.message, /impersonate/);
  assert.match(fs[0]!.fix!, /strict/);

  const boom = deps({
    sandboxCheck: async () => {
      throw new Error('boom');
    },
  });
  configure(boom.home, (c) => sshConfig(c));
  assert.match(find(await diagnose(boom), 'sandbox')[0]!.message, /boom/);
});
