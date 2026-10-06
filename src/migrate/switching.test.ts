// Import features for switchers: jobs, allowlists, OpenClaw 2026.9 state, custom workspaces,
// skill requirements and {baseDir}, edited bundled skills, memory caps and persona merging.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { configSchema, defaultConfig, type JobConfig } from '../config/index.ts';
import { MemoryStore } from '../memory/index.ts';
import { SkillStore } from '../skills/index.ts';
import { applyImport, defaultSourceDir, formatPlan, formatResult, importedArchiveSection, planImport, runImport, type ImportDeps } from './index.ts';
import { parseJson5 } from './json5.ts';

const put = (root: string, rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const noBins = { hasBin: () => false };

function ruby(opts: { caps?: { memory: number; user: number }; persona?: string } = {}) {
  const home = tempDir();
  let caps = opts.caps ?? { memory: 2200, user: 1400 };
  let memory = new MemoryStore({ root: join(home, 'memory'), limits: caps });
  const skills = new SkillStore({ root: join(home, 'skills') });
  const workspace = join(home, 'workspace');
  let persona = opts.persona;
  const jobs: JobConfig[] = [];
  const paired: { channel: string; senderId: string; displayName: string | null }[] = [];
  const deps: ImportDeps = {
    memory: {
      read: (ns, f) => memory.read(ns, f),
      write: (ns, f, c) => memory.write(ns, f, c),
      limit: (f) => memory.limit(f),
      setLimits: (c) => {
        caps = { memory: c.memory ?? caps.memory, user: c.user ?? caps.user };
        memory = new MemoryStore({ root: join(home, 'memory'), limits: caps });
      },
    },
    skills,
    workspace,
    setPersona: (p) => (persona = p),
    getPersona: () => persona,
    jobs: {
      ids: () => jobs.map((j) => j.id),
      add: (js) => {
        configSchema.parse({ ...defaultConfig(), jobs: [...jobs, ...js] });
        jobs.push(...js);
      },
    },
    pairings: {
      has: (c, s) => paired.some((p) => p.channel === c && p.senderId === s),
      add: (channel, senderId, displayName) => paired.push({ channel, senderId, displayName }),
    },
    planOptions: noBins,
  };
  return { home, skills, workspace, deps, jobs, paired, caps: () => caps, memory: () => memory, persona: () => persona };
}

// ---- Hermes ----

function hermesHome(extra: (root: string) => void = () => {}) {
  const root = tempDir();
  put(root, 'memories/MEMORY.md', 'Uses Podman');
  put(root, 'config.yaml', 'model: x\ntimezone: "Europe/Oslo"\ntelegram:\n  enabled: true\n');
  put(
    root,
    '.env',
    'OPENROUTER_API_KEY=sk-or-SECRETVALUE\nTELEGRAM_BOT_TOKEN=123:SECRETTOKEN\nTELEGRAM_ALLOWED_USERS=111222333, 444555666,@someone\nTELEGRAM_HOME_CHANNEL=999888777\nWHATSAPP_ALLOWED_USERS=+15551234567\n',
  );
  const job = (o: object) => ({ enabled: true, state: 'scheduled', skills: [], deliver: 'local', ...o });
  put(
    root,
    'cron/jobs.json',
    JSON.stringify({
      jobs: [
        job({ id: 'a1', name: 'Morning brief', prompt: 'Summarize my calendar.', schedule: { kind: 'cron', expr: '0 7 * * 1-5', display: '0 7 * * 1-5' }, deliver: 'origin', origin: { platform: 'telegram', chat_id: '111222333' }, model: 'gpt-5' }),
        job({ id: 'a2', name: 'Inbox digest', prompt: 'Digest the inbox.', skills: ['Email Triage'], schedule: { kind: 'interval', minutes: 30 }, deliver: 'telegram', enabled: false, state: 'paused' }),
        job({ id: 'a3', name: 'Remind me', prompt: 'Call mum', schedule: { kind: 'once', run_at: '2026-10-07T17:00:00+02:00' } }),
        job({ id: 'a4', name: 'Disk script', script: 'df.sh', no_agent: true, schedule: { kind: 'interval', minutes: 60 } }),
        job({ id: 'a5', name: 'Fast poll', prompt: 'Poll', schedule: { kind: 'interval', minutes: 1 } }),
        job({ id: 'a6', name: 'Seconds', prompt: 'Tick', schedule: { kind: 'cron', expr: '*/5 * * * * 0' }, deliver: 'discord:123456789012345678' }),
        job({ id: 'a7', name: 'Bad cron', prompt: 'x', schedule: { kind: 'cron', expr: 'every tuesday' } }),
        job({ id: 'a8', name: 'Slack only', prompt: 'x', schedule: { kind: 'cron', expr: '0 9 * * *' }, deliver: 'slack:C123' }),
      ],
    }),
  );
  extra(root);
  return root;
}

test('hermes cron/jobs.json becomes disabled Ruby jobs; what cannot map is skipped with a reason', () => {
  const plan = planImport('hermes', hermesHome(), noBins);
  const by = (from: string) => plan.jobs.find((j) => j.from === from)!;
  const brief = by('Morning brief').job!;
  assert.equal(brief.enabled, false);
  assert.equal(brief.kind, 'cron');
  assert.equal(brief.cron, '0 7 * * 1-5');
  assert.equal(brief.timezone, 'Europe/Oslo');
  assert.deepEqual(brief.notify, { channel: 'telegram', chatId: '111222333', account: 'default' });
  assert.equal(brief.notifyWhen, 'always');
  assert.match(by('Morning brief').notes.join(), /per-job model "gpt-5"/);
  const digest = by('Inbox digest').job!;
  assert.equal(digest.kind, 'heartbeat');
  assert.equal(digest.everyMinutes, 30);
  assert.match(digest.instructions, /^Use the skill email-triage \(call skill_view first\)\.\n\nDigest the inbox\.$/);
  assert.deepEqual(digest.notify, { channel: 'telegram', chatId: '999888777', account: 'default' }); // bare "telegram" = home channel
  assert.match(by('Inbox digest').notes.join(), /was paused/);
  assert.equal(by('Remind me').job, null);
  assert.match(by('Remind me').notes[0]!, /one-shot/);
  assert.match(by('Disk script').notes[0]!, /script-only/);
  assert.match(by('Fast poll').notes[0]!, /shortest interval is 5 min/);
  const sec = by('Seconds').job!;
  assert.equal(sec.cron, '*/5 * * * *');
  assert.deepEqual(sec.notify, { channel: 'discord', chatId: '123456789012345678', account: 'default' });
  assert.equal(by('Bad cron').job, null);
  assert.equal(by('Slack only').job!.notify, undefined);
  assert.match(by('Slack only').notes.join(), /no Ruby equivalent/);
  for (const j of plan.jobs) if (j.job) configSchema.parse({ ...defaultConfig(), jobs: [j.job] });
  assert.ok(plan.copies.some((c) => c.src === 'cron/jobs.json'));
  const text = formatPlan(plan);
  assert.match(text, /added DISABLED/);
  assert.match(text, /SKIP "Remind me"/);
});

test('hermes jobs apply disabled and idempotently', async () => {
  const root = hermesHome();
  const r = ruby();
  const plan = planImport('hermes', root, noBins);
  const res = applyImport(plan, r.deps);
  assert.deepEqual(
    r.jobs.map((j) => [j.id, j.enabled]),
    [
      ['hermes-morning-brief', false],
      ['hermes-inbox-digest', false],
      ['hermes-seconds', false],
      ['hermes-slack-only', false],
    ],
  );
  assert.ok(res.jobs.some((j) => j.status === 'skipped' && j.id === 'Remind me'));
  const again = applyImport(planImport('hermes', root, noBins), r.deps);
  assert.equal(r.jobs.length, 4);
  assert.ok(again.jobs.filter((j) => j.status !== 'skipped').every((j) => j.status === 'exists'));
  assert.match(formatResult(res), /added \(disabled\)/);
  // --no-jobs leaves them out
  const r2 = ruby();
  const io = { out() {}, err() {} };
  assert.equal(await runImport(['hermes', '--from', root, '--apply', '--no-jobs'], io, r2.deps), 0);
  assert.equal(r2.jobs.length, 0);
});

test('hermes allowlists and pairing store become pairings only on request; secret values never enter the plan', () => {
  const root = hermesHome((h) => {
    put(h, 'platforms/pairing/telegram-approved.json', JSON.stringify({ '777888999': { user_name: 'Sam', approved_at: 1 }, x: { salt: 's', hash: 'h' } }));
    put(h, 'platforms/pairing/discord-approved.json', JSON.stringify({ '123456789012345678': { user_name: 'Kim' } }));
  });
  const plan = planImport('hermes', root, noBins);
  assert.deepEqual(
    plan.pairings.map((p) => `${p.channel}:${p.senderId}:${p.displayName ?? ''}`).sort(),
    ['discord:123456789012345678:Kim', 'telegram:111222333:', 'telegram:444555666:', 'telegram:777888999:Sam'],
  );
  assert.ok(plan.notImported.some((n) => /@someone/.test(n.what)));
  assert.ok(plan.notImported.some((n) => /whatsapp/.test(n.what)));
  assert.ok(!plan.envVars.includes('TELEGRAM_ALLOWED_USERS') && plan.envVars.includes('TELEGRAM_BOT_TOKEN'));
  const json = JSON.stringify(plan) + formatPlan(plan);
  assert.ok(!json.includes('SECRETVALUE') && !json.includes('SECRETTOKEN'));

  const r = ruby();
  const res = applyImport(plan, r.deps);
  assert.equal(r.paired.length, 0);
  assert.ok(res.pairings.every((p) => p.status === 'not-requested'));
  assert.match(formatResult(res), /not paired \(re-run with --pairings/);
  applyImport(plan, r.deps, { pairings: true });
  assert.equal(r.paired.length, 4);
  const again = applyImport(plan, r.deps, { pairings: true });
  assert.ok(again.pairings.every((p) => p.status === 'exists'));
});

test('hermes profiles warn; HERMES_HOME and OpenClaw env vars pick the default source', () => {
  const root = hermesHome((h) => mkdirSync(join(h, 'profiles/work'), { recursive: true }));
  const plan = planImport('hermes', root, noBins);
  assert.ok(plan.warnings.some((w) => w.includes('profile "work"') && w.includes(join(root, 'profiles', 'work'))));
  assert.equal(defaultSourceDir('hermes', '/h', { HERMES_HOME: '/srv/hermes' }), '/srv/hermes');
  assert.equal(defaultSourceDir('hermes', '/h', {}), '/h/.hermes');
  assert.equal(defaultSourceDir('openclaw', '/h', { OPENCLAW_PROFILE: 'work' }), '/h/.openclaw-work');
  assert.equal(defaultSourceDir('openclaw', '/h', { OPENCLAW_PROFILE: 'default' }), '/h/.openclaw');
  assert.equal(defaultSourceDir('openclaw', '/h', { OPENCLAW_STATE_DIR: '/state' }), '/state');
});

test('hermes bundled skills: unchanged ones are skipped by hash, edited ones are imported', () => {
  const pristine = '---\nname: weather\ndescription: Weather\n---\nCheck it.\n';
  const md5 = (parts: [string, string][]) => {
    const h = createHash('md5');
    for (const [p, c] of parts) h.update(p).update(c);
    return h.digest('hex');
  };
  const root = hermesHome((h) => {
    put(h, 'skills/misc/weather/SKILL.md', pristine);
    put(h, 'skills/misc/notes/SKILL.md', '---\nname: notes\ndescription: Notes, edited\n---\nMine now.\n');
    put(h, 'skills/misc/notes/a/ref.md', 'r');
    put(h, 'skills/misc/old/SKILL.md', '---\nname: old\ndescription: Old\n---\nx\n');
    put(
      h,
      'skills/.bundled_manifest',
      `weather:${md5([['SKILL.md', pristine]])}\nnotes:${md5([['SKILL.md', 'original'], ['a/ref.md', 'r']])}\nold\n`,
    );
  });
  const plan = planImport('hermes', root, noBins);
  assert.deepEqual(plan.skills.map((s) => s.name), ['notes']);
  assert.equal(plan.skills[0]!.editedBundled, true);
  assert.ok(plan.notImported.some((n) => /1 unchanged skills .* skipped; 1 you edited are imported; 1 have no recorded hash/.test(n.why)));
});

// ---- skills ----

test('skills keep requirements, flag what is missing and point {baseDir} at the archived copy', () => {
  const root = tempDir();
  put(
    root,
    'workspace/skills/gh/SKILL.md',
    '---\nname: github\ndescription: "GitHub CLI"\nmetadata:\n  {\n    "openclaw":\n      {\n        "emoji": "x",\n        "requires": { "bins": ["gh"], "env": ["GH_TOKEN"] },\n      },\n  }\n---\nRun `{baseDir}/scripts/pr.sh` then use web_search.\n',
  );
  put(root, 'workspace/skills/gh/scripts/pr.sh', 'gh pr list\n');
  put(root, 'workspace/skills/plain/SKILL.md', '---\nname: plain\ndescription: Plain\n---\nJust think.\n');
  const plan = planImport('openclaw', root, { hasBin: (b) => b === 'node', hasSecret: () => false, tools: ['read_file'] });
  const gh = plan.skills.find((s) => s.name === 'github')!;
  assert.deepEqual(gh.requires.bins, ['gh']);
  assert.deepEqual(gh.requires.env, ['GH_TOKEN']);
  assert.deepEqual(gh.requires.tools, ['web_search']);
  assert.equal(gh.baseDirRewrite, 'imported/openclaw/workspace/skills/gh');
  assert.match(gh.body, /`imported\/openclaw\/workspace\/skills\/gh\/scripts\/pr\.sh`/);
  assert.ok(gh.missing.some((m) => /gh \(not on PATH\)/.test(m)));
  assert.ok(gh.missing.some((m) => /run_command/.test(m)));
  assert.ok(gh.missing.some((m) => /GH_TOKEN/.test(m)));
  assert.ok(gh.missing.some((m) => /web_search \(no such Ruby tool\)/.test(m)));
  assert.deepEqual(plan.skills.find((s) => s.name === 'plain')!.missing, []);
  assert.match(formatPlan(plan), /needs: gh \(not on PATH\)/);

  const r = ruby();
  applyImport(plan, r.deps);
  const file = readFileSync(join(r.home, 'skills/github/SKILL.md'), 'utf8');
  assert.match(file, /^metadata: \{"openclaw":\{"emoji":"x","requires":\{"bins":\["gh"\],"env":\["GH_TOKEN"\]\}\}\}$/m);
  assert.match(file, /^requires: \{"bins":\["gh"\],"env":\["GH_TOKEN"\],"tools":\["web_search"\]\}$/m);
  assert.equal(r.skills.read('github').description, 'GitHub CLI');
  assert.ok(existsSync(join(r.workspace, 'imported/openclaw/workspace/skills/gh/scripts/pr.sh')));
  assert.ok(r.skills.problems().length === 0);
});

test('hermes prerequisites are read from YAML', () => {
  const root = hermesHome((h) => {
    put(h, 'skills/p/notion/SKILL.md', '---\nname: notion\ndescription: Notion\nprerequisites:\n  env_vars: [NOTION_API_KEY]\n  commands:\n    - curl\nplatforms: [linux, macos]\n---\nUse `terminal` with curl and SKILL_DIR/x.\n');
    put(h, 'skills/p/notion/x', 'y');
  });
  const s = planImport('hermes', root, noBins).skills.find((x) => x.name === 'notion')!;
  assert.deepEqual(s.requires.bins, ['curl']);
  assert.deepEqual(s.requires.env, ['NOTION_API_KEY']);
  assert.deepEqual(s.requires.os, ['linux', 'macos']);
  assert.match(s.body, /imported\/hermes\/skills\/p\/notion\/x/);
});

// ---- OpenClaw 2026.9 ----

const STATE_SCHEMA = `
CREATE TABLE cron_jobs (store_key TEXT NOT NULL, job_id TEXT NOT NULL, declaration_key TEXT, owner_agent_id TEXT, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL, agent_id TEXT, payload_kind TEXT NOT NULL, job_json TEXT NOT NULL, grant_definition_revision TEXT, grant_definition_generation INTEGER, grant_definition_updated_at INTEGER, state_json TEXT NOT NULL DEFAULT '{}', runtime_updated_at_ms INTEGER, schedule_identity TEXT, sort_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (store_key, job_id)) STRICT;
CREATE TABLE cron_job_scratch (store_key TEXT NOT NULL, job_id TEXT NOT NULL, content TEXT, revision INTEGER NOT NULL, source_sha256 TEXT, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (store_key, job_id)) STRICT;
CREATE TABLE channel_pairing_allow_entries (channel_key TEXT NOT NULL, account_id TEXT NOT NULL, entry TEXT NOT NULL, sort_order INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (channel_key, account_id, entry)) STRICT;
`;

function openclawHome(): string {
  const root = tempDir();
  put(root, 'workspace/SOUL.md', 'Be warm.\n');
  put(root, 'workspace/IDENTITY.md', '# IDENTITY.md - Who Am I?\n\n- **Name:** Molty\n- **Creature:**\n  _(AI? robot?)_\n');
  put(
    root,
    'openclaw.json',
    `// my config
{
  agents: { defaults: { heartbeat: { every: '30m' } } },
  accessGroups: { ops: { type: 'message.senders', members: { telegram: ['555666777'], discord: ['discord:123456789012345678'] } } },
  channels: {
    telegram: { botToken: '\${TELEGRAM_BOT_TOKEN}', dmPolicy: 'allowlist', allowFrom: ['111222333', 'accessGroup:ops', '@handle', '*',], },
    discord: { allowFrom: ['<@234567890123456789>'] },
    whatsapp: { allowFrom: ['+15551234567'] },
  },
  commands: { ownerAllowFrom: ['telegram:111222333'] },
}
`,
  );
  mkdirSync(join(root, 'state'), { recursive: true });
  const db = new DatabaseSync(join(root, 'state/openclaw.sqlite'));
  db.exec(STATE_SCHEMA);
  const add = db.prepare('INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
  const rows: [string, string, number, string, object][] = [
    ['hb', 'Heartbeat (main)', 1, 'heartbeat', { schedule: { kind: 'every', everyMs: 1_800_000 }, payload: { kind: 'heartbeat' } }],
    ['mb', 'Morning brief', 1, 'agentTurn', { schedule: { kind: 'cron', expr: '0 0 7 * * *', tz: 'Europe/Berlin' }, payload: { kind: 'agentTurn', message: 'Brief me.', model: 'openai/gpt-5' }, delivery: { mode: 'announce', channel: 'telegram', to: '111222333' } }],
    ['rm', 'Reminder', 1, 'systemEvent', { schedule: { kind: 'at', at: '2026-10-07T09:00:00Z' }, payload: { kind: 'systemEvent', text: 'Stretch' } }],
    ['cmd', 'Backup', 0, 'command', { schedule: { kind: 'cron', expr: '0 3 * * *' }, payload: { kind: 'command', argv: ['backup.sh'] } }],
    ['st', 'Watch logs', 1, 'agentTurn', { schedule: { kind: 'stream', command: ['tail', '-f', 'x'] }, payload: { kind: 'agentTurn', message: 'Look' } }],
  ];
  rows.forEach(([id, name, enabled, kind, job], i) => add.run('default', id, name, enabled, kind, JSON.stringify({ id, name, ...job }), i));
  db.prepare('INSERT INTO cron_job_scratch VALUES (?, ?, ?, 1, NULL, 0)').run('default', 'hb', '# Checklist\n- scan inbox\n- reply HEARTBEAT_OK if quiet');
  db.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?, 0, 0)').run('telegram', 'default', '888999000');
  db.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?, 1, 0)').run('signal', 'default', '+4912345678');
  db.close();
  return root;
}

test('openclaw state database: automations, heartbeat checklist and approved senders', () => {
  const root = openclawHome();
  const plan = planImport('openclaw', root, noBins);
  const by = (from: string) => plan.jobs.find((j) => j.from === from)!;
  const hb = by('Heartbeat (main)').job!;
  assert.equal(hb.id, 'openclaw-heartbeat-main');
  assert.equal(hb.kind, 'heartbeat');
  assert.equal(hb.everyMinutes, 30);
  assert.equal(hb.notifyWhen, 'on_change');
  assert.match(hb.instructions, /- scan inbox\n- reply NOTHING_TO_REPORT if quiet/);
  assert.deepEqual(hb.notify, { channel: 'telegram', chatId: '111222333', account: 'default' }); // ownerAllowFrom
  const mb = by('Morning brief').job!;
  assert.equal(mb.cron, '0 7 * * *');
  assert.equal(mb.timezone, 'Europe/Berlin');
  assert.equal(mb.enabled, false);
  assert.match(by('Morning brief').notes.join(), /seconds field/);
  assert.equal(by('Reminder').job, null);
  assert.match(by('Backup').notes[0]!, /command payload/);
  assert.match(by('Watch logs').notes[0]!, /stream schedule/);
  assert.equal(plan.name, 'Molty');
  assert.match(plan.persona!.text, /Your name is Molty\./);
  const ids = plan.pairings.map((p) => `${p.channel}:${p.senderId}`);
  // The access group is only referenced from Telegram, so only its Telegram members count.
  assert.deepEqual(ids.sort(), ['discord:234567890123456789', 'signal:+4912345678', 'telegram:111222333', 'telegram:555666777', 'telegram:888999000']);
  assert.ok(plan.notImported.some((n) => n.what.includes('@handle')));
  assert.ok(plan.notImported.some((n) => n.what.startsWith('wildcard telegram')));
  assert.ok(plan.notImported.some((n) => n.what.includes('whatsapp')));
  assert.ok(plan.envVars.includes('TELEGRAM_BOT_TOKEN'));
  assert.deepEqual(plan.channels.sort(), ['discord', 'telegram', 'whatsapp']);
});

test('an unknown OpenClaw state schema is detected and reported, not guessed at', () => {
  const root = tempDir();
  put(root, 'workspace/SOUL.md', 'x');
  mkdirSync(join(root, 'state'));
  const db = new DatabaseSync(join(root, 'state/openclaw.sqlite'));
  db.exec('CREATE TABLE cron_jobs (id TEXT, data TEXT)');
  db.close();
  const plan = planImport('openclaw', root, noBins);
  assert.equal(plan.jobs.length, 0);
  assert.ok(plan.warnings.some((w) => /cron_jobs has an unknown layout/.test(w) && /openclaw cron list --all/.test(w)));
  assert.ok(plan.warnings.some((w) => /no channel_pairing_allow_entries table/.test(w)));
});

test('a custom OpenClaw workspace (agents.defaults.workspace) is read and archived', () => {
  const root = tempDir();
  const ws = tempDir();
  put(root, 'openclaw.json', JSON.stringify({ agents: { defaults: { workspace: ws } } }));
  put(ws, 'SOUL.md', 'Custom soul.');
  put(ws, 'MEMORY.md', '- Lives on a boat');
  put(ws, 'memory/2026-01-01.md', 'note');
  put(ws, 'skills/s/SKILL.md', '---\nname: s\ndescription: S\n---\nUse {baseDir}/run.sh\n');
  put(ws, 'skills/s/run.sh', 'echo');
  const plan = planImport('openclaw', root, noBins);
  assert.ok(plan.warnings.some((w) => w.includes('agents.defaults.workspace')));
  assert.match(plan.persona!.text, /Custom soul/);
  assert.equal(plan.skills[0]!.baseDirRewrite, 'imported/openclaw/workspace/skills/s');
  const r = ruby();
  applyImport(plan, r.deps);
  assert.equal(r.memory().read('default', 'memory'), '- Lives on a boat');
  for (const f of ['SOUL.md', 'memory/2026-01-01.md', 'skills/s/run.sh']) assert.ok(existsSync(join(r.workspace, 'imported/openclaw/workspace', f)), f);
  // a configured path that does not exist is a warning, not an error
  const root2 = tempDir();
  put(root2, 'openclaw.json', '{ agents: { defaults: { workspace: "/nonexistent/ws" } } }');
  assert.ok(planImport('openclaw', root2, noBins).warnings.some((w) => /was not found/.test(w)));
  // nor is a workspace that is the whole home directory
  const root3 = tempDir();
  put(root3, 'openclaw.json', '{ agents: { defaults: { workspace: "~" } } }');
  assert.ok(planImport('openclaw', root3, noBins).warnings.some((w) => /whole home or filesystem/.test(w)));
});

// ---- memory caps ----

test('memory caps can be raised so the whole import fits (never above 20,000)', () => {
  const entries = Array.from({ length: 80 }, (_, i) => `Fact ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
  const root = hermesHome((h) => put(h, 'memories/MEMORY.md', entries.join('\n§\n')));
  const plan = planImport('hermes', root, noBins);
  const m = plan.memory.find((x) => x.file === 'memory')!;
  assert.ok(m.fitCount < 80 && m.needed > 2200);
  assert.match(formatPlan(plan), /--raise-caps/);
  const r = ruby();
  const res = applyImport(plan, r.deps, { raiseCaps: true });
  const mr = res.memory.find((x) => x.file === 'memory')!;
  assert.equal(mr.added, 80);
  assert.equal(mr.raisedFrom, 2200);
  assert.ok(r.caps().memory >= m.needed && r.caps().memory % 100 === 0);
  assert.equal(r.caps().user, 1400); // untouched when it fits
  assert.match(formatResult(res), /cap raised from 2200/);
  // Without the option nothing changes.
  const r2 = ruby();
  assert.ok(applyImport(plan, r2.deps).memory.every((x) => x.raisedFrom === undefined));
  assert.equal(r2.caps().memory, 2200);
});

// ---- persona ----

const SETUP = '<!-- ruby setup -->\nYour name is Nova.\nThe person you work for is Sam. Address them as Sam.\n<!-- /ruby setup -->';

test('persona: merged into a setup-only persona (setup name wins), idempotent; own text needs a choice', () => {
  const root = openclawHome();
  const plan = planImport('openclaw', root, noBins);
  const r = ruby({ persona: SETUP });
  const res = applyImport(plan, r.deps);
  assert.equal(res.persona, 'merged');
  assert.ok(r.persona()!.startsWith(SETUP));
  assert.match(r.persona()!, /Be warm\./);
  assert.ok(!r.persona()!.includes('Your name is Molty'));
  assert.match(res.personaNote!, /kept the name "Nova".*"Molty"/);
  assert.equal(applyImport(plan, r.deps).persona, 'unchanged');
  assert.equal((r.persona()!.match(/Be warm/g) ?? []).length, 1);

  const own = `${SETUP}\n\nAlways answer in French.`;
  const k = ruby({ persona: own });
  const kept = applyImport(plan, k.deps);
  assert.equal(kept.persona, 'kept-existing');
  assert.match(kept.personaNote!, /--persona merge/);
  const m = ruby({ persona: own });
  assert.equal(applyImport(plan, m.deps, { persona: 'merge' }).persona, 'merged');
  assert.match(m.persona()!, /French\.\n\nImported from openclaw/);
  const rp = ruby({ persona: own });
  assert.equal(applyImport(plan, rp.deps, { persona: 'replace' }).persona, 'replaced');
  assert.ok(!rp.persona()!.includes('French') && rp.persona()!.startsWith(SETUP));
  const none = ruby();
  assert.equal(applyImport(plan, none.deps).persona, 'set');
  assert.match(none.persona()!, /Your name is Molty\./);
});

test('persona merge truncates to the 4,000-char limit with a note', () => {
  const root = hermesHome((h) => put(h, 'SOUL.md', 's'.repeat(3500)));
  const plan = planImport('hermes', root, noBins);
  const r = ruby({ persona: `${SETUP}\n\n${'o'.repeat(1500)}` });
  const res = applyImport(plan, r.deps, { persona: 'merge' });
  assert.equal(res.persona, 'merged');
  assert.ok(r.persona()!.length <= 4000);
  assert.match(r.persona()!, /truncated to fit/);
  assert.match(res.personaNote!, /truncated/);
});

test('runImport asks through deps.ask when flags are absent; flags win', async () => {
  const entries = Array.from({ length: 80 }, (_, i) => `Fact ${i} ${'y'.repeat(40)}`);
  const root = hermesHome((h) => {
    put(h, 'memories/MEMORY.md', entries.join('\n§\n'));
    put(h, 'SOUL.md', 'Imported soul.');
  });
  const asked: string[] = [];
  const r = ruby({ persona: `${SETUP}\n\nMine.` });
  r.deps.ask = {
    confirm: async (q) => (asked.push(q.id), true),
    select: async <T extends string>(q: { id: string; choices: { value: T }[] }) => (asked.push(q.id), 'merge' as T),
  };
  const io = { o: '', out(t: string) { this.o += t; }, err(t: string) { this.o += t; } };
  assert.equal(await runImport(['hermes', '--from', root], io, r.deps), 0);
  assert.match(io.o, /add --raise-caps to make room for all of it, --pairings to pair the allowlisted senders, --persona merge\|replace/);
  assert.deepEqual(asked, []);
  assert.equal(await runImport(['hermes', '--from', root, '--apply'], io, r.deps), 0);
  assert.deepEqual(asked, ['import-raise-caps', 'import-pairings', 'import-persona']);
  assert.match(r.persona()!, /Mine\.\n\nImported from hermes/);
  assert.equal(r.paired.length, 2);

  const r2 = ruby();
  r2.deps.ask = r.deps.ask;
  asked.length = 0;
  assert.equal(await runImport(['hermes', '--from', root, '--apply', '--no-raise-caps', '--no-pairings'], io, r2.deps), 0);
  assert.deepEqual(asked, []);
  assert.equal(r2.caps().memory, 2200);
  assert.equal(await runImport(['hermes', '--persona', 'sideways'], io, r2.deps), 2);
});

// ---- small pieces ----

test('json5 reader: comments, trailing commas, unquoted keys, single quotes', () => {
  assert.deepEqual(parseJson5(`// c\n{ a: 1, 'b': 'it\\'s', c: [1, 2,], /* x */ d: { e: true, }, f: "q\\"", g: 0x10, h: -2.5, }`), {
    a: 1,
    b: "it's",
    c: [1, 2],
    d: { e: true },
    f: 'q"',
    g: 16,
    h: -2.5,
  });
  assert.throws(() => parseJson5('{ a: '));
  assert.deepEqual(parseJson5('{"url": "http://x//y"}'), { url: 'http://x//y' });
});

test('the archive section tells the agent where imported files are, only when there are some', () => {
  const ws = tempDir();
  assert.equal(importedArchiveSection(ws), '');
  mkdirSync(join(ws, 'imported/hermes'), { recursive: true });
  const s = importedArchiveSection(ws);
  assert.match(s, /^# Imported archives/);
  assert.match(s, /Hermes Agent/);
  assert.match(s, /imported\/hermes\//);
  assert.equal(s, importedArchiveSection(ws)); // deterministic
});
