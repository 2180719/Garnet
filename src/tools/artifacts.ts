import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { newId, GarnetError, type ToolDefinition } from '../contracts/index.ts';

const ID = /^art_[a-z0-9]+$/;

/**
 * Keeps large tool outputs out of the context window. The model gets a head
 * and a handle and reads more on demand. Artifacts are scoped to a session.
 */
export class ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  save(sessionId: string, content: string): string {
    const id = newId('art');
    writeFileSync(join(this.root, `${id}.json`), JSON.stringify({ sessionId, content }), { mode: 0o600 });
    return id;
  }

  read(sessionId: string, id: string): string {
    const file = join(this.root, `${id}.json`);
    if (!ID.test(id) || !existsSync(file)) throw new GarnetError('invalid_input', `No artifact "${id}".`);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { sessionId: string; content: string };
    if (data.sessionId !== sessionId) throw new GarnetError('denied', `Artifact "${id}" belongs to another conversation.`);
    return data.content;
  }
}

export function readArtifactTool(store: ArtifactStore): ToolDefinition<{ id: string; offset: number; limit: number }> {
  return {
    name: 'read_artifact',
    version: 1,
    description: 'Read part of a large tool output that was saved as an artifact. Returns characters [offset, offset+limit).',
    input: z.object({
      id: z.string().describe('Artifact ID, e.g. art_xxx.'),
      offset: z.number().int().min(0).default(0).describe('Character offset to start at.'),
      limit: z.number().int().min(1).max(20_000).default(10_000).describe('Number of characters to return.'),
    }),
    capability: 'fs.read',
    idempotent: true,
    maxOutputChars: 21_000,
    async run({ id, offset, limit }, ctx) {
      const content = store.read(ctx.sessionId, id);
      const end = Math.min(content.length, offset + limit);
      const more = end < content.length ? `\n[characters ${offset}-${end} of ${content.length}; use offset=${end} for more]` : '';
      return { content: content.slice(offset, end) + more };
    },
  };
}
