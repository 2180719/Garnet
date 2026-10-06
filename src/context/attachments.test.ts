import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttachmentBlock, AttachmentRef, ChatMessage, MediaCapabilities } from '../contracts/index.ts';
import { prepareAttachments } from './index.ts';

const VISION: MediaCapabilities = { images: true, pdf: true, maxImageBytes: 1000, maxPdfBytes: 1000 };
const ref = (id: string, over: Partial<AttachmentRef> = {}): AttachmentRef => ({ id, kind: 'image', mimeType: 'image/png', size: 10, name: `${id}.png`, ...over });
const att = (r: AttachmentRef, extra: Partial<AttachmentBlock> = {}): AttachmentBlock => ({ type: 'attachment', attachment: r, ...extra });
const user = (...content: ChatMessage['content']): ChatMessage => ({ role: 'user', content });
const load = (r: AttachmentRef) => (r.id === 'gone' ? null : new TextEncoder().encode(`bytes:${r.id}`));
const b64 = (s: string) => Buffer.from(s).toString('base64');

test('native images get their bytes, labelled; the input is not changed', () => {
  const messages = [user({ type: 'text', text: 'look' }, att(ref('a')))];
  const before = structuredClone(messages);
  const out = prepareAttachments(messages, { media: VISION, maxInContext: 8, load });
  assert.deepEqual(messages, before);
  const c = out[0]!.content;
  assert.equal(c.length, 3);
  assert.deepEqual(c[0], { type: 'text', text: 'look' });
  assert.match((c[1] as { text: string }).text, /^\[Image attached: "a.png", image\/png, 10 B; id a\]$/);
  assert.deepEqual(c[2], { ...att(ref('a')), data: b64('bytes:a') });
});

test('a text-only model gets a clear note instead of the image', () => {
  const out = prepareAttachments([user(att(ref('a')))], { media: undefined, maxInContext: 8, load });
  assert.deepEqual(out[0]!.content, [{ type: 'text', text: '[Image attached: "a.png", image/png, 10 B; id a]\n(The current model cannot view images.)' }]);
});

test('only the newest images are sent as bytes; older ones become placeholders', () => {
  const messages: ChatMessage[] = [
    user(att(ref('old1')), att(ref('old2'))),
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    user(att(ref('new1'))),
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    user({ type: 'text', text: 'and this' }, att(ref('new2'))),
  ];
  const out = prepareAttachments(messages, { media: VISION, maxInContext: 2, load });
  const sent = out.flatMap((m) => m.content).filter((b) => b.type === 'attachment').map((b) => (b as AttachmentBlock).attachment.id);
  assert.deepEqual(sent, ['new1', 'new2']);
  const placeholders = out[0]!.content.map((b) => (b as { text: string }).text);
  assert.equal(placeholders.length, 2);
  for (const p of placeholders) assert.match(p, /Not shown again here, to save context/);
  assert.equal(out[1], messages[1], 'messages without attachments are passed through');
});

test('missing files, unsupported formats and oversize images are described, not sent', () => {
  const out = prepareAttachments(
    [user(att(ref('gone')), att(ref('h', { mimeType: 'image/heic' })), att(ref('big', { size: 5000 })))],
    { media: VISION, maxInContext: 8, load },
  );
  const texts = out[0]!.content.map((b) => (b as { text: string }).text);
  assert.match(texts[0]!, /The stored file is no longer available/);
  assert.match(texts[1]!, /image\/heic images cannot be shown/);
  assert.match(texts[2]!, /Too large to show the model/);
});

test('PDFs go native when supported; transcripts and extracted text stay text', () => {
  const pdf = ref('p', { kind: 'document', mimeType: 'application/pdf', name: 'r.pdf' });
  const native = prepareAttachments([user(att(pdf))], { media: VISION, maxInContext: 8, load });
  assert.equal((native[0]!.content[1] as AttachmentBlock).data, b64('bytes:p'));
  const textOnly = prepareAttachments([user(att(pdf, { text: 'Extracted text:\nhello' }))], { media: { ...VISION, pdf: false }, maxInContext: 8, load });
  assert.deepEqual(textOnly[0]!.content, [{ type: 'text', text: '[Document attached: "r.pdf", application/pdf, 10 B; id p]\nExtracted text:\nhello' }]);
  const voice = ref('v', { kind: 'audio', mimeType: 'audio/ogg', name: 'voice.ogg', durationSec: 4 });
  const heard = prepareAttachments([user(att(voice, { text: 'Transcript:\nbuy milk' }))], { media: VISION, maxInContext: 8, load });
  assert.deepEqual(heard[0]!.content, [{ type: 'text', text: '[Audio attached: "voice.ogg", audio/ogg, 10 B, 4s; id v]\nTranscript:\nbuy milk' }]);
});

test('a data field that leaked into stored history is never trusted', () => {
  const out = prepareAttachments([user({ ...att(ref('a')), data: 'Zm9yZ2Vk' })], { media: undefined, maxInContext: 8, load });
  assert.equal(out[0]!.content.length, 1);
  assert.equal(out[0]!.content[0]!.type, 'text');
});
