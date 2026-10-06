# Ruby — guide for agents and contributors

Ruby is a persistent personal agent: TypeScript on Node.js ≥ 22.18, run directly (no build step), SQLite via `node:sqlite`. Read `PLAN.md` for the product and roadmap.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | lint + typecheck + tests. Run before every commit. |
| `npm test` | Offline, deterministic tests (`node:test`). |
| `npm run ruby -- chat --fake` | Chat with the offline fake model. |
| `npm run ruby -- help` | All CLI commands. |
| `npm run ruby -- start` | Run the service in the foreground (gateway, channels, API). |

## Layout

| Path | Owns |
| --- | --- |
| `src/contracts/` | Shared types: messages, model/tool/session contracts, errors, IDs. Everyone may import it. |
| `src/config/` | Config schema (every field documented), loading, migrations, redaction. |
| `src/store/` | SQLite: schema migrations, sessions, append-only event log, tasks, gateway tables, API keys and audit log. |
| `src/policy/` | Capability permissions, approvals, workspace path containment. |
| `src/tools/` | Tool registry, executor (repair → validate → authorize → run with limits), artifacts for large outputs, built-in tools. |
| `src/models/` | Model adapters: `fake` (tests), `anthropic`, and `openai-compatible` (OpenRouter, local servers). |
| `src/context/` | Frozen per-session system prompt, model-facing history derived from events, keep-tail compaction planning. |
| `src/memory/` | Bounded `MEMORY.md`/`USER.md` per namespace with versioning, and the `memory` tool. |
| `src/skills/` | `SKILL.md` skills (agentskills.io format) with provenance, owner-edit locks and proposals. |
| `src/runtime/` | Agent loop, budgets, cancellation, retries, per-session lanes. |
| `src/gateway/` | Identity and pairing, chat approvals (`/approve`, `/deny`), conversation routing, durable inbox/outbox delivery, restart recovery, API keys, HTTP API. |
| `src/channels/` | Messaging adapters (Telegram, Signal via signal-cli). Normalize a platform; no routing or persistence. |
| `src/scheduler/` | Cron jobs and heartbeats with pre-checks, budgets, catch-up and failure pausing; runs go through the gateway. |
| `src/service/` | systemd/launchd service definitions and install. |
| `src/cli/` | The `ruby` command. |
| `src/main.ts` | Composition root: the only place modules are wired together. |
| `site/` | Public static website (no build, no tracking). |
| `test/` | Shared test helpers and fixtures (fake channel, wired gateway). |

## Rules (enforced by `scripts/lint.ts` where possible)

- Import another module only through its `index.ts`. Contracts that several modules share go in `src/contracts/`.
- Each module has an `AGENTS.md`: read it before changing that module.
- New runtime dependencies need a reason and an entry in the lint allowlist. Prefer Node built-ins.
- Erasable TypeScript only (no `enum`, no constructor parameter properties, no namespaces) because Node strips types at runtime.
- Tests are offline. Live provider tests must be opt-in (`RUBY_LIVE_TESTS=1`).
- Never put secrets in config, prompts, logs or tool output. Config stores the *name* of an environment variable.
- The event log is append-only. Never rewrite history the model has seen; derive cleaned views instead. The system prompt and tool set stay fixed for a session (prompt caching and signed thinking depend on it); they change only at compaction.
- Report honestly: say what you verified and what you did not.

## Self-modification

If you are an agent changing your own Ruby install: work on a branch or a copy, run `npm run check`, and let the owner review the diff before it replaces the running version. Do not edit the live install in place.
