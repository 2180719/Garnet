# memory

Bounded, versioned, file-backed memory per namespace.

- Public API: `MemoryStore` (read, snapshot, add, replace, remove, write, history, rollback), `memoryTool(store)`, `injectionReason(text)` (the heuristic below; skills and the importer use it too).
- Layout: `<root>/<namespace>/MEMORY.md` (agent notes, cap 2200 chars) and `USER.md` (owner profile, cap 1400), plus `.history/<FILE>.<ISO timestamp>.md` snapshots (default 50 per file). Caps and history limit are constructor options.
- Format: one entry per line, starting with `- `. Plain markdown a human can edit; every non-empty line counts toward the cap, only `- ` lines are matchable by replace/remove.
- Rules:
  - Namespaces match `/^[a-z0-9-]{1,40}$/`; this is also the path-traversal guard. Never build paths from other input.
  - Writes are atomic (temp + rename), dirs 0700, files 0600, and always version the previous content first.
  - Over-cap writes fail with an `invalid_input` error that says how far over and tells the model to consolidate. Duplicates, entries over 500 chars and entries matching the small injection heuristic (`<system`, `</`, "ignore previous instructions") are rejected. The heuristic is hygiene, not a security boundary.
  - `snapshot()` is deterministic for identical contents and has no timestamps: the prompt builder should take it once at session start (frozen), so mid-session writes never break prompt caching.
  - The `memory` tool uses `ctx.memoryNamespace`; it never accepts a namespace from the model.
- Testing: `node --disable-warning=ExperimentalWarning --test src/memory/memory.test.ts` (offline, temp dirs, injectable `now`).
- Lint: this module imports `zod`; it must be in the lint zod allowlist.
