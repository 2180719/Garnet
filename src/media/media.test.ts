import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tempDir } from '../../test/helpers.ts';
import type { AttachmentBlock, ContentBlock, MediaCapabilities, OutboundAttachment, ToolContext } from '../contracts/index.ts';
import { defaultConfig } from '../config/index.ts';
import { Policy } from '../policy/index.ts';
import { ToolExecutor, ToolRegistry } from '../tools/index.ts';
import { CommandTranscriber, MediaIngest, MediaStore, OpenAITranscriber, cleanName, detectMime, sendFileTool, unreadableReply, type Transcriber } from './index.ts';

const FIX = join(import.meta.dirname, '..', '..', 'test', 'media');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIX, name)));
const VISION: MediaCapabilities = { images: true, pdf: true, maxImageBytes: 5_000_000, maxPdfBytes: 20_000_000 };
const TEXT_ONLY: MediaCapabilities = { images: false, pdf: false, maxImageBytes: 0, maxPdfBytes: 0 };
const ctx = { sessionId: 'ses_1', signal: new AbortController().signal };
const only = (blocks: ContentBlock[]) => {
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'attachment');
  return blocks[0] as AttachmentBlock;
};

test('types come from the bytes, not the claim or the name', () => {
  assert.equal(detectMime(fixture('pixel.png'), 'application/pdf', 'x.pdf'), 'image/png');
  assert.equal(detectMime(fixture('hello.pdf')), 'application/pdf');
  assert.equal(detectMime(fixture('voice.ogg'), 'audio/ogg'), 'audio/ogg');
  assert.equal(detectMime(fixture('fake.jpg'), 'image/jpeg', 'fake.jpg'), 'text/plain', 'a claimed image without the signature is not an image');
  assert.equal(detectMime(new Uint8Array([0, 1, 2, 3, 0xfe]), 'image/png'), 'application/octet-stream');
  assert.equal(detectMime(fixture('notes.md'), undefined, 'notes.md'), 'text/markdown');
  assert.equal(detectMime(fixture('table.csv'), 'text/csv'), 'text/csv');
  assert.equal(detectMime(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0]), 'text/plain', 'run.txt'), 'application/octet-stream', 'binary claiming to be text');
  assert.equal(detectMime(new TextEncoder().encode('{"a":1}'), 'application/json'), 'application/json');
  assert.equal(detectMime(new TextEncoder().encode('héllo wörld'), undefined), 'text/plain');
});

test('names are display names only', () => {
  assert.equal(cleanName('../../etc/passwd'), 'passwd');
  assert.equal(cleanName('C:\\Users\\x\\report.pdf'), 'report.pdf');
  assert.equal(cleanName('evil\u202Egnp.exe'), 'evilgnp.exe');
  assert.equal(cleanName('a'.repeat(300)).length, 120);
});

test('the store is content-addressed, private, size-limited and never trusts ids', () => {
  const store = new MediaStore(join(tempDir(), 'media'), 1024);
  const a = store.put({ data: fixture('pixel.png'), name: 'dir/pixel.png', mimeType: 'image/jpeg' });
  assert.match(a.id, /^med_[a-f0-9]{32}$/);
  assert.deepEqual({ kind: a.kind, mimeType: a.mimeType, name: a.name, size: a.size }, { kind: 'image', mimeType: 'image/png', name: 'pixel.png', size: 69 });
  assert.equal(store.put({ data: fixture('pixel.png') }).id, a.id, 'same bytes, same id');
  assert.equal(statSync(store.path(a.id)).mode & 0o777, 0o600);
  assert.deepEqual(new Uint8Array(store.read(a.id)!), fixture('pixel.png'));
  assert.throws(() => store.put({ data: new Uint8Array(2048) }), /too large/);
  assert.throws(() => store.put({ data: new Uint8Array(0) }), /empty/);
  assert.throws(() => store.path('../../config.json'), /Not a media id/);
  assert.equal(store.read('med_' + '0'.repeat(32)), null);
});

function ingest(over: Partial<ConstructorParameters<typeof MediaIngest>[0]> = {}) {
  const store = new MediaStore(join(tempDir(), 'media'), 1_000_000);
  const saved: string[] = [];
  const media = new MediaIngest({
    store,
    maxTextChars: 1000,
    modelMedia: VISION,
    saveText: (_s, text) => {
      saved.push(text);
      return 'art_full';
    },
    ...over,
  });
  return { media, store, saved };
}

test('images and native PDFs are stored as references with no derived text', async () => {
  const { media } = ingest();
  const img = only(await media.ingest([{ data: fixture('pixel.png'), name: 'pixel.png' }], ctx));
  assert.equal(img.attachment.kind, 'image');
  assert.equal(img.text, undefined);
  assert.equal(img.data, undefined, 'bytes never go into the block');
  const pdf = only(await media.ingest([{ data: fixture('hello.pdf'), name: 'hello.pdf' }], ctx));
  assert.equal(pdf.text, undefined);
  assert.equal(pdf.note, undefined);
});

test('text files are inlined; long ones are cut and saved whole as an artifact', async () => {
  const { media, saved } = ingest();
  const md = only(await media.ingest([{ data: fixture('notes.md'), name: 'notes.md' }], ctx));
  assert.equal(md.attachment.kind, 'document');
  assert.match(md.text!, /- milk/);
  const long = 'x'.repeat(1500);
  const cut = only(await media.ingest([{ data: new TextEncoder().encode(long), name: 'big.txt' }], ctx));
  assert.equal(cut.text!.length, 1000);
  assert.match(cut.note!, /first 1000 of 1500 characters; the full text is artifact art_full/);
  assert.deepEqual(saved, [long]);
});

test('voice notes are transcribed, or say honestly why not', async () => {
  const calls: string[] = [];
  const ok: Transcriber = { label: 't', transcribe: async (f) => (calls.push(f.mimeType), '  buy milk  ') };
  const voice = { data: fixture('voice.ogg'), name: 'voice.ogg', mimeType: 'audio/ogg', durationSec: 3 };
  const heard = only(await ingest({ transcriber: ok }).media.ingest([voice], ctx));
  assert.equal(heard.text, 'Transcript:\nbuy milk');
  assert.equal(heard.attachment.durationSec, 3);
  assert.deepEqual(calls, ['audio/ogg']);

  const none = only(await ingest().media.ingest([voice], ctx));
  assert.match(none.note!, /No transcription backend/);
  const failing: Transcriber = { label: 't', transcribe: async () => Promise.reject(new Error('HTTP 500')) };
  const failed = only(await ingest({ transcriber: failing }).media.ingest([voice], ctx));
  assert.match(failed.note!, /Transcription failed: HTTP 500/);
});

test('PDFs for a text-only model: extracted with the configured command, or a note', async () => {
  const pdf = { data: fixture('hello.pdf'), name: 'hello.pdf' };
  const noTool = only(await ingest({ modelMedia: TEXT_ONLY }).media.ingest([pdf], ctx));
  assert.match(noTool.note!, /no PDF text extractor/);
  // A stand-in extractor (node) proves argv substitution and stdout capture without poppler.
  const script = 'process.stdout.write("pages of " + require("fs").readFileSync(process.argv[1]).subarray(0, 8).toString())';
  const extracted = only(await ingest({ modelMedia: TEXT_ONLY, pdfText: { argv: [process.execPath, '-e', script, '{input}'], timeoutMs: 10_000 } }).media.ingest([pdf], ctx));
  assert.equal(extracted.text, 'Extracted text:\npages of %PDF-1.4');
});

test('pdftotext, when installed, extracts the fixture', { skip: !hasCommand('pdftotext') && 'pdftotext not installed' }, async () => {
  const { media } = ingest({ modelMedia: TEXT_ONLY, pdfText: { argv: ['pdftotext', '-layout', '{input}', '-'], timeoutMs: 10_000 } });
  const b = only(await media.ingest([{ data: fixture('hello.pdf'), name: 'hello.pdf' }], ctx));
  assert.match(b.text!, /Hello PDF/);
});

test('local commands: no shell, minimal environment, timeouts, missing binaries', async () => {
  process.env.GARNET_TEST_SECRET = 'sekrit';
  try {
    const env = new CommandTranscriber([process.execPath, '-e', 'process.stdout.write(String(process.env.GARNET_TEST_SECRET) + " " + process.argv[1].endsWith(".ogg"))'], 10_000);
    assert.equal(await env.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), 'undefined true', 'keys in the environment are not passed on; the temp file has a matching extension');
  } finally {
    delete process.env.GARNET_TEST_SECRET;
  }
  const whisper = new CommandTranscriber([process.execPath, '-e', 'console.log("[00:00:00.000 --> 00:00:02.000]  Hello there.\\n[00:00:02.000 --> 00:00:03.500]  Bye.")'], 10_000);
  assert.equal(await whisper.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), 'Hello there.\nBye.');
  const slow = new CommandTranscriber([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], 200);
  await assert.rejects(slow.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), /did not finish within/);
  const missing = new CommandTranscriber(['/nonexistent/whisper', '{input}'], 1000);
  await assert.rejects(missing.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), /Command not found/);
  const failing = new CommandTranscriber([process.execPath, '-e', 'console.error("model file missing"); process.exit(2)'], 10_000);
  await assert.rejects(failing.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), /model file missing/);
});

test('OpenAI-compatible transcription sends multipart with a matching file name and redacts the key', async () => {
  const seen: { url: string; auth: string | null; form: FormData }[] = [];
  const t = new OpenAITranscriber({
    baseUrl: 'https://api.groq.com/openai/v1/',
    apiKey: 'gsk_secret',
    model: 'whisper-large-v3-turbo',
    language: 'en',
    timeoutMs: 5000,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), form: init.body as FormData });
      return new Response(JSON.stringify({ text: ' hello ' }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(await t.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), 'hello');
  const s = seen[0]!;
  assert.equal(s.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(s.auth, 'Bearer gsk_secret');
  const file = s.form.get('file') as File;
  assert.equal(file.name, 'audio.ogg');
  assert.equal(file.type, 'audio/ogg');
  assert.equal(file.size, fixture('voice.ogg').byteLength);
  assert.equal(s.form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(s.form.get('response_format'), 'json');
  assert.equal(s.form.get('language'), 'en');

  const bad = new OpenAITranscriber({
    baseUrl: 'http://127.0.0.1:8080',
    path: '/inference',
    apiKey: 'gsk_secret',
    model: 'm',
    timeoutMs: 5000,
    fetch: (async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key gsk_secret' } }), { status: 401 })) as unknown as typeof fetch,
  });
  await assert.rejects(bad.transcribe({ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }, ctx.signal), (e: Error) => {
    assert.match(e.message, /HTTP 401 \(check the transcription API key\): Invalid API Key <key>/);
    assert.doesNotMatch(e.message, /gsk_secret/);
    return true;
  });
});

test('unreadable messages get an honest reply instead of a model call', async () => {
  const { media } = ingest({ modelMedia: TEXT_ONLY });
  const voice = await media.ingest([{ data: fixture('voice.ogg'), mimeType: 'audio/ogg' }], ctx);
  assert.match(unreadableReply(voice, TEXT_ONLY)!, /can't listen to audio: no transcription backend is set up \(media.transcription/);
  const image = await media.ingest([{ data: fixture('pixel.png') }], ctx);
  assert.match(unreadableReply(image, TEXT_ONLY)!, /can't view images \(if it can, set model.vision/);
  assert.equal(unreadableReply(image, VISION), null, 'a vision model reads it');
  assert.equal(unreadableReply([{ type: 'text', text: 'what is this?' }, ...image], TEXT_ONLY), null, 'with text the model answers (and says it cannot see it)');
  const md = await media.ingest([{ data: fixture('notes.md'), name: 'notes.md' }], ctx);
  assert.equal(unreadableReply(md, TEXT_ONLY), null);
  const failed = await media.ingest([{ name: 'big.mov', kind: 'video', error: 'it is 80.0 MB, over the limit' }], ctx);
  assert.deepEqual(failed, [{ type: 'text', text: '[Not received: video "big.mov": it is 80.0 MB, over the limit]' }]);
  assert.match(unreadableReply(failed, VISION)!, /I couldn't receive your video "big.mov": it is 80.0 MB/);
  const zip = await media.ingest([{ data: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), name: 'a.zip' }], ctx);
  assert.match(unreadableReply(zip, VISION)!, /can't read application\/zip files/);
});

function sendFileSetup(target: { channel: string; account: string; chatId: string } | null = { channel: 'telegram', account: 'default', chatId: '42' }) {
  const workspace = tempDir();
  const store = new MediaStore(join(tempDir(), 'media'), 1_000_000);
  const queued: { text: string; attachments: OutboundAttachment[] }[] = [];
  const tool = sendFileTool({
    media: store,
    target: () => target,
    maxUploadBytes: (c) => ({ telegram: 50 * 1024 * 1024, tiny: 10 } as Record<string, number>)[c],
    enqueue: (_t, text, attachments) => void queued.push({ text, attachments }),
  });
  const tctx: ToolContext = { sessionId: 'ses_1', callId: 'c1', workspace, memoryNamespace: 'default', signal: new AbortController().signal };
  return { tool, workspace, store, queued, tctx };
}

test('send_file queues a copy of a workspace file for the conversation chat', async () => {
  const { tool, workspace, store, queued, tctx } = sendFileSetup();
  assert.equal(tool.capability, 'message.send');
  mkdirSync(join(workspace, 'out'));
  writeFileSync(join(workspace, 'out', 'chart.png'), fixture('pixel.png'));
  const out = await tool.run({ path: 'out/chart.png', caption: 'Here it is' }, tctx);
  assert.match(out.content, /Queued chart.png \(image\/png, 69 B\) for telegram/);
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.text, 'Here it is');
  const a = queued[0]!.attachments[0]!;
  assert.deepEqual({ name: a.name, mimeType: a.mimeType, kind: a.kind, size: a.size }, { name: 'chart.png', mimeType: 'image/png', kind: 'image', size: 69 });
  assert.ok(a.path.startsWith(store.root), 'delivered from the media store, not the workspace');
  assert.deepEqual(tool.targets!({ path: 'out/chart.png' }, tctx), [join(workspace, 'out', 'chart.png')]);
});

test('send_file refuses paths outside the workspace, missing files, oversize files and chat-less sessions', async () => {
  const { tool, workspace, tctx } = sendFileSetup();
  assert.throws(() => tool.targets!({ path: '../x' }, tctx), /outside the workspace/);
  const outside = tempDir();
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
  await assert.rejects(tool.run({ path: 'link.txt' }, tctx), /outside the workspace/);
  await assert.rejects(tool.run({ path: 'nope.png' }, tctx), /does not exist/);
  mkdirSync(join(workspace, 'dir'));
  await assert.rejects(tool.run({ path: 'dir' }, tctx), /not a file/);
  writeFileSync(join(workspace, 'a.txt'), 'hello world, this is longer than ten bytes');
  const tiny = sendFileSetup({ channel: 'tiny', account: 'default', chatId: '1' });
  writeFileSync(join(tiny.workspace, 'a.txt'), 'hello world, this is longer than ten bytes');
  await assert.rejects(tiny.tool.run({ path: 'a.txt' }, tiny.tctx), /tiny accepts at most 10 B/);
  const none = sendFileSetup(null);
  writeFileSync(join(none.workspace, 'a.txt'), 'x');
  await assert.rejects(none.tool.run({ path: 'a.txt' }, none.tctx), /not in a messaging chat/);
});

function hasCommand(name: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('send_file goes through containment: allowed when clean, needs approval once the session read untrusted content', async () => {
  const { tool, workspace, queued, tctx } = sendFileSetup();
  writeFileSync(join(workspace, 'a.png'), fixture('pixel.png'));
  const registry = new ToolRegistry();
  registry.register(tool);
  const asked: string[] = [];
  const executor = new ToolExecutor({
    registry,
    policy: new Policy({ ...defaultConfig().permissions, 'message.send': 'allow' }),
    approver: async (r) => (asked.push(r.summary), 'denied'),
  });
  const call = { type: 'tool_call' as const, id: 'c1', name: 'send_file', input: { path: 'a.png' } };
  const clean = await executor.execute(call, tctx);
  assert.equal(clean.status, 'ok');
  assert.equal(queued.length, 1);
  const taint = { sources: ['web_fetch https://evil.example/'], ownerUrls: new Set<string>(), seenUrls: new Set<string>() };
  const tainted = await executor.execute({ ...call, id: 'c2' }, { ...tctx, taint });
  assert.equal(tainted.status, 'error');
  assert.equal(queued.length, 1, 'nothing queued without approval');
  assert.match(asked[0]!, /send_file[\s\S]*untrusted content/);
});
