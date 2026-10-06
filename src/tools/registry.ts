import { z } from 'zod';
import { GarnetError, type ToolDefinition, type ToolSchema } from '../contracts/index.ts';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Catalog of available tools. Tools are registered once at startup in main.ts. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly schemaCache = new Map<string, ToolSchema>();

  register(tool: ToolDefinition): this {
    if (!NAME.test(tool.name)) throw new GarnetError('internal', `Invalid tool name "${tool.name}"`);
    if (this.tools.has(tool.name)) throw new GarnetError('internal', `Tool "${tool.name}" registered twice`);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Model-facing schemas, in a stable order so the prompt prefix stays cacheable. */
  schemas(names: string[] = this.names()): ToolSchema[] {
    return [...names].sort().map((name) => {
      const cached = this.schemaCache.get(name);
      if (cached) return cached;
      const tool = this.tools.get(name);
      if (!tool) throw new GarnetError('internal', `Unknown tool "${name}"`);
      const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
      const schema: ToolSchema = { name, description: tool.description, inputSchema };
      this.schemaCache.set(name, schema);
      return schema;
    });
  }
}
