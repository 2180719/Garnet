import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendChunks, splitText, type ChunkFailure } from './delivery.ts';

test('splitText prefers paragraphs, then lines, then words, then a hard cut', () => {
  assert.deepEqual(splitText('aaaa\n\nbbbb', 8), ['aaaa', 'bbbb']);
  assert.deepEqual(splitText('aaaa\nbbbb', 8), ['aaaa', 'bbbb']);
  assert.deepEqual(splitText('hello there world', 12), ['hello there', 'world']);
  // A space early in the window would leave a tiny chunk: hard-cut instead.
  assert.deepEqual(splitText('a bcdefghijklmnop', 8), ['a bcdefg', 'hijklmno', 'p']);
  assert.deepEqual(splitText('x'.repeat(10), 4), ['xxxx', 'xxxx', 'xx']);
  assert.deepEqual(splitText('  \n ', 10), []);
  // Never splits a surrogate pair.
  const emoji = `${'a'.repeat(3)}😀b`;
  assert.deepEqual(splitText(emoji, 4), ['aaa', '😀b']);
  // Content is preserved apart from whitespace at the cuts.
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
  assert.equal(splitText(long, 100).join(' '), long);
  assert.ok(splitText(long, 100).every((c) => c.length <= 100));
});

const fail = (f: Partial<ChunkFailure>) => Object.assign(new Error(f.message ?? 'boom'), { f });
const classify = (e: unknown): ChunkFailure => ({ message: 'boom', maybeDelivered: false, retryable: true, ...(e as { f: Partial<ChunkFailure> }).f });

test('sendChunks leaves a failure of the first chunk to the gateway', async () => {
  const r = await sendChunks(['a', 'b'], async () => { throw fail({ retryable: true, retryAfterMs: 3000 }); }, classify, async () => assert.fail('no in-adapter wait'));
  assert.deepEqual(r, { status: 'failed', retryable: true, error: 'boom', retryAfterMs: 3000 });
  const u = await sendChunks(['a'], async () => { throw fail({ maybeDelivered: true }); }, classify, async () => {});
  assert.equal(u.status, 'uncertain');
  assert.deepEqual(await sendChunks([], async () => 'x', classify, async () => {}), { status: 'failed', retryable: false, error: 'Cannot send an empty message' });
});

test('sendChunks retries a later chunk in place instead of letting the gateway resend the first', async () => {
  const sent: string[] = [];
  const sleeps: number[] = [];
  let failures = 2;
  const r = await sendChunks(
    ['a', 'b', 'c'],
    async (text) => {
      if (text === 'b' && failures-- > 0) throw fail({ retryAfterMs: failures === 1 ? 2000 : undefined });
      sent.push(text);
      return `id-${text}`;
    },
    classify,
    async (ms) => void sleeps.push(ms),
  );
  assert.deepEqual(r, { status: 'sent', externalIds: ['id-a', 'id-b', 'id-c'] });
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('sendChunks gives up on a partly sent message with a final, descriptive failure', async () => {
  const sleeps: number[] = [];
  const send = (f: Partial<ChunkFailure>) =>
    sendChunks(['a', 'b'], async (t) => { if (t === 'b') throw fail(f); return t; }, classify, async (ms) => void sleeps.push(ms));
  const exhausted = await send({ retryable: true });
  assert.deepEqual(exhausted, { status: 'failed', retryable: false, error: 'boom (after sending 1 of 2 chunks); the rest was not sent' });
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  sleeps.length = 0;
  assert.equal((await send({ retryable: true, retryAfterMs: 60_000 })).status, 'failed', 'a wait beyond the budget is not attempted');
  assert.deepEqual(sleeps, []);
  assert.deepEqual(await send({ retryable: false }), { status: 'failed', retryable: false, error: 'boom (after sending 1 of 2 chunks); the rest was not sent' });
  assert.deepEqual(await send({ maybeDelivered: true }), { status: 'uncertain', error: 'boom (after sending 1 of 2 chunks)' });
});
