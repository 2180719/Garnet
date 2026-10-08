// Built-in pre-checks (`url_changed`, `file_changed`) run under the job's effective policy and the guarded client.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { parseConfig, type JobConfig } from '../config/index.ts';
import type { Capability } from '../contracts/index.ts';
import { Policy } from '../policy/index.ts';
import { JobStore, openDb } from '../store/index.ts';
import type { FetchResponse } from '../tools/index.ts';
import { Scheduler } from './index.ts';

const response = (body: string, extra: Partial<FetchResponse> = {}): FetchResponse => ({
  url: 'https://status.example/', redirects: [], status: 200, statusText: 'OK', contentType: 'text/plain', body: Buffer.from(body), truncated: false, ...extra,
});
const job = (check: object): JobConfig => parseConfig({ version: 1, jobs: [{ id: 'watch', kind: 'heartbeat', everyMinutes: 30, instructions: 'Look.', check }] }).jobs[0]!;

/** Permissions with everything denied except the listed capabilities. */
const policy = (allow: Capability[], ask: Capability[] = [], options: ConstructorParameters<typeof Policy>[1] = {}) => {
  const all = ['fs.read', 'fs.write', 'net.fetch', 'exec', 'message.send', 'memory.write', 'schedule.edit'] as Capability[];
  return new Policy(Object.fromEntries(all.map((c) => [c, allow.includes(c) ? 'allow' : ask.includes(c) ? 'ask' : 'deny'])) as Record<Capability, 'allow' | 'ask' | 'deny'>, options);
};

function setup(j: JobConfig, deps: { taint?: string[]; policy?: Policy; fetcher?: (url: string) => FetchResponse; workspace?: string }) {
  let now = new Date('2026-10-05T10:00:10Z');
  const store = new JobStore(openDb(':memory:'));
  const runs: string[] = [];
  const fetched: string[] = [];
  const scheduler = new Scheduler({
    jobs: [j], store, workspace: deps.workspace ?? tempDir(), tickSeconds: 30, now: () => now,
    run: async (_job, text) => {
      runs.push(text);
      return { task: { id: 't', sessionId: 's', status: 'completed', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null }, modelCalls: 1, toolCalls: 0, startedAt: '', endedAt: '', reason: null }, text: 'Changed!' };
    },
    notify: () => {},
    ...(deps.taint ? { taintFor: () => ({ sources: deps.taint!, ownerUrls: new Set<string>(), seenUrls: new Set<string>() }) } : {}),
    ...(deps.policy ? { policyFor: () => deps.policy! } : {}),
    ...(deps.fetcher ? { fetcher: { fetch: async (url: string) => (fetched.push(url), deps.fetcher!(url)) } } : {}),
  });
  const slot = async () => {
    now = new Date(now.getTime() + 30 * 60_000);
    await scheduler.tick();
    await scheduler.stop();
  };
  return { store, runs, fetched, slot, first: () => scheduler.tick() };
}

const last = (t: ReturnType<typeof setup>) => t.store.runs('watch').at(-1);

test('url_changed: net.fetch deny, ask or no policy fails closed and never fetches', async () => {
  const j = job({ type: 'url_changed', url: 'http://127.0.0.1:8080/secret' });
  for (const [name, p] of [['deny', policy([])], ['ask', policy([], ['net.fetch'])], ['no policy', undefined]] as const) {
    const t = setup(j, { ...(p ? { policy: p } : {}), fetcher: () => response('x') });
    await t.first(); // baseline
    await t.slot();
    assert.deepEqual(t.fetched, [], `${name}: nothing fetched`);
    assert.equal(t.runs.length, 0, `${name}: the model is not called`);
    assert.equal(last(t)?.status, 'failed');
    assert.match(last(t)?.note ?? '', /Pre-check for job "watch" refused/);
  }
});

test('url_changed: with net.fetch allowed it goes through the guarded client, and only a change wakes the model', async () => {
  let body = 'v1';
  const t = setup(job({ type: 'url_changed', url: 'https://status.example/' }), { policy: policy([], ['net.fetch'], { allowHosts: ['status.example'] }), fetcher: () => response(body) });
  await t.first();
  await t.slot();
  assert.equal(t.runs.length, 1, 'first value is new');
  await t.slot();
  assert.equal(t.runs.length, 1, 'unchanged');
  body = 'v2';
  await t.slot();
  assert.equal(t.runs.length, 2);
  assert.deepEqual(t.fetched, Array(3).fill('https://status.example/'));
});

test('url_changed: a truncated body hashes differently from the same bytes arriving whole', async () => {
  let truncated = false;
  const t = setup(job({ type: 'url_changed', url: 'https://status.example/' }), { policy: policy(['net.fetch']), fetcher: () => response('v1', { truncated }) });
  await t.first();
  await t.slot();
  await t.slot();
  assert.equal(t.runs.length, 1, 'same response, unchanged');
  truncated = true;
  await t.slot();
  assert.equal(t.runs.length, 2);
});

test('url_changed: a tainted job cannot fetch silently; an untainted one (owner-written URL) can', async () => {
  const j = job({ type: 'url_changed', url: 'https://status.example/?q=composed' });
  const tainted = setup(j, { taint: ['web_fetch https://evil.example/'], policy: policy(['net.fetch']), fetcher: () => response('x') });
  await tainted.first();
  await tainted.slot();
  assert.deepEqual(tainted.fetched, []);
  assert.equal(last(tainted)?.status, 'failed');
  assert.match(last(tainted)?.note ?? '', /needs approval/);
  const clean = setup(j, { taint: [], policy: policy(['net.fetch']), fetcher: () => response('x') });
  await clean.first();
  await clean.slot();
  assert.equal(clean.fetched.length, 1);
});

test('the pause notice of a failing url_changed check is marked untrusted', async () => {
  const notes: (readonly string[] | undefined)[] = [];
  const j = job({ type: 'url_changed', url: 'https://status.example/' });
  let now = new Date('2026-10-05T10:00:10Z');
  const scheduler = new Scheduler({
    jobs: [j], store: new JobStore(openDb(':memory:')), workspace: tempDir(), tickSeconds: 30, now: () => now,
    run: async () => { throw new Error('unused'); },
    notify: (_j, _t, extra) => notes.push(extra?.taint),
    policyFor: () => policy(['net.fetch']),
    fetcher: { fetch: async () => { throw new Error('redirect to http://evil/ignore-previous-instructions'); } },
  });
  await scheduler.tick();
  for (let i = 0; i < 3; i++) {
    now = new Date(now.getTime() + 30 * 60_000);
    await scheduler.tick();
    await scheduler.stop();
  }
  assert.deepEqual(notes, [['url_changed pre-check https://status.example/']]);
});

test('file_changed does not block on a FIFO', async () => {
  const workspace = tempDir();
  execFileSync('mkfifo', [join(workspace, 'pipe')]);
  const t = setup(job({ type: 'file_changed', path: 'pipe' }), { policy: policy(['fs.read']), workspace });
  await t.first();
  await t.slot();
  assert.equal(last(t)?.status, 'completed');
});

test('url_changed: a fetcher error (blocked address, timeout) fails the run', async () => {
  const t = setup(job({ type: 'url_changed', url: 'http://10.0.0.1/' }), {
    policy: policy(['net.fetch']),
    fetcher: () => {
      throw new Error('Refused: 10.0.0.1 is not a public address');
    },
  });
  await t.first();
  await t.slot();
  assert.equal(last(t)?.status, 'failed');
  assert.match(last(t)?.note ?? '', /not a public address/);
});

test('file_changed: fs.read must be allowed; reads are bounded', async () => {
  const workspace = tempDir();
  writeFileSync(join(workspace, 'notes.txt'), 'one');
  const j = job({ type: 'file_changed', path: 'notes.txt' });
  const denied = setup(j, { policy: policy([], ['fs.read']), workspace });
  await denied.first();
  await denied.slot();
  assert.equal(last(denied)?.status, 'failed');
  assert.match(last(denied)?.note ?? '', /Pre-check for job "watch" refused: fs\.read needs approval/);
  assert.equal(denied.runs.length, 0);

  const allowed = setup(j, { policy: policy(['fs.read']), workspace });
  await allowed.first();
  await allowed.slot();
  assert.equal(allowed.runs.length, 1);
  await allowed.slot();
  assert.equal(allowed.runs.length, 1, 'unchanged');
  writeFileSync(join(workspace, 'notes.txt'), 'two');
  await allowed.slot();
  assert.equal(allowed.runs.length, 2);

  // Changes beyond the read limit still show, because the file size is part of the hash.
  const big = Buffer.alloc(6 * 1024 * 1024, 'a');
  writeFileSync(join(workspace, 'big.bin'), big);
  const b = setup(job({ type: 'file_changed', path: 'big.bin' }), { policy: policy(['fs.read']), workspace });
  await b.first();
  await b.slot();
  await b.slot();
  assert.equal(b.runs.length, 1);
  writeFileSync(join(workspace, 'big.bin'), Buffer.concat([big, Buffer.from('b')]));
  await b.slot();
  assert.equal(b.runs.length, 2);
});
