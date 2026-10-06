# migrate

Imports an OpenClaw or Hermes Agent install into Ruby: `ruby import <openclaw|hermes> [--from <dir>] [--apply]`.

- Public API: `planImport(source, fromDir)` (pure read), `applyImport(plan, deps)`, `formatPlan`, `formatResult`, `runImport(args, io, deps)` (the CLI body; the caller injects stores so this module never imports `main.ts`).
- Default is a dry run. `--apply` is the only thing that writes.
- Source layouts: OpenClaw = `<home>/workspace/{SOUL,IDENTITY,AGENTS,USER,MEMORY,HEARTBEAT,TOOLS}.md`, `memory/YYYY-MM-DD.md`, `skills/<name>/SKILL.md`, `openclaw.json`, `.env` (the workspace is `--from` itself if there is no `workspace/` child). Hermes = `<home>/memories/{MEMORY,USER}.md` with entries separated by a `§` line, `SOUL.md`, `skills/[category/]<name>/SKILL.md`, `config.yaml`, `.env`.
- Mapping: MEMORY.md/USER.md -> memory/user entries; SOUL.md (+IDENTITY.md, AGENTS.md if room) -> config persona (4000 chars, truncated with a note); each SKILL.md folder -> Ruby skill, provenance `user`, name normalized to `NAME_RE`; everything else (daily notes, HEARTBEAT/TOOLS/BOOTSTRAP, skill supporting files, full originals of anything truncated) is copied to `<workspace>/imported/<source>/<same relative path>`.
- Memory caps: entries over the cap are dropped oldest-first (the most recent entries are kept, because both tools append). Apply merges with existing Ruby memory: it appends entries not already present and never rewrites or removes existing lines.
- Safety rules (do not weaken): never import secrets (only env var NAMES are listed, values are never stored in a plan); never follow a symlink whose real path leaves the source dir; skip files over 1 MB and binary files; imported text is data, never executed; the memory injection heuristic is applied to imported entries; never overwrite an existing skill, persona, or archived file.
- Idempotent: a second apply adds nothing.
- Plans hold content in memory; archived copies are re-read from the source at apply time under the same containment checks.
- Testing: `node --disable-warning=ExperimentalWarning --test src/migrate/migrate.test.ts` (offline, temp dirs).
- Formats confirmed from public docs/sources vs assumed are listed in the final report of the change that added this module: `§` delimiter, `~/.hermes/skills/<category>/<name>`, OpenClaw workspace file set are confirmed; Hermes `.bundled_manifest` format and OpenClaw `openclaw.json` channel key shapes are best-effort.
