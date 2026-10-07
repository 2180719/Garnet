# Garnet — guide for agents and contributors

Garnet is a persistent personal agent: TypeScript on Node.js ≥ 22.18, run directly (no build step), SQLite via `node:sqlite`. Read `PLAN.md` for the product and roadmap.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | lint + typecheck + tests. Run before every commit. |
| `npm test` | Offline, deterministic tests (`node:test`). |
| `npm run garnet -- chat --fake` | Chat with the offline fake model. |
| `npm run garnet -- wake --fake` | The first-run wake-up conversation with the scripted offline model. |
| `npm run garnet -- help` | All CLI commands. |
| `npm run garnet -- setup` / `doctor` | Guided setup (re-runnable, `-y` for scripts) and install diagnosis. |
| `sh -n install.sh` | Syntax-check the one-line installer (POSIX sh, no bashisms). |
| `npm run garnet -- start` | Run the service in the foreground (gateway, channels, API). |

Deploying and testing against real providers and channels: [docs/LIVE-TESTING.md](docs/LIVE-TESTING.md).

## Layout

| Path | Owns |
| --- | --- |
| `src/contracts/` | Shared types: messages, model/tool/session contracts, errors, IDs. Everyone may import it. |
| `src/config/` | Config schema (every field documented), loading, migrations, redaction. |
| `src/store/` | SQLite: schema migrations, sessions, append-only event log, tasks, gateway tables, API keys and audit log. |
| `src/policy/` | Capability permissions, host scopes, untrusted-content containment (taint escalates allow to ask), approvals, workspace path containment. |
| `src/tools/` | Tool registry, executor (repair → validate → authorize → run with limits), artifacts for large outputs, built-in tools, `web_fetch`/`web_search` with an SSRF-guarded HTTP client (`web/`). |
| `src/models/` | Model adapters: `fake` (tests), `anthropic`, `openai-compatible` (OpenRouter, local servers) and the `gemini` preset over it, plus the swappable model wrapper. |
| `src/context/` | Frozen per-session system prompt, model-facing history derived from events, keep-tail compaction planning. |
| `src/memory/` | Bounded `MEMORY.md`/`USER.md` per namespace with versioning, and the `memory` tool. |
| `src/skills/` | `SKILL.md` skills (agentskills.io format) with provenance, owner-edit locks and proposals, plus optional built-in skills (`builtin/`). |
| `src/connectors/` | Optional built-in connectors (calendar ICS feed, GitHub, weather): one policy-gated tool each on the SSRF-guarded client, credentials by secret name. Off by default; on globally or per channel/chat/route ([docs/CONNECTORS.md](docs/CONNECTORS.md)). |
| `src/runtime/` | Agent loop, budgets, cancellation, retries, per-session lanes, session taint tracking. |
| `src/gateway/` | Identity and pairing, chat approvals (`/approve`, `/deny`), conversation routing, durable inbox/outbox delivery, restart recovery, API keys, HTTP API. |
| `src/channels/` | Messaging adapters (Telegram, Signal via signal-cli, Discord). Normalize a platform; no routing or persistence. |
| `src/scheduler/` | Cron jobs and heartbeats with pre-checks, budgets, catch-up and failure pausing; runs go through the gateway. |
| `src/service/` | systemd/launchd service definitions and install. |
| `src/migrate/` | `garnet import openclaw|hermes`: memory, persona and skills from other harnesses (dry run by default, never secrets). |
| `src/media/` | Attachments: content-addressed file store, type sniffing, voice-note transcription (OpenAI-compatible endpoint or local command), text extraction, the `send_file` tool. |
| `src/sandbox/` | Command execution behind one `Sandbox` interface: Docker (isolated, non-root, no network by default), SSH (remote host, as strong as the remote account) or local (not a boundary). |
| `src/secrets/` | Optional encrypted secret store (`<GARNET_HOME>/secrets`, scrypt + AES-256-GCM) and secret-name resolution: environment first, then the store. |
| `src/achievements/` | Local achievements and easter eggs for the dashboard. |
| `src/backend.ts` | Composition-root implementation of the dashboard/admin API. |
| `src/onboarding/` | First-run wake-up: the versioned bootstrap prompt, the `set_profile` tool, `applyProfile`, and `OnboardingWatch` (tool check and fallback decision). |
| `src/cli/` | The `garnet` command, including `garnet setup` (`setup/`), `garnet doctor` and `garnet wake`. |
| `install.sh` | One-line installer: clone or update into `~/.local/share/garnet`, `npm ci --omit=dev`, a `garnet` shim in `~/.local/bin`. |
| `dashboard/` | Opt-in dashboard: static files served by the API server under a strict CSP. |
| `src/main.ts` | Composition root: the only place modules are wired together. |
| `site/` | Public static website (no build, no tracking). |
| `test/` | Shared test helpers and fixtures (fake channel, wired gateway). |

## Rules (enforced by `scripts/lint.ts` where possible)

- Import another module only through its `index.ts`. Contracts that several modules share go in `src/contracts/`.
- Each module has an `AGENTS.md`: read it before changing that module.
- New runtime dependencies need a reason and an entry in the lint allowlist. Prefer Node built-ins.
- Erasable TypeScript only (no `enum`, no constructor parameter properties, no namespaces) because Node strips types at runtime.
- Tests are offline. Live provider tests must be opt-in (`GARNET_LIVE_TESTS=1`).
- Never put secrets in config, prompts, logs or tool output. Config stores the *name* of an environment variable or stored secret; resolve it with `garnet.secret(name)`, never `env[name]`.
- The event log is append-only. Never rewrite history the model has seen; derive cleaned views instead. The system prompt and tool set stay fixed for a session (prompt caching and signed thinking depend on it); they change only at compaction. The optional built-ins a session uses (`skills`, `connectors` in config) are chosen once when it starts and kept even through compaction.
- Report honestly: say what you verified and what you did not.

## Self-modification

If you are an agent changing your own Garnet install: work on a branch or a copy, run `npm run check`, and let the owner review the diff before it replaces the running version. Do not edit the live install in place.
