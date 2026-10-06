# cli

The `ruby` command (`bin.ts` → `main.ts`). Commands: `init`, `chat [--fake] [--session]`, `config check|show|explain`, `sessions`, `help`.

- `main(argv, io)` returns an exit code and writes through `io`, so it is testable.
- The CLI is a surface, not logic: it calls `createRuby()` from `src/main.ts` and renders runtime events.
- Interactive approvals use the terminal; Ctrl+C cancels a running task; at the prompt it exits.
