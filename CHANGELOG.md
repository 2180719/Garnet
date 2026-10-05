# Changelog

## Unreleased

### Phase 1: foundation
- Core contracts, config with validation, migrations and redaction, and SQLite storage with an append-only event log.
- Agent loop with budgets, cancellation, transient-error retries, and per-session lanes.
- Tool registry and executor with schema validation, capability policy, approvals, timeouts and output limits; workspace file tools.
- Anthropic adapter (streaming, prompt caching, refusal fallback, effort) and an offline fake model.
- `ruby` CLI: `init`, `chat`, `config check|show|explain`, `sessions`.
- Public static website in `site/`.
