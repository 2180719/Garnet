# skills

Reusable procedures in the agentskills.io format: `<root>/<name>/SKILL.md` (YAML frontmatter with `name` and `description`, then markdown).

- Public API: `SkillStore` (list, index, view, create, update, proposal/acceptProposal/rejectProposal, archive/unarchive, stale, problems) and `skillTools(store)` (`skill_view`, `skill_create`, `skill_update`).
- Only `index()` goes in the prompt (name + description, no counts or timestamps so the cache stays stable). Bodies load on demand through `skill_view`.
- Ruby metadata lives in a sidecar `.ruby.json`; `SKILL.md` is never touched by `view`, `archive` or usage tracking.
- Lock rule: a skill is locked if provenance is `user`, there is no sidecar, or the SKILL.md hash differs from `agentHash` (the owner edited it). The agent can never overwrite a locked skill: `update` writes `PROPOSED.md` and returns `proposed`. Only the owner accepts or rejects proposals.
- Never delete skill directories. `archive` sets a flag; `stale` only reports.
- Names match `/^[a-z0-9][a-z0-9-]{0,63}$/` (this prevents path traversal); every path is built from a validated name.
- The frontmatter parser is deliberately minimal; unknown keys are preserved verbatim when Ruby rewrites a file. Malformed skills are skipped by `list()` and reported by `problems()`.
- Writes are atomic (temp + rename); directories 0700, files 0600.
- Uses `zod` in `tools.ts`: `skills` must be in the lint allowlist.
- Wiring (store root, injecting `index()` into the prompt, registering tools) happens in `src/main.ts`.
