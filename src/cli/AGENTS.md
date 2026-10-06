# cli

The `ruby` command (`bin.ts` → `main.ts`). Commands: `setup`, `doctor`, `init`, `chat [--fake] [--session]`, `config check|show|explain`, `sessions`, `secrets list|set|rm|import-env|keygen`, `help` (and the admin commands in `admin.ts`, `knowledge.ts`, `backup.ts`; `ruby help` lists them all).

- `main(argv, io)` returns an exit code and writes through `io`, so it is testable.
- The CLI is a surface, not logic: it calls `createRuby()` from `src/main.ts` and renders runtime events.
- Interactive approvals use the terminal; Ctrl+C cancels a running task; at the prompt it exits.
- Secret values are read from stdin (`Io.readSecret`; hidden on a terminal), never from argv, and never printed. `ruby secrets set NAME VALUE` is refused without echoing VALUE.

## setup and doctor

- `setup/` holds `ruby setup` (and `ruby init`, which offers it on a terminal). `wizard.ts` is the flow; every question goes through the `Prompter` interface in `prompt.ts` and every side effect through `SetupDeps`, so tests script it fully. `command.ts` parses flags and wires real dependencies (the composition root, the service module, the importer).
- Each prompt has a stable `id` that doubles as its `--flag` in non-interactive mode (`AnswerPrompter`). Adding a question: give it an id, a `default`, and an `auto` (what a script gets without the flag; optional steps must default to off), and add the flag to `FLAGS` and `SETUP_USAGE`.
- Nothing is written before the save step, except an import the owner applies (memory and skills go straight to their stores). Secrets go to the encrypted store or `<home>/env`, never config, and never into output. A new key file for the store must be outside `<home>`.
- Live checks (`checks.ts`) run only after the owner agrees, cost no tokens, and scrub the secret from every message. Tests inject `fetch`.
- The persona basics live between `<!-- ruby setup -->` markers in `config.persona`, so hand-written or imported text survives re-runs.
- `doctor.ts` is read-only and offline: it reports which secret names exist but never prints a value, never calls a provider, and probes Docker only when `exec` is allowed. Each finding has a fix. `--json` for scripts; exit 1 when anything fails.
- The installer (`install.sh` at the repo root) is POSIX sh. Check it with `sh -n install.sh`; see the root AGENTS.md.
