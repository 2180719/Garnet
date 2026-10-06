# tools

Tool catalog and execution.

- Public API: `ToolRegistry` (register, schemas), `ToolExecutor` (execute), built-in `fileTools`.
- Execution order: deterministic repair (`repair.ts`: exact-match-after-normalizing tool names, JSON-string arguments with fences or trailing commas; never guesses arguments) → look up → validate input with zod → compute targets → policy → approval → run with timeout and cancellation → oversized output saved as a session-scoped artifact (`read_artifact`) with a head returned. Repairs are recorded on the result and noted to the model; history is never rewritten.
- Object inputs are validated strictly: an unknown argument is an `invalid_input` error naming it and the allowed ones, never silently dropped (a schema with its own catchall keeps it). Only the top level is made strict; nested objects follow their schema.
- Tool-level failures never throw; they return `{ status: 'error', category, content }` with a message that tells the model how to correct itself. A failed, denied, timed-out or cancelled operation is never an `ok` result: a tool that ran but did not succeed returns `ToolOutput.error` (e.g. `run_command` on timeout) and keeps its output. A thrown approver becomes an `internal` error. Output limiting happens after the run, and an artifact-store failure falls back to plain truncation, so a tool that ran is never reported as failed.
- Per-call permissions: a tool may set `capabilitiesFor(input)` when what it needs depends on the input (`schedule`: nothing to list, `schedule.edit` to change, plus `exec` for a script job). The strictest verdict wins; an empty list needs no permission. `summarize(input, ctx)` replaces the generic approval text and must show everything consequential in full.
- Adding a tool: create a `ToolDefinition` under `builtin/` with a precise description, a zod input schema with `.describe()` on fields, the narrowest `capability`, `targets` for scoped checks, and tests. Register it in `src/main.ts`.
- Names are `snake_case`. Keep descriptions short; they are sent on every request.
