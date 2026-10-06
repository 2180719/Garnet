# cli

The `ruby` command (`bin.ts` → `main.ts`). `ruby jobs` (in `admin.ts`) lists config, chat-made and CLI-added jobs with their schedule and next run in words; `add`/`edit` take natural schedules (`parseWhen`); `delete`/`edit` refuse config.json jobs. Commands: `setup`, `doctor`, `init`, `chat [--fake] [--session <id>] [--plain]`, `config check|show|explain`, `sessions`, `secrets list|set|rm|import-env|keygen`, `help` (and the admin commands in `admin.ts`, `knowledge.ts`, `backup.ts`; `ruby help` lists them all).

- `main(argv, io)` returns an exit code and writes through `io`, so it is testable.
- The CLI is a surface, not logic: it calls `createRuby()` from `src/main.ts` and renders runtime events.
- Secret values are read from stdin (`Io.readSecret`; hidden on a terminal), never from argv, and never printed. `ruby secrets set NAME VALUE` is refused without echoing VALUE.

## setup and doctor

- `setup/` holds `ruby setup` (and `ruby init`, which offers it on a terminal). `wizard.ts` is the flow; every question goes through the `Prompter` interface in `prompt.ts` and every side effect through `SetupDeps`, so tests script it fully. `command.ts` parses flags and wires real dependencies (the composition root, the service module, the importer).
- Each prompt has a stable `id` that doubles as its `--flag` in non-interactive mode (`AnswerPrompter`). Adding a question: give it an id, a `default`, and an `auto` (what a script gets without the flag; optional steps must default to off), and add the flag to `FLAGS` and `SETUP_USAGE`.
- Nothing is written before the save step, except an import the owner applies (memory and skills go straight to their stores). Secrets go to the encrypted store or `<home>/env`, never config, and never into output. A new key file for the store must be outside `<home>`.
- Live checks (`checks.ts`) run only after the owner agrees, cost no tokens, and scrub the secret from every message. Tests inject `fetch`.
- The persona basics live between `<!-- ruby setup -->` markers in `config.persona`, so hand-written or imported text survives re-runs.
- `doctor.ts` is read-only and offline: it reports which secret names exist but never prints a value, never calls a provider, and probes Docker only when `exec` is allowed. Each finding has a fix. `--json` for scripts; exit 1 when anything fails.
- The installer (`install.sh` at the repo root) is POSIX sh. Check it with `sh -n install.sh`; see the root AGENTS.md.

## `ruby chat` (`chat/`)

`chat/index.ts` picks the mode: the interactive TUI when stdin and stdout are both terminals (and `TERM` is not `dumb`, and no `--plain`), otherwise a plain line chat. `main.ts` only dispatches to it.

| File | Owns |
| --- | --- |
| `text.ts` | `sanitize` for untrusted text, grapheme-aware display width (CJK, emoji, ZWJ, combining marks), ANSI-aware word wrap that carries styles across rows, truncate, token/duration formatting. Pure. |
| `theme.ts` | The DESIGN.md palette as SGR styles. Truecolor when `COLORTERM` says so, else 256 colors; `NO_COLOR` keeps bold/dim/italic but no color. Pure. |
| `markdown.ts` | Line-oriented streaming markdown: headings, emphasis, inline code, links, lists and task lists, quotes, rules, fenced code (framed, not wrapped as prose), pipe tables (held until complete, then aligned). `push` returns final rows; `pending` the provisional partial line. Pure. |
| `keys.ts` | Raw input → key events: control bytes, CSI/SS3 with xterm modifiers, Alt as ESC prefix, kitty `CSI u` and xterm modifyOtherKeys (Shift+Enter), bracketed paste, sequences split across reads. Pure. |
| `editor.ts` | Multi-line editor state and key handling (grapheme moves, word/line kills, history with the draft kept) and its wrapped layout with cursor position. Pure. |
| `commands.ts` | Slash command table, parsing (`//text` escapes a leading slash), suggestions and Tab completion (command names, `/resume` session ids), the shortcut list. Pure. |
| `render.ts` | Visual blocks: banner, user message, assistant rows, tool rows (running/done/failed in words, 3-line preview), approval prompt and choices, turn summary, footer, help, resumed transcript, session totals. Pure. |
| `screen.ts` | Terminal output with an inline live region: committed rows go to the scrollback once; the bottom rows (stream, spinner, input, footer) are redrawn in place with synchronized output. No alternate screen. |
| `app.ts` | The interactive controller: raw mode, key routing, turns and type-ahead queue, inline approvals, interrupts, resize, suspend, exit. |
| `actions.ts` | Executes slash commands against Ruby (shared by both modes). Results render at a given width, so they redraw cleanly after a resize. |
| `plain.ts` | Line mode for pipes: replies on stdout, prompts/tools/status on stderr, no escape sequences. |
| `history.ts` | Input history in `<RUBY_HOME>/chat_history.jsonl` (mode 0600, last 1000 entries; entries starting with a space are not saved). |

Behavior to preserve:

- Keys: Enter sends; Shift+Enter, Alt+Enter, Ctrl+J or a trailing `\` add a line; Up/Down browse history; Tab completes; Esc or Ctrl+C interrupts a running turn (a second Ctrl+C while interrupting quits); at the prompt Ctrl+C clears the input, and twice on an empty line exits; Ctrl+D on an empty line exits; Ctrl+L clears; Ctrl+Z suspends (stops the process group so `npm run` and the shell see it).
- Messages typed while a turn runs are queued and sent in order; an interrupt drops the queue.
- Approvals: `y` once, `a` always for the rest of this chat (for `exec`, only the exact same command), `n`/Esc deny. The full operation summary is printed (commands are never truncated). "Always" lives in memory for the chat process and session only; the policy in `config.json` is never changed.
- Slash commands exist only when backed by real behavior: `/help`, `/new`, `/sessions`, `/resume <id>`, `/model` (read-only: the model is fixed per process), `/usage`, `/compact` (`Agent.compact`), `/expand [n]`, `/clear`, `/exit`.
- Model text, tool calls and results, approval summaries and errors are untrusted: pass them through `sanitize` (`text.ts`) before styling, so escape sequences are shown (`␛`) and never reach the terminal. The approval prompt must show exactly what will run.
- Status is always spelled out (`✓ done`, `■ interrupted`, `✗ failed (timeout)`), never shown by color alone. Unknown usage is `?`, never 0.
- Resize: wider terminals just use the new width; narrower ones are cleared and the transcript is re-rendered from width-independent blocks, because a reflowing terminal pushes old live rows into scrollback where they cannot be erased.
- Exit always restores the terminal (raw mode off, bracketed paste and the kitty keyboard flag popped, cursor shown), including on SIGTERM/SIGHUP.

Testing: the pure modules have unit tests; `chat/chat.test.ts` drives the whole chat through a fake TTY and `test/vt.ts` (a minimal virtual terminal), and checks the plain mode. To look at it by hand: `npm run ruby -- chat --fake`.
