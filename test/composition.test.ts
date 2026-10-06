// The composition root's own safety checks.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { isGarnetError } from '../src/contracts/index.ts';
import { createGarnet } from '../src/main.ts';

const withWorkspace = (workspace: string) => {
  const home = join(tempDir(), 'garnet-home');
  const parent = dirname(home);
  return { home, parent, config: { version: 1, workspace: workspace.replace('{home}', home).replace('{parent}', parent) } };
};

test('a workspace that contains Garnet’s home is refused: tools could rewrite config, secrets or skills', () => {
  for (const ws of ['{home}', '{parent}', '.', '..']) {
    const { home, config } = withWorkspace(ws);
    createGarnet({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    assert.throws(() => createGarnet({ home, memoryDb: true, noModel: true }), (e) => isGarnetError(e, 'config') && /workspace/.test(e.message), ws);
  }
});

test('a workspace beside or below home is fine', () => {
  for (const ws of ['workspace', '{parent}/elsewhere', '{home}/deep/work']) {
    const { home, config } = withWorkspace(ws);
    createGarnet({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify(config));
    createGarnet({ home, memoryDb: true, noModel: true }).close();
  }
});

test('web tools follow net.fetch and the search backend; the owner policy carries containment', () => {
  const withConfig = (extra: Record<string, unknown>) => {
    const home = join(tempDir(), 'garnet-home');
    createGarnet({ home, memoryDb: true, noModel: true }).close();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ version: 1, ...extra }));
    return createGarnet({ home, memoryDb: true, noModel: true });
  };
  const names = (extra: Record<string, unknown>) => {
    const garnet = withConfig(extra);
    try {
      return garnet.registry.names().filter((n) => n.startsWith('web_'));
    } finally {
      garnet.close();
    }
  };
  assert.deepEqual(names({}), ['web_fetch', 'web_search'], 'net.fetch is ask by default');
  assert.deepEqual(names({ permissions: { 'net.fetch': 'deny' } }), []);
  assert.deepEqual(names({ web: { search: { backend: 'none' } } }), ['web_fetch']);
  assert.throws(() => withConfig({ web: { search: { backend: 'searxng' } } }), /searxngUrl/);

  const garnet = withConfig({ permissions: { 'net.fetch': 'allow', 'fs.write': 'allow' }, web: { allowHosts: ['example.com'] } });
  try {
    const taint = { sources: ['web_fetch https://evil.example/'], ownerUrls: new Set<string>(), seenUrls: new Set<string>() };
    assert.equal(garnet.ownerPolicy.check('fs.write', { taint }).verdict, 'ask');
    assert.equal(garnet.ownerPolicy.check('net.fetch', { targets: ['https://html.duckduckgo.com/html/?q=x'], taint }).verdict, 'allow', 'the configured search endpoint');
    assert.equal(garnet.ownerPolicy.check('net.fetch', { targets: ['https://example.com/?q=secret'], taint }).verdict, 'ask');
  } finally {
    garnet.close();
  }
});
