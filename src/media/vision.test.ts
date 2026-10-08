import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import { defaultConfig } from '../config/index.ts';
import type { AttachmentBlock, Usage } from '../contracts/index.ts';
import { FakeModel } from '../models/index.ts';
import { Policy } from '../policy/index.ts';
import { ToolExecutor, ToolRegistry } from '../tools/index.ts';
import { MediaStore, visionTool } from './index.ts';

const PNG = join(import.meta.dirname, '..', '..', 'test', 'media', 'pixel.png');
const TEXT_ONLY = { images: false, pdf: false, maxImageBytes: 0, maxPdfBytes: 0 };

function setup(opts: { seen?: FakeModel; blind?: boolean } = {}) {
  const workspace = tempDir();
  const media = new MediaStore(tempDir(), 5_000_000);
  const seeing = opts.seen ?? new FakeModel([{ text: 'A single red pixel.', usage: { inputTokens: 10, outputTokens: 4 } }]);
  const blind = new FakeModel([], { media: TEXT_ONLY });
  const spent: Usage[] = [];
  const tool = visionTool({
    media,
    resolve: (provider, model) => {
      if (provider === undefined && model === undefined) return { adapter: opts.blind ? blind : seeing, provider: 'default', model: 'main' };
      if (provider === 'eyes') return { adapter: seeing, provider: 'eyes', model: model ?? 'v1' };
      throw new Error(`unexpected provider ${provider}`);
    },
    providers: () => [{ name: 'default', model: 'main', vision: false }, { name: 'eyes', model: 'v1', vision: true }],
    recordSpend: (u) => spent.push(u),
  });
  const registry = new ToolRegistry().register(tool);
  const executor = new ToolExecutor({ registry, policy: new Policy({ ...defaultConfig().permissions, 'fs.read': 'allow' }), approver: async () => 'denied' });
  const call = (input: unknown) => executor.execute({ type: 'tool_call', id: 'c', name: 'vision_analyze', input }, { sessionId: 's', workspace, memoryNamespace: 'default', signal: new AbortController().signal });
  return { workspace, media, seeing, blind, spent, call };
}

test('vision_analyze sends a workspace image to the model and records its spend', async () => {
  const t = setup();
  copyFileSync(PNG, join(t.workspace, 'pixel.png'));
  const r = await t.call({ path: 'pixel.png', question: 'What is this?' });
  assert.equal(r.status, 'ok');
  assert.match(r.content, /^default\/main on pixel\.png:\nA single red pixel\./);
  const sent = t.seeing.requests[0]!.messages[0]!.content;
  assert.deepEqual(sent[0], { type: 'text', text: 'What is this?' });
  const img = sent[1] as AttachmentBlock;
  assert.equal(img.attachment.mimeType, 'image/png');
  assert.equal(img.data, readFileSync(PNG).toString('base64'));
  assert.equal(t.spent.length, 1);
});

test('vision_analyze reads stored attachments and can pick another provider', async () => {
  const t = setup({ blind: true });
  const ref = t.media.put({ data: readFileSync(PNG) });
  const blind = await t.call({ attachment: ref.id });
  assert.equal(blind.status, 'error');
  assert.match(blind.content, /cannot view images\. Retry with provider set to one that can: eyes/);
  const ok = await t.call({ attachment: ref.id, provider: 'eyes', model: 'v2' });
  assert.equal(ok.status, 'ok');
  assert.match(ok.content, /^eyes\/v2 on med_/);
});

test('vision_analyze refuses non-images, missing files, escapes, and ambiguous input', async () => {
  const t = setup();
  writeFileSync(join(t.workspace, 'notes.txt'), 'hello');
  mkdirSync(join(t.workspace, 'sub'));
  const outside = tempDir();
  copyFileSync(PNG, join(outside, 'secret.png'));
  symlinkSync(join(outside, 'secret.png'), join(t.workspace, 'link.png'));
  for (const [input, pattern] of [
    [{ path: 'notes.txt' }, /not a png, jpeg, gif or webp image/],
    [{ path: 'missing.png' }, /does not exist/],
    [{ path: 'sub' }, /not a file/],
    [{ path: '../x.png' }, /outside|escape|workspace/i],
    [{ path: 'link.png' }, /outside|workspace/i],
    [{}, /exactly one of/],
    [{ path: 'a.png', attachment: 'med_00000000000000000000000000000000' }, /exactly one of/],
    [{ attachment: 'med_00000000000000000000000000000000' }, /No stored attachment/],
  ] as const) {
    const r = await t.call(input);
    assert.equal(r.status, 'error', JSON.stringify(input));
    assert.match(r.content, pattern, JSON.stringify(input));
  }
  assert.equal(t.seeing.requests.length, 0, 'no model call for a refused image');
});
