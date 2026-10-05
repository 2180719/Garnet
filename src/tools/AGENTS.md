# tools

Tool catalog and execution.

- Public API: `ToolRegistry` (register, schemas), `ToolExecutor` (execute), built-in `fileTools`.
- Execution order: deterministic repair (`repair.ts`: exact-match-after-normalizing tool names, JSON-string arguments with fences or trailing commas; never guesses arguments) → look up → validate input with zod → compute targets → policy → approval → run with timeout and cancellation → oversized output saved as a session-scoped artifact (`read_artifact`) with a head returned. Repairs are recorded on the result and noted to the model; history is never rewritten.
- Tool-level failures never throw; they return `{ status: 'error', category, content }` with a message that tells the model how to correct itself.
- Adding a tool: create a `ToolDefinition` under `builtin/` with a precise description, a zod input schema with `.describe()` on fields, the narrowest `capability`, `targets` for scoped checks, and tests. Register it in `src/main.ts`.
- Names are `snake_case`. Keep descriptions short; they are sent on every request.
