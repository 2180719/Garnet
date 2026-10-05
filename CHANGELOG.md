# Changelog

## Unreleased

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
