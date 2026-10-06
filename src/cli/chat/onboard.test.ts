// End to end: `garnet chat --onboard` with the offline fake model. Real tools
// (set_profile, memory), real config and memory files, no network.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { defaultConfig, loadConfig, readPersona, writeConfig } from '../../config/index.ts';
import { createGarnet } from '../../main.ts';
import { FakeModel, onboardingScript, type OnboardingMode } from '../../models/index.ts';
import { BOOTSTRAP_VERSION, ONBOARDING_TITLE, bootstrapPrompt } from '../../onboarding/index.ts';
import type { ApprovalRequest } from '../../policy/index.ts';
import { chat } from './index.ts';

type Run = { code: number; out: string; err: string; model: FakeModel; home: string };

/** Runs the plain onboarding chat with the given lines of input. */
async function wake(lines: string[], mode: OnboardingMode = 'ok', home = tempDir()): Promise<Run> {
  const stdin = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  const model = new FakeModel(onboardingScript(mode));
  const done = chat(['--onboard'], { out: (t) => out.push(t), err: (t) => err.push(t), stdin, stdout: null, env: {} }, { createGarnet: (o) => createGarnet({ ...o, home, env: {}, model }) });
  stdin.end(lines.join('\n') + '\n');
  return { code: await done, out: out.join(''), err: err.join(''), model, home };
}

const ANSWERS = ['Ruby', 'call me Sam', 'Short answers, and please no em-dashes', 'Europe/Lisbon', 'planning my week and reading papers'];

test('wake-up: the agent speaks first, asks the questions, and saves through real tools', async () => {
  const r = await wake([...ANSWERS, '/exit']);
  assert.equal(r.code, 0);
  // It opened the conversation and asked each question in turn.
  assert.match(r.out, /I have just woken up/);
  assert.match(r.out, /what should I call you\?/i);
  assert.match(r.out, /How do you like your answers/);
  assert.match(r.out, /All saved/);
  // The transcript shows the real calls and the check that came out of them.
  assert.match(r.err, /\[tool\] set_profile/);
  assert.match(r.err, /\[tool\] memory/);
  assert.match(r.err, /Tool check passed: the model used real tools \(set_profile, memory\)/);
  assert.doesNotMatch(r.err, /Setup chat is stopping/);

  // Persona goes through the same markers `garnet setup` writes.
  const config = loadConfig(r.home).config;
  assert.deepEqual(readPersona(config.persona), { name: 'Ruby', owner: 'Sam', notes: 'Short answers, and please no em-dashes' });
  assert.match(config.persona ?? '', /<!-- garnet setup -->[\s\S]*Your name is Ruby\.[\s\S]*<!-- \/garnet setup -->/);
  assert.equal(config.timezone, 'Europe/Lisbon');
  // Durable facts went to USER.md through the memory store (versioned like any other write).
  const user = readFileSync(join(r.home, 'memory', 'default', 'USER.md'), 'utf8');
  assert.match(user, /^- Wants help with: planning my week and reading papers$/m);
});

test('wake-up: only the onboarding session gets the bootstrap prompt and it is versioned', async () => {
  const r = await wake([...ANSWERS, '/exit']);
  const system = r.model.requests[0]!.system;
  assert.ok(system.includes(`# First-run onboarding (bootstrap v${BOOTSTRAP_VERSION})`));
  assert.ok(r.model.requests[0]!.tools?.some((t) => t.name === 'set_profile'));
  // set_profile belongs to the onboarding process (which has one session, since /new and /resume are refused in
  // it), never to a process that is not onboarding. The bootstrap prompt is in no other session either way.
  for (const onboarding of [true, false]) {
    const g = createGarnet({ home: tempDir(), env: {}, memoryDb: true, model: new FakeModel(), ...(onboarding ? { onboarding } : {}) });
    try {
      const s = g.store.createSession('Terminal chat');
      await g.agent.run(s.id, 'hello', { source: 'cli' });
      const m = g.model as FakeModel;
      assert.equal(m.requests[0]!.system.includes('First-run onboarding'), false);
      assert.equal(m.requests[0]!.tools?.some((t) => t.name === 'set_profile') ?? false, onboarding);
    } finally {
      g.close();
    }
  }
  // A session titled like the onboarding one gets it only when the process was started for onboarding.
  const g = createGarnet({ home: tempDir(), env: {}, memoryDb: true, model: new FakeModel(), onboarding: true });
  try {
    const s = g.store.createSession(ONBOARDING_TITLE);
    await g.agent.run(s.id, 'hi', { source: 'cli' });
    assert.ok((g.model as FakeModel).requests[0]!.system.includes(bootstrapPrompt()));
  } finally {
    g.close();
  }
});

test('wake-up: the instructions avoid em-dashes, and ask for the same questions as the form', () => {
  const text = bootstrapPrompt();
  assert.equal(/[—–]/.test(text), false);
  for (const topic of [/like to call you/, /call them/, /how they like answers/, /time zone/, /help with/]) assert.match(text, topic);
  assert.match(text, /set_profile/);
  assert.match(text, /memory tool/);
});

test('wake-up: when saving keeps failing it falls back to the form, and nothing the owner said is lost', async () => {
  // Five answers, one more try (the second failed turn), then the three form questions.
  const r = await wake([...ANSWERS, 'please try again', 'Opal', 'Alex', 'Be brief', '', '/exit'], 'broken-tools');
  assert.equal(r.code, 0);
  assert.match(r.err, /\[tool \w+\] /, 'the failed calls are visible');
  assert.match(r.err, /Setup chat is stopping because saving kept failing/);
  assert.match(r.err, /What should your assistant be called\?/);
  assert.doesNotMatch(r.err, /Tool check passed/);
  // The form saved through the same code path.
  assert.deepEqual(readPersona(loadConfig(r.home).config.persona), { name: 'Opal', owner: 'Alex', notes: 'Be brief' });
  assert.match(r.err, /Saved: Opal, working for Alex/);
  // The conversation stays in the session log.
  const g = createGarnet({ home: r.home, env: {}, noModel: true });
  try {
    const session = g.store.listSessions().find((s) => s.title === ONBOARDING_TITLE)!;
    const said = g.store.events(session.id).flatMap((e) => (e.type === 'user_message' ? e.message.content : [])).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    for (const a of ANSWERS) assert.ok(said.includes(a), `kept: ${a}`);
  } finally {
    g.close();
  }
});

test('wake-up: a model that never calls a tool is cut off after a few answers and the form takes over', async () => {
  const replies = Array.from({ length: 7 }, (_, i) => `answer ${i + 1}`);
  const r = await wake([...replies, 'Nova', '', '', '', '/exit'], 'no-tools');
  assert.equal(r.code, 0);
  assert.match(r.err, /Setup chat is stopping because nothing was saved after several answers/);
  assert.equal(readPersona(loadConfig(r.home).config.persona).name, 'Nova');
  // Bounded: the chat did not run on and never reached the later script steps.
  assert.ok(r.model.requests.length <= 9, `model calls: ${r.model.requests.length}`);
});

test('wake-up: failed turns count too, so a dead model cannot keep the chat open', async () => {
  const home = tempDir();
  const stdin = new PassThrough();
  const err: string[] = [];
  const dead = new FakeModel(Array.from({ length: 6 }, () => ({ error: { category: 'provider_fatal' as const, message: 'boom' } })));
  const done = chat(['--onboard'], { out: () => {}, err: (t) => err.push(t), stdin, stdout: null, env: {} }, { createGarnet: (o) => createGarnet({ ...o, home, env: {}, model: dead }) });
  stdin.end('hello\nNova\n\n\n\n/exit\n');
  assert.equal(await done, 0);
  assert.match(err.join(''), /Setup chat is stopping because the model kept failing/);
  assert.equal(readPersona(loadConfig(home).config.persona).name, 'Nova');
  assert.ok(dead.requests.length <= 3, `model calls: ${dead.requests.length}`);
});

test('wake-up: --onboard always starts a fresh session, and refuses --session without touching anything', async () => {
  const home = tempDir();
  const titles = () => {
    const g = createGarnet({ home, env: {}, noModel: true });
    try {
      return g.store.listSessions().map((s) => ({ id: s.id, title: s.title }));
    } finally {
      g.close();
    }
  };
  const first = await wake(['/exit'], 'ok', home);
  const second = await wake(['/exit'], 'ok', home);
  assert.equal(first.code + second.code, 0);
  const sessions = titles();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.title), [ONBOARDING_TITLE, ONBOARDING_TITLE]);
  assert.notEqual(sessions[0]!.id, sessions[1]!.id);

  let created = 0;
  const err: string[] = [];
  const code = await chat(['--onboard', '--session', sessions[0]!.id], { out: () => {}, err: (t) => err.push(t), stdin: new PassThrough(), stdout: null, env: {} }, { createGarnet: (o) => (created++, createGarnet({ ...o, home, env: {} })) });
  assert.equal(code, 2);
  assert.match(err.join(''), /cannot be combined with --session/);
  assert.equal(created, 0, 'rejected before anything was created');
  assert.equal(titles().length, 2);
});

test('wake-up: leaving early with nothing saved says what is still to do; a finished setup does not', async () => {
  const early = await wake(['/exit']);
  assert.match(early.err, /Still to do: your name and preferences were not saved\. Run `garnet wake` to try again, or `garnet setup`/);
  const done = await wake([...ANSWERS, '/exit']);
  assert.doesNotMatch(done.err, /Still to do/);
});

test('wake-up: the fallback form starts from what is already saved and also asks the time zone', async () => {
  const home = tempDir();
  const c = defaultConfig();
  c.timezone = 'Europe/Lisbon';
  c.persona = '<!-- garnet setup -->\nYour name is Opal.\nThe person you work for is Alex. Address them as Alex.\n<!-- /garnet setup -->';
  writeConfig(home, c);
  // No answers to the form: every default (what was saved before) is kept.
  const r = await wake([...ANSWERS, 'please try again', '', '', '', '', '/exit'], 'broken-tools', home);
  assert.match(r.err, /Setup chat is stopping/);
  assert.match(r.err, /What should your assistant be called\? \(Opal\)/);
  assert.match(r.err, /And what should it call you\? \(Alex\)/);
  assert.match(r.err, /And your time zone\? \(Europe\/Lisbon\)/);
  assert.equal(loadConfig(home).config.timezone, 'Europe/Lisbon');
  assert.equal(readPersona(loadConfig(home).config.persona).owner, 'Alex');
  // A bad zone is asked again, a good one is saved.
  const again = await wake([...ANSWERS, 'please try again', '', '', '', 'Mars/Base', 'America/New_York', '/exit'], 'broken-tools', home);
  assert.match(again.err, /Use an IANA name/);
  assert.equal(loadConfig(home).config.timezone, 'America/New_York');
});

test('wake-up: set_profile in a session that read untrusted content asks first, and a denial saves nothing', async () => {
  const home = tempDir();
  writeConfig(home, defaultConfig());
  const asked: ApprovalRequest[] = [];
  const model = new FakeModel([{ toolCalls: [{ name: 'set_profile', input: { assistant_name: 'Evil' } }] }, { text: 'done' }]);
  const g = createGarnet({ home, env: {}, memoryDb: true, onboarding: true, model, approver: async (req) => (asked.push(req), 'denied') });
  try {
    const s = g.store.createSession(ONBOARDING_TITLE);
    g.store.append(s.id, { type: 'tainted', source: 'web_fetch https://evil.example/', callId: 'c0' });
    await g.agent.run(s.id, 'hi', { source: 'cli' });
  } finally {
    g.close();
  }
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.tool, 'set_profile');
  assert.equal(asked[0]!.capability, 'memory.write');
  assert.ok(asked[0]!.taint?.length, 'asked because of the untrusted content');
  assert.equal(readPersona(loadConfig(home).config.persona).name, 'Garnet');
});

test('wake-up: with memory.write denied there is no set_profile, no bootstrap prompt, and the chat refuses to start', async () => {
  const home = tempDir();
  const c = defaultConfig();
  c.permissions['memory.write'] = 'deny';
  writeConfig(home, c);
  const model = new FakeModel();
  const g = createGarnet({ home, env: {}, memoryDb: true, onboarding: true, model });
  try {
    const s = g.store.createSession(ONBOARDING_TITLE);
    await g.agent.run(s.id, 'hi', { source: 'cli' });
  } finally {
    g.close();
  }
  assert.equal(model.requests[0]!.tools?.some((t) => t.name === 'set_profile') ?? false, false);
  assert.equal(model.requests[0]!.system.includes('First-run onboarding'), false);

  const r = await wake(['/exit'], 'ok', home);
  assert.equal(r.code, 1);
  assert.match(r.err, /memory\.write permission, and it is set to deny/);
  const g2 = createGarnet({ home, env: {}, noModel: true });
  try {
    assert.equal(g2.store.listSessions().length, 0, 'no session was created');
  } finally {
    g2.close();
  }
});

test('wake-up: /new and /resume are refused in the plain chat too', async () => {
  const r = await wake(['/new', '/resume abc', ...ANSWERS, '/exit']);
  assert.match(r.err, /\/new is not available in the wake-up chat/);
  assert.match(r.err, /\/resume is not available in the wake-up chat/);
  assert.match(r.err, /Tool check passed/, 'the conversation went on in the same session');
  const g = createGarnet({ home: r.home, env: {}, noModel: true });
  try {
    assert.equal(g.store.listSessions().length, 1);
  } finally {
    g.close();
  }
});

test('wake-up: the demo provider (no --fake) plays the offline script instead of echoing', async () => {
  const home = tempDir();
  const c = defaultConfig();
  c.model.provider = 'fake';
  writeConfig(home, c);
  const stdin = new PassThrough();
  const out: string[] = [];
  const done = chat(['--onboard'], { out: (t) => out.push(t), err: () => {}, stdin, stdout: null, env: {} }, { createGarnet: (o) => createGarnet({ ...o, home, env: {} }) });
  stdin.end([...ANSWERS, '/exit'].join('\n') + '\n');
  assert.equal(await done, 0);
  assert.match(out.join(''), /I have just woken up/);
  assert.deepEqual(readPersona(loadConfig(home).config.persona), { name: 'Ruby', owner: 'Sam', notes: 'Short answers, and please no em-dashes' });
});

