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
  assert.deepEqual(scopesForConversation(null, routes), { scopes: ['cli'] });
  assert.deepEqual(scopesForConversation('telegram:default:42', routes), { scopes: ['telegram', 'telegram:42'] });
  assert.deepEqual(scopesForConversation('signal:+15550001:group:abc=', routes), { scopes: ['signal', 'signal:group:abc='] });
  assert.deepEqual(
    scopesForConversation('route:family', routes),
    { scopes: ['route:family'], feeds: [['telegram', 'telegram:5'], ['telegram', 'telegram:6']] },
    'a route is fed by each chat linked into it',
  );
  assert.deepEqual(scopesForConversation('route:mixed', routes), { scopes: ['route:mixed'], feeds: [['telegram'], ['discord']] }, 'a route across channels is fed by each channel');
  assert.deepEqual(scopesForConversation('route:gone', routes), { scopes: ['route:gone'], feeds: [] });
  assert.deepEqual(scopesForConversation('api:k1:default', routes), { scopes: ['api', 'api:k1'] });
  assert.deepEqual(scopesForConversation('job:morning', routes), { scopes: ['job', 'job:morning'] });
  assert.deepEqual(scopesForConversation('dashboard', routes), { scopes: ['dashboard'] });
});

test('a channel-wide route is also fed by each chat with an override that it takes in', () => {
  const routes: Route[] = [
    { match: { channel: 'telegram', chatId: '5' }, conversation: 'family' },
    { match: { channel: 'telegram' }, conversation: 'mixed' },
  ];
  const toggles = [{ enabled: [], channels: { 'telegram:9': { enable: [], disable: ['github'] }, 'telegram:5': { enable: [], disable: ['github'] }, 'discord:9': { enable: ['github'], disable: [] } } }];
  assert.deepEqual(scopesForConversation('route:mixed', routes, toggles), { scopes: ['route:mixed'], feeds: [['telegram'], ['telegram', 'telegram:9']] }, 'telegram:5 has its own route');
});
