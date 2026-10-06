import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopesForConversation, type Route } from './index.ts';

test('a conversation key maps to the config scopes for optional built-ins, broadest first', () => {
  const routes: Route[] = [
    { match: { channel: 'telegram', chatId: '5' }, conversation: 'family' },
    { match: { channel: 'telegram', chatId: '6' }, conversation: 'family' },
    { match: { channel: 'telegram' }, conversation: 'mixed' },
    { match: { channel: 'discord' }, conversation: 'mixed' },
  ];
  assert.deepEqual(scopesForConversation(null, routes), ['cli']);
  assert.deepEqual(scopesForConversation('telegram:default:42', routes), ['telegram', 'telegram:42']);
  assert.deepEqual(scopesForConversation('signal:+15550001:group:abc=', routes), ['signal', 'signal:group:abc=']);
  assert.deepEqual(scopesForConversation('route:family', routes), ['telegram', 'route:family'], 'a route on one channel inherits that channel');
  assert.deepEqual(scopesForConversation('route:mixed', routes), ['route:mixed'], 'a route across channels has only its own scope');
  assert.deepEqual(scopesForConversation('route:gone', routes), ['route:gone']);
  assert.deepEqual(scopesForConversation('api:k1:default', routes), ['api', 'api:k1']);
  assert.deepEqual(scopesForConversation('job:morning', routes), ['job', 'job:morning']);
  assert.deepEqual(scopesForConversation('dashboard', routes), ['dashboard']);
});
