# skills

Reusable procedures in the agentskills.io format: `<root>/<name>/SKILL.md` (YAML frontmatter with `name` and `description`, then markdown).

- Public API: `SkillStore` (list, index, view, create, update, proposal/acceptProposal/rejectProposal, archive/unarchive, stale, problems) and `skillTools(store)` (`skill_view`, `skill_create`, `skill_update`).
- Bundled files (`references/`, `scripts/`, assets): `files(name)` lists them (no SKILL.md, PROPOSED.md, dotfiles, symlinks) and `readFile(name, file)` reads one, contained to the skill dir (relative path, no `..`, realpath check, no symlinks, regular UTF-8 text, at most `MAX_SKILL_FILE`). `skill_view {name, file?}` exposes both; reading a file does not count as a use.
- Only `index()` goes in the prompt (name + description, no counts or timestamps so the cache stays stable). Bodies load on demand through `skill_view`.
- Garnet metadata lives in a sidecar `.garnet.json`; `SKILL.md` is never touched by `view`, `archive` or usage tracking.
- Lock rule: a skill is locked if provenance is `user`, there is no sidecar, or the SKILL.md hash differs from `agentHash` (the owner edited it). The agent can never overwrite a locked skill: `update` writes `PROPOSED.md` and returns `proposed`. Only the owner accepts or rejects proposals.
- Descriptions go into every prompt (the index), so they get the memory injection heuristic (`injectionReason` from `src/memory`). `acceptProposal` refuses a proposal that would leave the skill unloadable (other name, no description, too long).
- Never delete skill directories. `archive` sets a flag; `stale` only reports.
- Names match `/^[a-z0-9][a-z0-9-]{0,63}$/` (this prevents path traversal); every path is built from a validated name.
- The frontmatter parser is deliberately minimal; unknown keys are preserved verbatim when Garnet rewrites a file. `create` takes optional extra single-line frontmatter keys (the importer keeps `metadata` and `requires` this way); `name`/`description` cannot be set through it. Malformed skills are skipped by `list()` and reported by `problems()`.
- Writes are atomic (temp + rename); directories 0700, files 0600.
- Uses `zod` in `tools.ts`: `skills` must be in the lint allowlist.
- Built-in skills (`builtin.ts`, files in `builtin/<name>/SKILL.md`): optional skills shipped with Garnet, read-only (no sidecar, usage counts, proposals or bundled files; Garnet never writes the install). `BuiltinSkills` loads them at startup and throws on a broken one (an install bug). Which are on comes from config `skills` (global plus per-scope overrides, all off by default), resolved once per session by the runtime; `index(active, shadowed)` renders the session's prompt section. `skillTools(store, { builtin })`: `skill_view` falls back to `builtin(name, sessionId)` only when `<root>` has no skill of that name (`SkillStore.has`), so a local skill always wins. The names are listed in `BUILTIN_SKILLS` in `src/config` (a test keeps the folders and the list in sync). Built-in skills must avoid em-dashes and tell the model to treat tool output as untrusted.
- Wiring (store root, injecting `index()` and the built-in index into the prompt, registering tools) happens in `src/main.ts`.
