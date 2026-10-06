import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../../test/helpers.ts';
import { complete, matchingCommands, messageText, parseSlash } from './commands.ts';
import { HISTORY_LIMIT, InputHistory } from './history.ts';

test('slash commands parse with aliases, arguments and unknown names', () => {
  const p = parseSlash('/resume  ses_123 ');
  assert.ok(p && 'command' in p && p.command.name === 'resume' && p.args === 'ses_123');
  const q = parseSlash('/QUIT');
  assert.ok(q && 'command' in q && q.command.name === 'exit');
  assert.deepEqual(parseSlash('/nope'), { unknown: 'nope' });
  assert.equal(parseSlash('hello /help'), null);
  assert.equal(parseSlash('//not a command'), null, '// escapes a leading slash');
  assert.equal(messageText('//etc/hosts is a file'), '/etc/hosts is a file');
});

test('suggestions list commands matching what is typed', () => {
  assert.deepEqual(matchingCommands('/c').map((c) => c.name), ['compact', 'clear']);
  assert.equal(matchingCommands('/').length > 5, true);
  assert.deepEqual(matchingCommands('/help me'), [], 'not once arguments start');
});

test('tab completes a unique command, a common prefix, or the first match', () => {
  assert.equal(complete('/he').text, '/help ');
  assert.equal(complete('/s').text, '/sessions ');
  assert.equal(complete('/c').text, '/compact', 'no common prefix beyond "c": the first match');
  assert.equal(complete('/compact').text, '/compact ', 'then it is unique');
  assert.equal(complete('/zz').text, '/zz');
  assert.equal(complete('plain text').text, 'plain text');
});

test('tab completes /resume session ids', () => {
  const ids = () => ['ses_abc1', 'ses_abc2', 'ses_xyz'];
  assert.equal(complete('/resume ses_x', ids).text, '/resume ses_xyz');
  assert.equal(complete('/resume ses_', ids).text, '/resume ses_abc1', 'the first match when the common prefix adds nothing');
  assert.equal(complete('/resume ses_a', ids).text, '/resume ses_abc');
  assert.equal(complete('/help x', ids).text, '/help x', 'commands without arguments do not complete');
});

test('history persists across instances, skips space-prefixed and repeated entries', () => {
  const dir = tempDir();
  const path = join(dir, 'chat_history.jsonl');
  const h = new InputHistory(path);
  h.add('first');
  h.add('multi\nline');
  h.add('multi\nline');
  h.add(' secret thing');
  h.add('   ');
  assert.deepEqual(new InputHistory(path).entries, ['first', 'multi\nline']);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600, 'history is private to the owner');
});

test('history tolerates damaged lines and stays bounded', () => {
  const dir = tempDir();
  const path = join(dir, 'h.jsonl');
  writeFileSync(path, '"ok"\nnot json\n42\n"also ok"\n');
  assert.deepEqual(new InputHistory(path).entries, ['ok', 'also ok']);
  const h = new InputHistory(join(dir, 'big.jsonl'));
  for (let i = 0; i < HISTORY_LIMIT * 1.3; i++) h.add(`m${i}`);
  assert.ok(new InputHistory(join(dir, 'big.jsonl')).entries.length <= HISTORY_LIMIT);
  assert.equal(new InputHistory(null).entries.length, 0);
});
