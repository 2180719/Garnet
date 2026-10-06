# Changelog

## Unreleased

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
