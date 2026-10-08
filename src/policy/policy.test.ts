import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import type { SessionTaint } from '../contracts/index.ts';
import { DEFAULT_CONTAINMENT, Policy, hostMatches, normalizeUrl, resolveInWorkspace, urlsInText } from './index.ts';

test('paths cannot escape the workspace', () => {
  const root = tempDir();
  const ws = join(root, 'ws');
  mkdirSync(ws);
  symlinkSync(root, join(ws, 'link'));
  assert.equal(resolveInWorkspace(ws, 'a/b.txt'), join(ws, 'a/b.txt'));
  assert.throws(() => resolveInWorkspace(ws, '../x'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, '/etc/passwd'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, 'link/escape.txt'), /outside the workspace/);
  assert.throws(() => resolveInWorkspace(ws, 'link/new/dir/file.txt'), /outside the workspace/);
});

test('dangling symlinks and unresolvable paths are not treated as missing', () => {
  const root = tempDir();
  const ws = join(root, 'ws');
  mkdirSync(ws);
  symlinkSync(join(root, 'outside', 'x.desktop'), join(ws, 'dangling'));
  assert.throws(() => resolveInWorkspace(ws, 'dangling'), /symlink/);
  assert.throws(() => resolveInWorkspace(ws, 'dangling/child.txt'), /symlink/);
  symlinkSync(join(ws, 'loop-b'), join(ws, 'loop-a'));
  symlinkSync(join(ws, 'loop-a'), join(ws, 'loop-b'));
  assert.throws(() => resolveInWorkspace(ws, 'loop-a/file.txt'), /ELOOP/);
  writeFileSync(join(ws, 'file'), 'x');
  assert.throws(() => resolveInWorkspace(ws, 'file/child'), /ENOTDIR/);
  assert.equal(resolveInWorkspace(ws, 'new/dir/file.txt'), join(realpathSync(ws), 'new/dir/file.txt'));
});

test('intersection grants the stricter permission', () => {
  const owner = new Policy(defaultConfig().permissions); // fs.write: ask
  const job = new Policy({ ...defaultConfig().permissions, 'fs.write': 'allow', 'fs.read': 'deny' });
  const effective = owner.intersect(job);
  assert.equal(effective.check('fs.write').verdict, 'ask');
  assert.equal(effective.check('fs.read').verdict, 'deny');
});

const taint = (sources: string[], ownerUrls: string[] = [], seenUrls: string[] = []): SessionTaint => ({
  sources,
  ownerUrls: new Set(ownerUrls.map((u) => normalizeUrl(u)!)),
  seenUrls: new Set(seenUrls.map((u) => normalizeUrl(u)!)),
});
const allowAll = { ...defaultConfig().permissions, 'fs.write': 'allow', 'net.fetch': 'allow', 'memory.write': 'allow', exec: 'allow', 'message.send': 'allow', 'schedule.edit': 'allow' } as const;

test('untrusted content escalates consequential allows to ask; deny and ask are unchanged', () => {
  const p = new Policy({ ...allowAll, exec: 'deny', 'schedule.edit': 'ask' });
  const t = taint(['web_fetch https://evil.example/']);
  for (const cap of ['fs.write', 'memory.write', 'message.send', 'net.fetch'] as const) {
    assert.equal(p.check(cap).verdict, 'allow', `${cap} untainted`);
    const d = p.check(cap, { taint: t, targets: cap === 'net.fetch' ? ['https://other.example/?q=secret'] : [] });
    assert.equal(d.verdict, 'ask', cap);
    assert.deepEqual(d.taint, ['web_fetch https://evil.example/']);
    assert.match(d.reason, /read untrusted content \(web_fetch https:\/\/evil\.example\/\)/);
  }
  assert.equal(p.check('exec', { taint: t }).verdict, 'deny', 'deny stays deny');
  assert.deepEqual(p.check('schedule.edit', { taint: t }).taint, ['web_fetch https://evil.example/'], 'already ask: still marked, so no standing approval applies');
  assert.equal(p.check('schedule.edit').taint, undefined, 'untainted ask carries no marker');
  assert.equal(p.check('fs.read', { taint: t }).verdict, 'allow', 'reading is not consequential by default');
  assert.equal(p.check('fs.write', { taint: taint([]) }).verdict, 'allow', 'no sources: not tainted');
});

test('containment is owner-configurable: off, or a different capability list', () => {
  const t = taint(['web_search (duckduckgo) "x"']);
  const off = new Policy(allowAll, { containment: { ...DEFAULT_CONTAINMENT, enabled: false } });
  assert.equal(off.check('fs.write', { taint: t }).verdict, 'allow');
  const narrow = new Policy(allowAll, { containment: { ...DEFAULT_CONTAINMENT, escalate: ['message.send'] } });
  assert.equal(narrow.check('fs.write', { taint: t }).verdict, 'allow');
  assert.equal(narrow.check('message.send', { taint: t }).verdict, 'ask');
});

test('net.fetch host scopes allow listed hosts when the capability is ask', () => {
  const p = new Policy({ ...defaultConfig().permissions, 'net.fetch': 'ask' }, { allowHosts: ['en.wikipedia.org', '*.python.org'] });
  assert.equal(p.check('net.fetch', { targets: ['https://en.wikipedia.org/wiki/Cat'] }).verdict, 'allow');
  assert.equal(p.check('net.fetch', { targets: ['https://docs.python.org/3/'] }).verdict, 'allow');
  assert.equal(p.check('net.fetch', { targets: ['https://python.org/'] }).verdict, 'ask', '*.x matches subdomains only');
  assert.equal(p.check('net.fetch', { targets: ['https://en.wikipedia.org.evil.example/'] }).verdict, 'ask');
  assert.equal(p.check('net.fetch', { targets: ['not a url'] }).verdict, 'ask');
  assert.equal(p.check('net.fetch', {}).verdict, 'ask', 'no targets: no scope applies');
  const denied = new Policy({ ...defaultConfig().permissions, 'net.fetch': 'deny' }, { allowHosts: ['en.wikipedia.org'] });
  assert.equal(denied.check('net.fetch', { targets: ['https://en.wikipedia.org/'] }).verdict, 'deny');
});

test('a tainted session may fetch only URLs that carry no data the model composed', () => {
  const p = new Policy({ ...defaultConfig().permissions, 'net.fetch': 'ask' }, { allowHosts: ['huggingface.co'] });
  const t = taint(['web_fetch https://evil.example/'], ['https://owner.example/report?id=7'], ['https://seen.example/a']);
  // An allow-listed host is no exfiltration guard: anyone can own a path there and read download counts.
  assert.equal(p.check('net.fetch', { targets: ['https://huggingface.co/attacker/model?leak=secret'], taint: t }).verdict, 'ask');
  assert.equal(p.check('net.fetch', { targets: ['https://huggingface.co/x'] }).verdict, 'allow', 'untainted, the scope applies');
  const open = new Policy(allowAll, { trustedEndpoints: ['https://html.duckduckgo.com/html/'] });
  const check = (url: string) => open.check('net.fetch', { targets: [url], taint: t }).verdict;
  assert.equal(check('https://owner.example/report?id=7'), 'allow', 'the owner wrote this URL');
  assert.equal(check('https://owner.example/report?id=7#frag'), 'allow', 'fragments are ignored');
  assert.equal(check('https://owner.example/report?id=8'), 'ask');
  assert.equal(check('https://seen.example/a'), 'allow', 'reported verbatim by an untrusted tool');
  assert.equal(check('https://seen.example/a?x=secret'), 'ask');
  assert.equal(check('https://html.duckduckgo.com/html/?q=anything'), 'allow', 'owner-configured search endpoint');
  assert.equal(check('https://html.duckduckgo.com/html-evil/?q=x'), 'ask', 'prefix match is path-segment aware');
  // A call that also sends model-composed bytes (headers, a body) is not a plain fetch, whatever its URL.
  assert.equal(open.check('net.fetch', { targets: ['https://owner.example/report?id=7'], carriesData: true, taint: t }).verdict, 'ask');
  assert.equal(open.check('net.fetch', { targets: ['https://seen.example/a'], carriesData: true, taint: t }).verdict, 'ask');
  assert.equal(open.check('net.fetch', { targets: ['https://seen.example/a'], carriesData: true }).verdict, 'allow', 'untainted, nothing to contain');
  const strict = new Policy(allowAll, { containment: { ...DEFAULT_CONTAINMENT, fetchSeenUrls: false } });
  assert.equal(strict.check('net.fetch', { targets: ['https://seen.example/a'], taint: t }).verdict, 'ask');
});

test('intersection keeps the owner’s containment and scopes', () => {
  const owner = new Policy(allowAll, { allowHosts: ['example.com'] });
  const job = owner.intersect(new Policy({ ...allowAll, 'net.fetch': 'ask' }));
  assert.equal(job.check('net.fetch', { targets: ['https://example.com/'] }).verdict, 'allow');
  assert.equal(job.check('fs.write', { taint: taint(['x']) }).verdict, 'ask');
});

test('URLs in text are found without trailing punctuation or unbalanced brackets', () => {
  assert.deepEqual(urlsInText('See https://a.example/x, and (https://b.example/y). Also [link](https://c.example/z?q=1#h) or HTTP://D.example'), [
    'https://a.example/x',
    'https://b.example/y',
    'https://c.example/z?q=1',
    'http://d.example/',
  ]);
  assert.deepEqual(urlsInText('https://en.wikipedia.org/wiki/Foo_(bar) end'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
  assert.equal(hostMatches('A.Example.COM.', '*.example.com'), true);
  assert.equal(hostMatches('example.com', '*.example.com'), false);
});
