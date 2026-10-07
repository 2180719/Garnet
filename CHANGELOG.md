# Changelog

## Unreleased

### Fullscreen terminal chat
- `garnet chat` on a terminal now opens full screen: a status bar from the start (assistant name, model, session, what it is doing in words, context, tokens and cost or `?`, and `⚠ untrusted content read` when it applies), a scrollable transcript, and the input at the bottom. Scroll with PgUp/PgDn, Shift+Up/Down (half a page), Ctrl+Home/Ctrl+End or the mouse wheel; scrolled up, new output stays below with a "new messages below" line. F2 turns mouse reporting off so the terminal selects text as usual. Resizing re-wraps the whole transcript.
- `garnet chat --inline` or `chat.fullscreen = false` keeps the inline chat; `chat.mouse = false` starts with mouse reporting off. Pipes and `--plain` are unchanged. On exit (also SIGTERM, SIGHUP and crashes) the terminal is put back: normal screen, mouse reporting off, cursor shown, raw mode off.

### Configuration
- `garnet config get <path>`, `set <path> <value>` and `unset <path>`: change any setting from the command line, validated by the schema, written atomically, with the change printed. Credential-shaped values are refused (and never echoed), and `*Env` fields accept only variable names.
- New `docs/CONFIGURATION.md` classifies every environment variable Garnet reads (secret, bootstrap, system) and states precedence. No setting is environment-only; `garnet doctor` warns about `GARNET_*` variables that nothing reads.
- `garnet config explain` now covers permissions, route matches, job budgets and notify targets.
### SSH sandbox backend
- `sandbox.backend = "ssh"` runs `run_command` on a remote host through the system `ssh` client (no new dependency). argv only on this side; the remote command, cwd and environment are single-quoted; `BatchMode`, no password prompts, no forwarding, and `~/.ssh/config` is ignored. Host key checking is `strict` by default (`accept-new` and `off` are opt-in; doctor warns on `off`). Authenticate with a key file, ssh-agent, or both; a key passphrase is a secret name (`sandbox.ssh.passphraseEnv`), passed to ssh through a private one-use askpass helper, never argv or config.
- The remote `workdir` stands in for the workspace: `cwd` is relative to it and cannot leave it, symlinks included (checked on the remote with `pwd -P`). It is not synced with the local workspace. Timeouts, cancellation and output caps match the other backends.
- Honest boundary: ssh is only as strong as the remote account. Use a dedicated, unprivileged account or a disposable VM. Output is treated as untrusted (the remote has a network).
- The backend table in `src/sandbox/factory.ts` is the extension point for other runtimes. New: `garnet sandbox check`, doctor's ssh probe (only when `exec` is allowed; read-only), `sandbox.ssh.*` in `garnet config explain`, `src/cli/setup/sandbox.ts` (setup questions, not yet wired into the wizard).
### Built-in skills and connectors
- Optional built-in skills (`daily-briefing`, `web-research`, `github-triage`) and connectors (`calendar` from an ICS feed, read-only; `github`; `weather` from Open-Meteo). All off by default; enable them globally or per channel, chat, API key, job or route with `garnet skills|connectors enable|disable|reset [--channel <scope>]`, and see what a conversation gets with `effective`. See [docs/CONNECTORS.md](docs/CONNECTORS.md).
- Each conversation's set is chosen when it starts and kept for its life (compaction included), so the tool set and prompt stay fixed; `/new` picks up changes.
- Connectors need `net.fetch` (host scopes and containment apply), a GitHub comment also needs `message.send`, their output is untrusted, and credentials are secret names (`connectors.github.tokenEnv`, `connectors.calendar.urlEnv`). Doctor and `config explain` cover the new settings, and doctor's unread `GARNET_*` warning skips secret names the config points at (such as the default `GARNET_CALENDAR_URL` or an ssh passphrase name).
- Config version 2 (migrated automatically from version 0 or 1, with a backup).

### Connector fixes
- Security: a calendar feed that fails to load (a redirect loop, a refused redirect, a network error) now reports only its host and the secret name. Before, a redirect error could quote the feed's private path and query into the tool result, the event log and the model's context.
- A conversation keeps its connectors after config turns them off and Garnet restarts, compaction included, until `/new`. Before, the tool was still listed but calls failed with "Unknown tool" and compaction dropped it. New conversations still get only what config turns on, and `net.fetch: deny` still removes every connector.
- Calendar: all-day events and day-based durations (`P1D`, `P1W`) on a daylight saving change end at the next local midnight (or the same local time), not exactly 24 hours later, so they no longer show up on the following day.
- Calendar: recurrence rules that combine BYDAY with BYMONTHDAY ("the first Monday" as days 1 to 7 plus Monday, Friday the 13th) now give only the matching days, and BYMONTH and BYMONTHDAY limit daily and weekly rules. A weekly rule with BYMONTHDAY, or a numbered BYDAY in a daily or weekly rule, is shown once with a note.

### Review fixes
- Security: a chat linked into a shared conversation by `routes` no longer escapes its own overrides. A `disable` for the chat or its channel (or any chat or channel feeding the same route) now applies to the shared conversation, and `garnet skills|connectors effective|list --channel <chat>` resolve a routed chat exactly as the service does and name the route. Before, the service applied only `route:<name>` (and the channel when the route used one), so a chat's disable was ignored while the CLI reported it as off. Applies to conversations started after the update.
- Security: results of jobs and agent-sent messages that read untrusted content now carry that state into the chat they land in; forwarded voice notes and audio files count as untrusted (only a live voice note from the paired owner in a private chat does not); links in approval text are no longer treated as the owner's; "message the owner" and relative times are resolved before approval, so the action that runs is exactly the one approved; the agent cannot pause or resume `config.json` jobs, granting a job `exec` needs exec approval, and agent messages never go to group chats.
- `web_fetch` no longer leaks a connection when a compressed response stalls.
- The daily spending cap is checked before every model call and counts compaction; missing cache prices are derived from the input price; with a cap set, tasks whose cost can't be priced are refused; "today" follows the owner's time zone.
- Installer: updates installs made under the old command name, leaves a link at the old install path for an old service, honours `RUBY_NODE`; an old service is removed after `~/.ruby` is moved to `~/.garnet`; an empty `GARNET_*` falls back to `RUBY_*`.
- `doctor` checks media commands given as full paths correctly.
- Security: in a conversation that has read untrusted content, every approval asks again, including tools already set to ask; an earlier "always allow" in the terminal chat no longer applies.
- Backups include attachments (`<home>/media`); restore accepts backups made before the rename (`ruby.db`).
- `/compact` respects the daily spending cap, and spending is counted by when each model call happened, so tasks that run past midnight are counted.

### Renamed: Ruby is now Garnet
- The project, command (`garnet`), package (`garnet-agent`), default assistant name, repository (`2180719/Garnet`), service (`garnet.service` / `dev.garnet.agent`), API key prefix (`garnet_`), header (`X-Garnet-Conversation`) and data directory (`~/.garnet`) all changed, because `ruby` clashes with the Ruby language interpreter. Environment variables are now `GARNET_*` (`GARNET_HOME`, `GARNET_SECRETS_KEY_FILE`, ...); `npm run ruby` is now `npm run garnet`.
- Existing installs keep working: `RUBY_*` variables are read when the `GARNET_*` one is unset (`doctor` warns); `~/.ruby` is used when `~/.garnet` does not exist (`doctor` suggests `mv ~/.ruby ~/.garnet`); `ruby_` API keys and `X-Ruby-Conversation` are still accepted; `ruby.db`, `ruby-secrets` stores and `.ruby.json` skill sidecars are still read.
- `garnet service install` stops and removes the old `ruby` systemd unit / `dev.ruby` launchd agent when we wrote it and it runs the same home; `doctor` reports a leftover one. `install.sh` moves `~/.local/share/ruby` to `.../garnet` and removes the old `ruby` shim only when it is ours.

### Polish
- Garnet loads the workspace `AGENTS.md` into its prompt as your project instructions (8,000 character cap; changes apply after `/new`).
- Skills can bundle `references/`, `scripts/` and other text files; `skill_view` lists them and can read one on request, contained to the skill folder.
- `retention.*Days` (default 90) prunes finished inbox, outbox, job-run, approval and sent-message rows and unreferenced media at start and daily. The event log is never pruned.
- Security: `run_command` output marks the conversation as having read untrusted content when the sandbox has network access (Docker with a network, or the local backend).
- The channel `/start` greeting uses the configured assistant name.
- `garnet doctor` checks the voice transcription backend and the PDF text command.
- The channel `/start` greeting uses the configured assistant name.
- `garnet doctor` checks the voice transcription backend and the PDF text command.
- Dollar cost beside token usage in chat, dashboard and API: built-in Anthropic prices (checked 2026-10-06) or `model.pricing`; unknown shows `?`, never $0.
- `budgets.dailyUsd`: optional daily spending cap that refuses new model tasks; reminders and script jobs still run.

### New capabilities

#### Tier 0 (gateway/channels)
- Voice notes, photos, files and stickers get a short "I can't … yet" reply instead of silence.
- Chat commands `/help`, `/usage` (`/cost`), `/status` and `/retry` on Telegram, Signal and Discord.
- Telegram replies render markdown (falling back to plain text if Telegram rejects it); Signal replies have markdown stripped; code blocks stay whole when long replies are split.
- API: one conversation per chat for Open WebUI, LibreChat and other clients that resend history; `content: null` and content-part arrays accepted; SSE keepalives; `/approve` and `/deny` in API chats; opt-in CORS (`api.corsOrigins`); Open WebUI title, tag and follow-up requests answered without running the agent.
- Breaking: API requests with neither a conversation header nor `X-OpenWebUI-Chat-Id` no longer share a `default` conversation.
- Heartbeats: `HEARTBEAT_OK` counts as nothing to report; job notifications are written into the chat's conversation so replies have context.
- The agent knows the current date and time: each message carries its send time in the owner's time zone (new `timezone` setting).
#### Web tools and containment
- Added `web_fetch` (public pages as Markdown; large pages as artifacts) and `web_search` (DuckDuckGo by default, SearXNG, Brave, Tavily), both behind `net.fetch`, with an SSRF guard that checks every redirect and pins DNS.
- Added prompt-injection containment: once a conversation reads untrusted content, actions set to allow (write files, run commands, send messages, change memory, skills or schedules, fetch URLs the agent composed) ask first until `/new`. Approvals say why; the terminal chat and dashboard show it.
- `web.allowHosts` lets `web_fetch` reach listed hosts without asking. `doctor` reports the web setup.
#### Media
- Photos, PDFs, text files and voice notes from Telegram, Discord and Signal. Images and PDFs go to the model natively when it supports them; voice notes are transcribed by an OpenAI-compatible endpoint (OpenAI, Groq, local whisper server) or a local command; otherwise the agent says plainly what it can't read instead of going silent.
- New `send_file` tool (asks first) sends workspace files to your chat.
- Terminal chat: `/attach <path>`.
- API: `image_url` and `file` parts as data URLs; remote URLs are refused.
- Stickers, locations and similar get a reply instead of silence.
- Old images are swapped for placeholders in the model's view so photos can't fill the context window.
#### Switching (importer, CLI, models)
- The system prompt uses the assistant's configured name and points the agent at imported archives.
- `import` brings scheduled jobs over (disabled) from Hermes `cron/jobs.json` and OpenClaw 2026.9 automations, including heartbeat checklists.
- `import` can raise memory caps to fit (`--raise-caps`) and pair allowlisted senders (`--pairings`); it merges a persona into one that only has setup basics (`--persona keep|merge|replace` otherwise).
- `import` keeps skill requirements, flags missing tools and programs, rewrites `{baseDir}`, imports Hermes bundled skills you edited, honours `HERMES_HOME` and OpenClaw profile/workspace settings, and warns about other profiles.
- `pair add <channel> <id>`; `service ... --name <n>` for several homes side by side, with `service list` and `restart`.
- OpenAI: `max_completion_tokens`; output capped to fit the context window.
#### Scheduling and messaging
- Jobs created by a conversation that had read untrusted content keep asking for approval when they run.
- The agent can schedule work from chat: one-shot reminders, recurring tasks and script-only jobs, with natural times in your time zone. Each needs your approval and delivers back to the chat you asked from.
- `send_message` lets the agent message you or another paired chat on its own: approval required by default, rate-limited, and recorded in that chat's conversation.
- New `scheduler.maxAgentJobs` and `gateway.messagesPerHour` settings.
- `jobs` shows every job's origin and next run; new `show`, `add`, `edit`, `pause` and `delete` subcommands. The dashboard can pause, edit and delete jobs.

### Installation and onboarding
- One-line installer: `curl -fsSL https://raw.githubusercontent.com/2180719/Garnet/main/install.sh | sh`. POSIX sh, no sudo, idempotent: checks Node.js 22.18+ and `node:sqlite` (with install advice), clones or fast-forwards into `~/.local/share/ruby` (refusing to touch local changes), runs `npm ci --omit=dev`, writes a `ruby` shim in `~/.local/bin` (never over a file it did not write), warns when PATH lacks it or another `ruby` (the language) shadows it, then starts `ruby setup` on a terminal. `--name` installs under another command name.
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

### Polish and fixes
Security:
- `ruby chat` shows escape sequences from model and tool output instead of sending them to the terminal, so they can no longer hide text in approval prompts or write the clipboard.
- `ruby dashboard` prints a one-time login link valid for 15 minutes. The dashboard swaps it for a 1-day key kept only in that browser tab, and Sign out revokes it.
- Ruby refuses a `workspace` that contains its own home; `ruby doctor` reports it, and warns about an API bound beyond loopback.
- The secret store limits how much memory key derivation may use when reading a file.
- Tool calls with unknown arguments are rejected with a clear error instead of having those arguments silently dropped.

Runtime and models:
- Fixed a second compaction resending the whole conversation instead of starting from the previous summary; a truncated summary now fails compaction.
- Fixed tool results attaching to the wrong turn with OpenAI-compatible servers that send no tool call ids.
- Fixed the global concurrency cap being exceeded under load.
- A command that times out is reported to the model as an error, with its output kept; a tool that ran is never reported as failed because its output could not be stored.
- Anthropic: overloads that arrive mid-stream are retried; empty text blocks are no longer sent.
- Tasks no longer stay "running" after an internal error; a provider's long `retry-after` no longer blocks a conversation past its time limit.
- OpenAI-compatible: connections are released when a stream stops early, and OpenRouter cache writes are reported.
- `read_file` streams large files; `list_files` shows correct paths when the workspace path goes through a symlink.

Channels, gateway and service:
- Signal: fixed inbound messages being dropped (signal-cli sends `{account, envelope}` events); reconnect a silent event stream; a group send that reached some members no longer resends to all.
- A long reply that hits a rate limit partway is finished in place instead of being resent from the start (no duplicate chunks).
- Replies are delivered in order per chat; health no longer loads the whole outbox.
- The SQLite WAL is truncated after write bursts (`journal_size_limit` 16 MiB); migrations are safe when the service and the CLI open the database together.
- A restart during a scheduled job no longer counts as a failure or messages the owner.
- Service: reinstall restarts the service (systemd) and works when the agent is already loaded (launchd); 60 s stop timeout; launchd PATH includes Homebrew and /usr/local/bin. Existing installs show as out of date in `ruby doctor` until reinstalled.
- API: invalid `limit`/`after` return 400; key expiry must be 1–3650 days.

CLI, config and knowledge:
- `ruby chat` no longer crashes on unusual key sequences; command output redraws cleanly after the terminal narrows; plain mode continues after an error.
- Cron rejects malformed fields; `*/N` day-of-month with a weekday matches like Vixie cron.
- Config migrations keep earlier backups; `ruby setup --reset` never loses `config.json` on a failed save; a failing import no longer aborts setup.
- `ruby memory rollback … --ns`, `EDITOR` values with arguments, arrow keys in hidden input, and clean usage errors (exit 2) for bad flags.
- Backup and restore include artifacts; skill proposals that would break a skill are refused, and skill descriptions get the memory injection check.
- `install.sh` handles relative `--dir` / `--bin-dir`; `ruby doctor` recognises `--name` installs.

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
