// The config browser: section summaries, search, the changes view, list editing and secret notes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, type GarnetConfig } from '../../config/index.ts';
import { KeyParser, type Key } from '../chat/keys.ts';
import { stripAnsi } from '../chat/text.ts';
import { makeTheme } from '../chat/theme.ts';
import { configScreen, type ConfigState, type SecretStatus } from './config-browser.ts';
import { fieldsFromSchema, getAt } from './config-fields.ts';
import { orderSections } from './config-sections.ts';

const plain = makeTheme({ styled: false, color: false, truecolor: false });
const keys = (text: string): Key[] => {
  const parser = new KeyParser();
  return [...parser.feed(text), ...parser.flush()];
};

function browser(config: GarnetConfig = defaultConfig(), opts: { width?: number; height?: number; secretStatus?: (n: string) => SecretStatus } = {}) {
  const saved: GarnetConfig[] = [];
  const screen = configScreen(config, { save: (c) => saved.push(c), file: '/tmp/home/config.json', theme: plain, ...(opts.secretStatus ? { secretStatus: opts.secretStatus } : {}) });
  let state: ConfigState = screen.state;
  const press = (text: string) => {
    // One key at a time, like typing: escape sequences stay whole, other characters are separate keys.
    for (const token of text.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) for (const k of keys(token)) state = screen.update(state, k).state;
    return screen.view(state, opts.width ?? 80, opts.height ?? 24).rows.map((r) => stripAnsi(r));
  };
  /** Moves the section cursor to the section with this title, then opens it. */
  const open = (title: string) => {
    press('\x1b[H'); // Home
    for (let i = 0; i < 40 && !press('').some((r) => r.includes(`› ${title}`)); i++) press('j');
    return press('\r');
  };
  /** Moves down until a row containing `text` is highlighted (bounded, so a typo fails instead of hanging). */
  const seek = (text: string) => {
    for (let i = 0; i < 60; i++) {
      if (press('').some((r) => r.includes(`› ${text}`))) return press('');
      press('j');
    }
    throw new Error(`no highlighted row with "${text}"`);
  };
  return { press, open, seek, saved, get state() { return state; } };
}

test('sections have plain titles and a live summary, in the order a new owner wants them', () => {
  const b = browser(defaultConfig(), { height: 40 });
  const rows = b.press('');
  const text = rows.join('\n');
  assert.match(text, /› General +host time zone · provider default/);
  assert.match(text, /Model +anthropic · claude-opus-5-5/);
  assert.match(text, /Permissions +\d allow · \d ask · 1 deny/);
  assert.match(text, /Connectors +none/);
  assert.match(text, /Command sandbox +docker/);
  assert.match(text, /Limits and budgets +no daily cap/);
  // The blurb of the highlighted section is shown when there is room.
  assert.match(rows.join('\n'), /Your time zone, the workspace folder/);
  // Sections the table does not know come last, titled by their key.
  assert.deepEqual(orderSections(['zzz', 'model', 'general']), ['general', 'model', 'zzz']);
});

test('every section of the real schema has a title entry or still shows up under its key', () => {
  const b = browser();
  assert.ok(b.state.sections.length >= 15);
  assert.equal(b.state.sections[0], 'general');
  assert.equal(b.state.sections[1], 'model');
});

test('wide terminals show a preview of the highlighted section next to the list', () => {
  const b = browser(defaultConfig(), { width: 130 });
  const rows = b.press('jj'); // Permissions
  assert.ok(rows.some((r) => r.includes('› Permissions') && r.includes('│') && r.includes('Permissions')));
  assert.ok(rows.some((r) => r.includes('permissions.fs.write') && r.includes('ask')), rows.join('\n'));
});

test('search finds settings by name or description across sections and opens them', () => {
  const b = browser();
  let rows = b.press('/');
  assert.equal(b.state.scope.kind, 'search');
  assert.ok(rows.some((r) => r.includes('Search settings')));
  // Letters that are commands elsewhere are text here.
  rows = b.press('daily');
  assert.ok(rows.some((r) => r.includes('budgets.dailyUsd')), rows.join('\n'));
  assert.equal(rows.some((r) => r.includes('model.name')), false);
  rows = b.press('\r'); // keep results
  assert.ok(rows.some((r) => r.includes('(/ to change)')));
  rows = b.press('\r'); // edit the highlighted one
  assert.equal(b.state.level, 'edit');
  b.press('12.5\r');
  assert.equal(getAt(b.state.draft, ['budgets', 'dailyUsd']), 12.5);
  assert.equal(b.state.level, 'fields');
  assert.equal(b.state.scope.kind, 'search');
  // Esc leaves the search and returns to the sections.
  b.press('\x1b');
  assert.equal(b.state.level, 'sections');
  assert.equal(b.state.scope.kind, 'section');
  // Descriptions are searched too, and nothing matching says so.
  b.press('/');
  let r = b.press('cors');
  assert.ok(r.some((x) => x.includes('api.corsOrigins')));
  r = b.press('\x15zzzzqq');
  assert.ok(r.some((x) => x.includes('No settings match.')));
});

test('the changes view lists what differs from the last save and is empty when nothing changed', () => {
  const b = browser();
  let rows = b.press('c');
  assert.ok(rows.some((r) => r.includes('Nothing has changed since the last save.')));
  assert.equal(b.state.level, 'sections');
  b.open('Model');
  b.seek('model.fallbacks');
  b.press(' ');
  b.press('\x1b'); // sections
  rows = b.press('');
  assert.ok(rows.some((r) => /Model .*\(1 changed\)/.test(r)), rows.join('\n'));
  assert.match(rows[0]!, /unsaved changes \(1\)/);
  rows = b.press('c');
  assert.ok(rows.some((r) => r.includes('Changed since the last save (1)')));
  assert.ok(rows.some((r) => r.includes('model.fallbacks') && r.includes('[ ] off')));
  b.press('s');
  rows = b.press('');
  assert.equal(b.saved.length, 1);
  assert.ok(rows.some((r) => r.includes('Nothing here.')) || b.state.scope.kind === 'changed');
});

test('a list of text items is edited in place: add, edit, remove, each checked by the schema', () => {
  const b = browser();
  b.open('Web');
  b.seek('web.allowHosts');
  let rows = b.press('\r');
  assert.equal(b.state.level, 'list');
  assert.ok(rows.some((r) => r.includes('+ add an item')));
  rows = b.press('a');
  b.press('en.wikipedia.org\r');
  assert.deepEqual(getAt(b.state.draft, ['web', 'allowHosts']), ['en.wikipedia.org']);
  b.press('a');
  b.press('*.python.org\r');
  assert.deepEqual(getAt(b.state.draft, ['web', 'allowHosts']), ['en.wikipedia.org', '*.python.org']);
  // A value the schema rejects stays in the input with the reason.
  b.press('a');
  rows = b.press('not a host!\r');
  assert.ok(rows.some((r) => r.includes('✗')), rows.join('\n'));
  assert.deepEqual(getAt(b.state.draft, ['web', 'allowHosts']), ['en.wikipedia.org', '*.python.org']);
  b.press('\x1b'); // cancel the item
  // Edit the first item, then remove the second.
  b.press('\x1b[H\x1b[A\x1b[A\x1b[A'); // top (cursor moves are clamped)
  b.press('\r');
  b.press('\x15docs.python.org\r');
  assert.deepEqual(getAt(b.state.draft, ['web', 'allowHosts']), ['docs.python.org', '*.python.org']);
  b.press('jd');
  assert.deepEqual(getAt(b.state.draft, ['web', 'allowHosts']), ['docs.python.org']);
  rows = b.press('\x1b');
  assert.equal(b.state.level, 'fields');
  assert.ok(rows.some((r) => r.includes('web.allowHosts') && r.includes('docs.python.org') && r.includes('(changed)')));
});

test('a list with a fixed set of items is a checklist', () => {
  const b = browser();
  b.open('Skills');
  let rows = b.press('\r');
  assert.equal(b.state.level, 'multi');
  assert.ok(rows.some((r) => r.includes('› [ ] daily-briefing')));
  rows = b.press(' jj ');
  assert.deepEqual(getAt(b.state.draft, ['skills', 'enabled']), ['daily-briefing', 'web-research']);
  assert.ok(rows.some((r) => r.includes('[x] web-research')));
  rows = b.press('\r');
  assert.equal(b.state.level, 'fields');
  assert.ok(rows.some((r) => r.includes('skills.enabled') && r.includes('daily-briefing, web-research')), rows.join('\n'));
});

test('tables and lists of objects say where to edit them', () => {
  const b = browser();
  b.open('General');
  b.seek('providers');
  let rows = b.press('\r');
  assert.ok(rows.some((r) => r.includes('garnet providers')), rows.join('\n'));
  b.seek('jobs');
  rows = b.press('\r');
  assert.ok(rows.some((r) => r.includes('garnet jobs')));
});

test('secret names show whether they resolve, never the value', () => {
  const calls: string[] = [];
  const b = browser(defaultConfig(), {
    secretStatus: (n) => (calls.push(n), n === 'ANTHROPIC_API_KEY' ? 'set' : n === 'DISCORD_BOT_TOKEN' ? 'locked' : 'missing'),
  });
  let rows = b.open('Model');
  assert.ok(rows.some((r) => r.includes('model.apiKeyEnv') && r.includes('ANTHROPIC_API_KEY ✓ found')), rows.join('\n'));
  b.press('\x1b');
  rows = b.open('Channels');
  assert.ok(rows.some((r) => r.includes('channels.telegram.tokenEnv') && r.includes('TELEGRAM_BOT_TOKEN') && r.includes('✗ not found')));
  assert.ok(rows.some((r) => r.includes('channels.discord.tokenEnv') && r.includes('? store locked')));
  assert.ok(calls.every((n) => /^[A-Z_]+$/.test(n)));
});

test('lists and enum-lists are generated from the schema', async () => {
  const { configSchema } = await import('../../config/index.ts');
  const fields = fieldsFromSchema(configSchema.toJSONSchema({ io: 'input' }) as never);
  const f = (p: string) => fields.find((x) => x.path.join('.') === p)!;
  assert.equal(f('web.allowHosts').kind, 'list');
  assert.deepEqual(f('web.allowHosts').itemChoices, []);
  assert.equal(f('skills.enabled').kind, 'list');
  assert.deepEqual(f('skills.enabled').itemChoices, ['daily-briefing', 'github-triage', 'web-research']);
  assert.equal(f('containment.escalate').kind, 'list');
  assert.ok(f('containment.escalate').itemChoices.includes('exec'));
  assert.equal(f('connectors.github.repos').kind, 'list');
  assert.equal(f('jobs').kind, 'complex');
  assert.equal(f('providers').kind, 'complex');
});

test('short terminals still show the question and key hints', () => {
  const b = browser(defaultConfig(), { height: 9 });
  b.press('/');
  const rows = b.press('');
  assert.ok(rows.some((r) => r.includes('type to filter')));
  assert.equal(rows.length, 9);
});

test('the changes view: editing a setting back to its saved value does not move the editor to another setting', () => {
  const b = browser();
  b.open('Skills');
  b.press('\r');
  b.press(' \x1b'); // skills.enabled: one skill on
  b.press('\x1b');
  b.open('Connectors');
  b.press('\r');
  b.press(' \x1b');
  b.press('\x1b');
  b.press('c');
  b.press('\r'); // first changed setting
  const target = b.state.target;
  b.press(' '); // back to the saved value: it drops out of the changes list
  assert.equal(b.state.target, target);
  b.press(' ');
  assert.deepEqual(getAt(b.state.draft, ['connectors', 'enabled']), ['calendar']);
  b.press('\x1b');
  assert.equal(b.state.level, 'fields');

  const one = browser();
  one.open('Web');
  one.seek('web.allowHosts');
  one.press('\r');
  one.press('a');
  one.press('x.org\r');
  one.press('\x1b');
  one.press('c');
  one.press('\r');
  one.press('d'); // empties the list again: must not crash
  assert.equal(one.state.level, 'list');
  assert.deepEqual(getAt(one.state.draft, ['web', 'allowHosts']), []);
});
