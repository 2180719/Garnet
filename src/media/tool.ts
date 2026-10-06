// send_file: sends a workspace file to the chat the conversation is in.
import { realpath, stat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { RubyError, formatBytes, type OutboundAttachment, type ToolDefinition } from '../contracts/index.ts';
import { resolveInWorkspace } from '../policy/index.ts';
import type { MediaStore } from './store.ts';

export type ChatTarget = { channel: string; account: string; chatId: string };

export type SendFileDeps = {
  media: MediaStore;
  /** The chat this session talks to (its latest inbound chat, or a job's notify target); null for the terminal, API and dashboard. */
  target: (sessionId: string) => ChatTarget | null;
  /** Largest file a channel accepts from a bot; undefined when the channel cannot send files. */
  maxUploadBytes: (channel: string) => number | undefined;
  /** Queues the message durably; the gateway's delivery loop sends it. */
  enqueue: (target: ChatTarget, text: string, attachments: OutboundAttachment[]) => void;
};

/**
 * Behind `message.send` (ask by default, so the owner approves each file).
 * The file is copied into the media store first, so delivery (which may be
 * retried later) does not depend on the workspace file staying put.
 */
export function sendFileTool(deps: SendFileDeps): ToolDefinition<{ path: string; caption?: string | undefined }> {
  return {
    name: 'send_file',
    version: 1,
    description: 'Send a workspace file (image, PDF, audio, any document) to the owner in the chat this conversation is in. Use for files you made or found that the owner asked for.',
    input: z.object({
      path: z.string().min(1).max(1024).describe('File path relative to the workspace root.'),
      caption: z.string().max(1000).optional().describe('Short text sent with the file.'),
    }),
    capability: 'message.send',
    idempotent: false,
    targets: (i, ctx) => [resolveInWorkspace(ctx.workspace, i.path)],
    async run({ path, caption }, ctx) {
      const target = deps.target(ctx.sessionId);
      if (!target) throw new RubyError('invalid_input', 'This conversation is not in a messaging chat (it is the terminal, the API or the dashboard), so there is nowhere to send a file. Tell the owner the workspace path instead.');
      const limit = deps.maxUploadBytes(target.channel);
      if (limit === undefined) throw new RubyError('invalid_input', `The ${target.channel} channel cannot send files.`);
      const logical = resolveInWorkspace(ctx.workspace, path);
      // Re-check containment at the moment of use: a symlink may have been swapped in since targets() ran.
      const real = await realpath(logical).catch(() => null);
      if (!real) throw new RubyError('invalid_input', `"${path}" does not exist. Use list_files to find it.`);
      resolveInWorkspace(ctx.workspace, real);
      const info = await stat(real);
      if (!info.isFile()) throw new RubyError('invalid_input', `"${path}" is not a file.`);
      const max = Math.min(limit, deps.media.maxBytes);
      if (info.size > max) throw new RubyError('invalid_input', `"${path}" is ${formatBytes(info.size)}; ${target.channel} accepts at most ${formatBytes(max)} here.`);
      const ref = deps.media.put({ data: await readFile(real), name: real.split(/[\\/]/).pop() });
      const attachment: OutboundAttachment = { path: deps.media.path(ref.id), name: ref.name ?? `file${ref.id.slice(-6)}`, mimeType: ref.mimeType, kind: ref.kind, size: ref.size };
      deps.enqueue(target, caption ?? '', [attachment]);
      return { content: `Queued ${attachment.name} (${ref.mimeType}, ${formatBytes(ref.size)}) for ${target.channel}. It is delivered in order with replies.`, data: { mediaId: ref.id } };
    },
  };
}
