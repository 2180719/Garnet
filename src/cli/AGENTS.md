# cli

The `ruby` command (`bin.ts` → `main.ts`). Commands: `init`, `chat [--fake] [--session]`, `config check|show|explain`, `sessions`, `secrets list|set|rm|import-env|keygen`, `help` (and the admin commands in `admin.ts`, `knowledge.ts`, `backup.ts`; `ruby help` lists them all).

- `main(argv, io)` returns an exit code and writes through `io`, so it is testable.
- The CLI is a surface, not logic: it calls `createRuby()` from `src/main.ts` and renders runtime events.
- Interactive approvals use the terminal; Ctrl+C cancels a running task; at the prompt it exits.
- Secret values are read from stdin (`Io.readSecret`; hidden on a terminal), never from argv, and never printed. `ruby secrets set NAME VALUE` is refused without echoing VALUE.
