# Changelog

## Unreleased

### Installation and onboarding
- One-line installer: `curl -fsSL https://raw.githubusercontent.com/2180719/Ruby/main/install.sh | sh`. POSIX sh, no sudo, idempotent: checks Node.js 22.18+ and `node:sqlite` (with install advice), clones or fast-forwards into `~/.local/share/ruby` (refusing to touch local changes), runs `npm ci --omit=dev`, writes a `ruby` shim in `~/.local/bin` (never over a file it did not write), warns when PATH lacks it or another `ruby` (the language) shadows it, then starts `ruby setup` on a terminal. `--name` installs under another command name.
- `ruby setup`: a guided, re-runnable wizard for the model (Anthropic, OpenRouter, local servers, any OpenAI-compatible API, or the demo model), the key (hidden input; encrypted store with a new key file outside `~/.ruby`, the env file, or your own environment), persona basics, Telegram/Discord/Signal, importing from OpenClaw or Hermes (preview first), the background service, and pairing your own account. Live key checks run only with consent and cost no tokens. On a re-run it shows the current setup and a menu. `ruby setup -y` takes everything from flags (`--key-stdin` for the key) for scripts and CI.
- `ruby doctor [--json]`: checks Node.js, `node:sqlite`, which `ruby` is on PATH, `RUBY_HOME` permissions, config validity, the env file mode, the secret store, that the model key and channel tokens resolve, the Docker sandbox (when commands are allowed) and the service, with a fix for each problem. It warns when an OpenAI-compatible server would be sent `ANTHROPIC_API_KEY`.
- `ruby init` offers `ruby setup` on a terminal (`--defaults` keeps the old behavior).
- `setInEnvFile` (config) and `restartService` (service).

### Terminal chat
- `ruby chat` is now a real terminal UI, still with no dependencies: replies stream in as rendered markdown (headings, emphasis, inline code, lists, quotes, framed code blocks, aligned tables), tool calls show as compact rows with a live spinner, a status in words (`✓`, `✗ denied`, `✗ failed (timeout)`) and a 3-line output preview (`/expand` shows all of it), and each turn ends with its time, tool calls and token usage (unknown shown as `?`).
- Inline approvals: `y` once, `a` always for the rest of this chat (for commands, only the identical command), `n` deny. The full operation is printed first.
- Input: a multi-line editor (Shift+Enter, Alt+Enter, Ctrl+J or a trailing `\`), bracketed paste, Unicode-aware editing, readline-style keys, and history saved in `<RUBY_HOME>/chat_history.jsonl` (mode 0600; start a message with a space to keep it out). Messages typed while Ruby works are queued.
- Esc or Ctrl+C interrupts the running turn without leaving; Ctrl+C twice or Ctrl+D on an empty line exits; Ctrl+Z suspends.
- Slash commands with suggestions and Tab completion: `/help`, `/new`, `/sessions`, `/resume <id>`, `/model`, `/usage`, `/compact`, `/expand [n]`, `/clear`, `/exit`. `--session` and `/resume` show the recent turns of the session.
- A footer shows the model, session, context use and session tokens. Narrow terminals and resizes are handled (a narrower window is redrawn cleanly); `NO_COLOR` and `TERM=dumb` are respected.
- Without a terminal (pipes) or with `--plain`, chat is line-based: replies on stdout, everything else on stderr, no escape sequences.
- Runtime: `Agent.compact(sessionId)` compacts on request.

### Phase 6: hardening
- Encrypted secret store: `ruby secrets list|set|rm|import-env|keygen`. `<RUBY_HOME>/secrets` is AES-256-GCM under a scrypt-derived key, unlocked by `RUBY_SECRETS_KEY_FILE` or `RUBY_SECRETS_PASSPHRASE`. Environment variables win over stored secrets; values come from stdin, never argv. Backups include the store, not its key.
- Docker sandbox never runs as root. New `sandbox.user` (`uid:gid`, uid 0 refused); unset, it is the host uid, or the workspace owner when Ruby runs as root, else 65534:65534. Startup fails with a remedy if that user cannot write the workspace.
- Dashboard: Sessions, Logs (API audit and failures) and Routing pages, with `/api/log/*`, `/api/routing`, and admin deletes for conversations and pairing codes.
- Failure-injection tests for the gateway and channels, the agent runtime and the scheduler.
- Channel `send` can now return `uncertain` (timeouts, resets, 502/504, unreadable success responses), and the gateway applies a send timeout (60 s). Uncertain sends are never resent. A scheduled job that pauses itself after repeated failures notifies the owner.
- Security fixes:
  - Workspace: a symlink (including a dangling one) can no longer escape the workspace; `write_file` re-checks the real parent at write time and refuses a symlink target.
  - Thinking blocks recorded after a compaction checkpoint are kept; only earlier ones are stripped.
  - Tool-argument repair no longer strips trailing commas inside strings.
  - The admin API cannot change protected config fields (permissions, sandbox, model provider, base URL and key name, API host, port and proxy settings, demo origins, workspace, channel token names, Signal URL); edit `config.json` by hand for those.
  - Ruby API keys are redacted in logs and output; session events shown in the dashboard are sanitized.
  - The per-session tool set is frozen with the system prompt and the executor refuses tools outside it.
  - With `trustProxy`, the rightmost `X-Forwarded-For` entry is used.
  - The API audit log is pruned (90 days, 100k rows) and only authenticated requests are audited.
  - Demo endpoint reserves its worst-case token cost before the model call, so concurrent requests cannot overspend the daily budget.
  - Request bodies must arrive within 30 s (408 and close).
- Fixes: cron day skips on spring-forward days, a repeated fall-back minute fires once (wildcard-hour jobs follow elapsed time), `/stop` cancels `chat()` tasks, the inbox backlog is dispatched in order before messages that arrive during channel start, and conflicts return 409.

### Phase 5–6
- Dashboard: overview, chat, approvals, memory, skills (with proposal diffs), schedules, channels and pairing, API keys, usage, settings generated from the config schema with review-before-save, achievements and easter eggs. Static ES modules, no build, strict CSP.
- Admin API for the dashboard (`/api/*`, read vs admin scopes), static serving with a strict CSP, `ruby dashboard` login links (key in the URL fragment).
- Achievements and easter eggs (Konami code, `ruby --sparkle`), stored locally.
- `run_command` in a Docker sandbox: no network, read-only root, all capabilities dropped, resource limits, host uid, killed on timeout or cancel, never silently downgraded. Only registered when the owner allows `exec`; approval prompts show the full command.
- `ruby backup` and `ruby restore`.
- `ruby import openclaw|hermes`: memory (within caps, originals archived), persona, skills (as owner skills); secrets are never read.
- Discord channel (direct messages) over the gateway WebSocket with resume, zombie detection, no mass mentions.
- Public website demo endpoint `/v1/demo/chat/completions`: keyless, tool-less, origin-checked, per-IP and daily-budget limited.

### Phase 4: scheduling, approvals, Signal, providers
- Cron jobs and heartbeats in config: time zones and DST, occurrence IDs so a slot runs once across restarts, coalesced catch-up, no overlap, cheap pre-checks (`file_changed`, `url_changed`) that skip the model, per-run and daily token budgets, pausing after repeated failures, `NOTHING_TO_REPORT` quiet runs, `ruby jobs ...`.
- Jobs run with their own agent: their permission grant intersected with the owner's (read-only by default).
- Approvals over chat: `/approve <code>` and `/deny <code>`, single-use grants bound to the exact operation.
- Signal channel through a local signal-cli daemon (HTTP JSON-RPC + SSE).
- OpenAI-compatible model adapter for OpenRouter and local servers.

### Phase 3: memory, skills, context
- Bounded memory (`MEMORY.md` 2,200 chars, `USER.md` 1,400 chars) per namespace, versioned with rollback, a `memory` tool, and `ruby memory show|edit|history|rollback`.
- Skills in the agentskills.io `SKILL.md` format: only the index is in the prompt; owner-edited skills are locked and agent changes become proposals; `ruby skills ...`.
- System prompt frozen per session for prompt caching; keep-tail compaction between tasks with a checkpoint summary that re-freezes the prompt.
- Deterministic tool-call repair with repair records, and artifacts for oversized tool output (`read_artifact`).

### Phase 2: gateway, Telegram, API
- Gateway: durable inbox with dedupe, per-conversation lanes, pairing codes for unknown senders, `/new` and `/stop`, routes that link chats, durable outbox with retries, and restart recovery that reports interrupted work instead of replaying it.
- Telegram channel: long polling with at-least-once acknowledgement, message splitting, 409 conflict handling, clean shutdown, and the token redacted from errors.
- Opt-in HTTP API: scoped, expiring, revocable keys (salted HMAC, constant-time check), per-key rate limits, an audit log, OpenAI-compatible `/v1/chat/completions` with streaming, and refusal to bind publicly without a key.
- `ruby start`, `ruby pair`, `ruby api`, `ruby service` (systemd/launchd); secrets in `<RUBY_HOME>/env`.

### Phase 1: foundation
- Core contracts, config with validation, migrations and redaction, and SQLite storage with an append-only event log.
- Agent loop with budgets, cancellation, transient-error retries, and per-session lanes.
- Tool registry and executor with schema validation, capability policy, approvals, timeouts and output limits; workspace file tools.
- Anthropic adapter (streaming, prompt caching, refusal fallback, effort) and an offline fake model.
- `ruby` CLI: `init`, `chat`, `config check|show|explain`, `sessions`.
- Public static website in `site/`.
