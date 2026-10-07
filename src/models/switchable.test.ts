import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelEvent } from '../contracts/index.ts';
import { FakeModel, SwitchableModel } from './index.ts';

async function run(m: SwitchableModel): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const e of m.stream({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxOutputTokens: 10 })) out.push(e);
  return out;
}

test('SwitchableModel sends each call to the current adapter and reports its id and capabilities', async () => {
  const a = new FakeModel([{ text: 'from a' }], { media: { images: true, pdf: true, maxImageBytes: 1, maxPdfBytes: 1 } });
  const b = new FakeModel([{ text: 'from b' }], { media: { images: false, pdf: false, maxImageBytes: 1, maxPdfBytes: 1 } });
  const m = new SwitchableModel(a);
  assert.equal(m.id, a.id);
  assert.equal(m.capabilities.media?.images, true);
  await run(m);
  m.swap(b);
  assert.equal(m.capabilities.media?.images, false);
  const events = await run(m);
  assert.equal(a.requests.length, 1);
  assert.equal(b.requests.length, 1);
  assert.deepEqual((events.at(-1) as Extract<ModelEvent, { type: 'done' }>).message.content, [{ type: 'text', text: 'from b' }]);
});
