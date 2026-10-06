# Garnet — Plan

Garnet is a persistent personal agent you run on your own VPS or computer and reach through Telegram, Signal, Discord, an opt-in dashboard, or an authenticated API. The goal is a polished, maintainable replacement for OpenClaw and Hermes Agent: keep what made them popular, fix what people complain about, and stay small enough that a person — or an agent — can read the whole thing.

## What we learned from OpenClaw and Hermes

| Keep | Fix |
| --- | --- |
| One gateway process as the source of truth for channels, sessions and routing (OpenClaw) | OpenClaw's ~400k+ lines, 50+ config files and frequent breaking updates. Garnet stays small, with versioned config and automatic migrations |
| Human-readable workspace files: instructions, persona, heartbeat checklist, memory (OpenClaw) | Tens of thousands of internet-exposed instances with auth bypasses. Garnet refuses a non-loopback bind without auth and ships secure defaults |
| One active run per session, with a global concurrency cap (OpenClaw lane queue) | Heartbeats calling an expensive model ~48×/day. Garnet runs cheap deterministic checks first and wakes the model only on change |
| Hard-capped prompt memory, loaded as a frozen per-session snapshot so prompt caching survives; the agent consolidates when full (Hermes) | Session history resent on every turn until context overflows. Garnet compacts with recoverable checkpoints |
| Skills as plain `SKILL.md` files, compatible with the agentskills.io format (both) | Malicious skills in public registries. Garnet installs only local or reviewed skills and never runs third-party code in-process |
| Opt-in, OpenAI-compatible API server behind a bearer key (Hermes) | Hermes overwriting user-edited skills. User edits are locked; the agent can only propose a patch |
| Command approval, DM pairing, container isolation, credential filtering (Hermes) | Hermes claiming partial work was complete. Completion reports must list what was verified and what was not |
| Pluggable sandbox backends: local, Docker, SSH (Hermes) | Gateway update races (a Telegram token stuck on the old process), unvalidated setup input, silent usage-reporting failures. Garnet does an ordered handover, validates config at startup, and shows "unknown" usage rather than zero |
| Achievements and personality that make the product fun (Hermes) | Plaintext secrets at rest. Garnet encrypts its secret store |

## Product goals

1. **Maintainable and modular.** Every module has one job, a public `index.ts`, its own `AGENTS.md`, and offline tests. Lint enforces that modules import each other only through `index.ts`. A dependency must justify its weight.
2. **Easy for agents to navigate and modify.** Use a predictable layout, a root `AGENTS.md` map, and a single `npm test` that is fast and offline, so a user's own agent can safely change Garnet. Self-modification goes through a branch or patch plus tests, never live edits to the running install.
3. **Robust gateway.** Durable inbox/outbox, deduplication, per-session serialization, health checks that test real message flow, clean shutdown and restart, and channel adapters isolated from the agent loop.
4. **Opt-in, key-gated external access.** Off by default and bound to loopback. When enabled: scoped, revocable, hashed API keys; rate limits; an audit log; and an OpenAI-compatible endpoint plus a native API. Garnet refuses to bind publicly without auth.
5. **Token efficient.** Stable prompt prefix, bounded memory snapshot, a small fixed tool set per session (changing tools mid-session would break prompt caching and signed thinking), artifact handles for large outputs, recoverable compaction, and per-task usage accounting.
6. **Premium, lightweight surfaces.** A no-tracking public website and an opt-in dashboard that ships in the repo, both fast and polished.

Non-goals: a public skill marketplace, vector search, realtime voice, and WhatsApp (for now: only unofficial bridges work for personal accounts). Delegation is in scope: the agent may spawn subagents up to two levels deep, each bounded by the parent's budget, permissions and untrusted-content state.

## Decisions

| Area | Decision | Reason |
| --- | --- | --- |
| Language | TypeScript on Node.js ≥ 22.18, run directly with Node's type stripping (erasable syntax only) | No build step for the core; fits the dashboard and site; strong provider SDK ecosystem |
| Storage | SQLite via built-in `node:sqlite` (WAL), FTS5 for search | Transactions for inbox/outbox, dedupe and occurrences; zero native dependencies |
| Dependencies | `zod` (validation and tool JSON Schema) and the official `@anthropic-ai/sdk` (models only); everything else uses Node built-ins, enforced by `scripts/lint.ts` | Small, auditable dependency tree |
| HTTP | `node:http` with a tiny internal router | Fewer dependencies, full control over auth and limits |
| Tests | `node:test` + `tsc --noEmit` + a small lint script | Fast, offline, no framework lock-in |
| First provider | Anthropic Messages API; then an OpenAI-compatible adapter (OpenRouter, local models) | Prompt caching and tool use first; broad coverage second |
| Channels | Telegram first; Signal via the `signal-cli` daemon (JSON-RPC); Discord later | Telegram has the simplest bot API; Signal needs a bridge, so validate it early |
| Secrets | `~/.garnet/secrets` encrypted with a key from the OS keychain or a key file outside the data dir | No plaintext at rest |
| Hosting | One service managed by systemd (Linux) or launchd (macOS); Docker image optional | Same install on a VPS and a personal computer |

## Repository layout

```text
AGENTS.md            map of the codebase for agents and contributors
PLAN.md              this file
src/
  contracts/         shared types and zod schemas (the only module everyone imports)
  config/            load, validate, migrate, and redact config
  store/             SQLite: events, sessions, inbox/outbox, memory, jobs, keys
  runtime/           agent loop, task states, budgets, cancellation, session queue
  models/            provider adapters (fake, anthropic, openai-compatible)
  tools/             tool registry, executor, built-in tools
  policy/            permissions, approvals, sandbox selection
  context/           prompt assembly, memory snapshot, compaction, clean history
  memory/            bounded memory files and skills (with user-edit locks)
  gateway/           routing, identities, pairing, durable delivery, HTTP server, API keys
  channels/          telegram, signal, discord, http (each a self-contained adapter)
  scheduler/         cron and heartbeats with cheap pre-checks
  achievements/      unlockable achievements and easter eggs
  cli/               `garnet` command
  main.ts            composition root: the only place modules are wired together
dashboard/           opt-in web UI, served by the gateway when enabled
site/                public static website
test/                cross-module integration tests and fixtures
```

Each `src/<module>/AGENTS.md` states: purpose, public API, what the module owns, what it must not do, and how to test it.

## Architecture

```text
 Telegram  Signal  Discord  Dashboard  HTTP API (opt-in, key-gated)
     \        |       |         |         /
      +------ channel adapters (normalize) ------+
                        |
     gateway: identity, pairing, routing profiles, dedupe,
              durable inbox/outbox, rate limits, API keys
                        |
     runtime: per-session queue -> agent loop -> budgets/cancel
        |            |             |             |
     context       models        tools ------ policy/sandbox
        |                          |
      memory/skills             artifacts
                        |
                  store (SQLite)        scheduler -> enqueues into gateway
```

Rules:

- `main.ts` is the only composition root. Modules receive dependencies through constructors, with no global state.
- The runtime is the only module that records model and tool lifecycle events; there are no competing transcripts.
- Scheduled triggers, dashboard chat and API requests all enter through the gateway and run through the same loop as channel messages.
- Tool output and inbound content are untrusted data. They cannot change permissions, bindings or configuration.

## Gateway

- **Inbound:** verify sender → dedupe on (channel, external ID) → persist to inbox → resolve the routing profile → enqueue on the session lane. One active run per session; a global concurrency cap applies. Follow-up messages queue; `/stop` cancels immediately.
- **Outbound:** persist to outbox with a delivery ID → send → mark delivered. Retry with backoff. Where a channel cannot dedupe sends, mark the message uncertain instead of resending blindly.
- **Pairing:** an unknown sender gets a one-time code that the owner approves from the CLI or dashboard. Display names are never used for identity.
- **Routing profiles:** bind a channel/chat to a conversation, a memory namespace, a sandbox and a permission profile. Defaults: separate conversations with shared owner memory. Group chats never inherit private memory.
- **Lifecycle:** startup validates config and refuses to start on errors. Shutdown drains, then releases channel sessions (for example, Telegram long polling) before exit, so upgrades never race the old process. `/health` reports per-channel liveness, based on recent successful polls or sends rather than "connected" flags.

### External access (opt-in)

Disabled by default. Enable it with `garnet api enable`.

- Binds to `127.0.0.1` unless configured otherwise. Startup refuses a non-loopback bind unless at least one key exists; recommend Tailscale or a reverse proxy with TLS.
- **API keys:** `garnet api key create --name laptop --scopes chat,read` prints the key once. Garnet stores only a salted HMAC-SHA256 hash (keys are high-entropy random secrets, so a slow password hash would add latency without adding security) and a short ID for identification. Keys can be scoped (`chat`, `read`, `admin`), given an expiry, revoked, and rate-limited (token bucket). Every request is written to the audit log.
- **Endpoints:**
  - `POST /v1/chat/completions` and `GET /v1/models`: OpenAI-compatible, so any chat frontend works.
  - `/api/*`: native API for sessions, tasks, approvals, memory, schedules, config and usage. This is what the dashboard uses.
  - `GET /health`: no auth, minimal information.
- Keys map to a routing profile, so an API client gets its own conversation, memory namespace and permissions.

## Agent loop

1. Load the session and task; check cancellation, budget and permissions.
2. Build context: stable prefix (instructions, persona, tool index) → memory snapshot → task state/checkpoint → recent turns → selected results.
3. Stream the model call; forward text to channels that support streaming (not built yet: channels receive the finished reply; the terminal chat streams).
4. Validate tool calls; apply only unambiguous repairs; authorize via policy; persist intent; execute with deadline and cancellation; store large output as artifacts.
5. Repeat until completion, waiting for the user, cancellation, or budget exhaustion.
6. Persist the final state and enqueue the reply. Completion reports state what was done, what was verified, and what remains.

Task states: `running`, `waiting_for_user`, `waiting_for_approval`, `completed`, `cancelled`, `budget_exhausted`, `failed`.

**Tool-call repair:** keep immutable audit events plus a derived, clean, model-facing history. Repairs are deterministic only (for example, stripping code fences or fixing a JSON trailing comma). Never guess paths, recipients or consequential arguments. Repairs grant no permissions. Correction attempts per operation are bounded.

## Memory and skills

- **Memory files** per namespace: `MEMORY.md` (agent notes) and `USER.md` (owner profile), each with a hard character cap (defaults 2,200 and 1,400). They are injected as a frozen snapshot at session start, so mid-session writes go to disk without breaking the cache. When full, the agent must consolidate or replace entries. Every change is versioned and can be inspected, edited and rolled back from the CLI or dashboard.
- **Session search (not built yet):** FTS5 over past sessions, retrieved on demand through a tool rather than injected.
- **Skills:** `SKILL.md` folders in the agentskills.io format. Only the index (name plus one line) is in the prompt; bodies load on demand. The agent may create skills; each records provenance (`agent`/`user`), usage count and last-used date. A user-edited skill is locked: the agent can only propose a diff for approval. Stale or unused agent skills are surfaced for archival, never silently deleted. Third-party skills are never fetched automatically.

## Policy and sandboxes

- Permission profiles grant capabilities: `fs.read`, `fs.write`, `net.fetch`, `exec`, `message.send`, `schedule.edit`, `memory.write`, and so on. Each is `allow`, `ask` or `deny`, plus path and host scopes.
- Approvals are persisted, bound to one pending operation, accepted only from an authorized identity, and expire (default 24h). In chat they use inline buttons where available, otherwise a short code (today: short code only).
- Sandbox backends: `local` (workspace roots only; not an isolation boundary), `docker`, and `ssh` (the system ssh client; a boundary only as strong as the remote account, with its own remote workdir). Other runtimes slot in behind the same `Sandbox` interface. A profile marked isolated must use a real boundary; an unavailable backend is an error, never a silent downgrade.
- Credentials are injected into tools by name, never placed in prompts, and redacted from logs and tool output (redaction is built; injecting named secrets into commands is not yet).

## Scheduler

- Cron jobs (calendar plus timezone) and heartbeats (interval plus checklist). Each can be enabled or disabled; a global kill switch exists.
- **Cheap pre-checks:** a heartbeat may define deterministic checks (file changed, URL hash changed, command exit code, time window). The model runs only when a check fires or the job opts out. A disabled job never calls the model.
- Each job has a routing profile, a permission grant (intersected with the profile), per-run and daily budgets, a timeout, no overlapping runs, and missed occurrences coalesced into one catch-up run. Occurrence IDs are persisted before the run starts.
- Optional cheaper model for scheduled runs.

## Dashboard (opt-in)

Served by the gateway at `/` when `dashboard.enabled = true`. Plain HTML/CSS with a small amount of TypeScript compiled at package time; no framework unless it pays for itself; well under 100 KB.

- **Pages:** chat; sessions and tasks (live via Server-Sent Events); approvals; memory and skills (edit, diff, rollback, lock); schedules (edit, toggle, run now, history); channels and pairing; routing profiles; API keys; config (every setting, validated, with descriptions, defaults and diff-before-save); usage and costs; logs.
- **Achievements:** unlocked by real milestones (first task, 100 tasks, first skill created, a week of uptime, a heartbeat that saved the day, zero-cost idle day, and so on), plus hidden easter eggs (Konami code, `garnet --sparkle`, special dates). They are stored locally and never phone home.
- Auth: loopback by default; remote access requires an `admin`-scoped key or session login.

## Public website

Static, no tracking, no cookies, no third-party requests, no frameworks; fast on a slow phone. Premium feel through typography, spacing, a restrained garnet palette, subtle motion that respects `prefers-reduced-motion`, and dark/light modes.

- **Sections:** hero; what Garnet is; why (vs. bloat and insecure defaults); features; how it works; security posture; a quick-start install; FAQ; footer.
- **Optional "talk to Garnet" demo:** a bounded Garnet instance with a cheap model, no tools, no memory, a short context, per-IP and global daily budgets, served through the same gateway with a `demo` API key profile. The site works fully without it.
- Deploys anywhere static (Cloudflare Pages, GitHub Pages, Netlify).

## Status (2026-10-06)

| Phase | State |
| --- | --- |
| 1. Foundation | Done |
| 2. Gateway, Telegram, API, service install | Done |
| 3. Memory, skills, context, repair, artifacts | Done (tool schemas stay fixed per session instead of loading on demand; see Product goals) |
| 4. Scheduler, chat approvals, Signal, OpenAI-compatible models, Docker sandbox | Done |
| 5. Dashboard and website | Done: website, demo endpoint, dashboard (all pages including sessions, logs and routing, achievements, easter eggs). Keyboard navigation not yet checked by hand |
| 6. Release hardening | Discord, importer, backup/restore, encrypted secret store, failure-injection tests, one-line installer, `garnet setup` and `garnet doctor` done. Still open: docs site, live tests against real providers and channels ([docs/LIVE-TESTING.md](docs/LIVE-TESTING.md)) |
| Next | Missing features ranked from research into OpenClaw, Hermes and the wider field: [docs/FEATURE-GAPS.md](docs/FEATURE-GAPS.md) |

## Build phases

Each phase ends with passing `npm test` and a short entry in `CHANGELOG.md`.

1. **Foundation:** scaffold, root and module `AGENTS.md`, contracts, config with validation and migrations, SQLite store, fake model, agent loop, tool registry with workspace file tools, policy basics, CLI (`garnet chat` against the fake or a real model). Exit: a simulated task completes end-to-end offline; tests cover invalid tool arguments, tool failures and denials.
2. **Gateway and first real paths:** gateway with inbox/outbox, session lanes, pairing, routing profiles; Anthropic adapter; Telegram adapter; HTTP server with API keys and the OpenAI-compatible endpoint; service install (systemd/launchd). Exit: a Telegram message drives a tool-backed task and the reply is delivered; duplicate inbound messages do not rerun; a restart recovers queued work; the API rejects missing, invalid, revoked or out-of-scope keys.
3. **Memory, skills, context:** bounded memory snapshot, session search, skills with locks, artifact store, compaction, tool-call repair and clean history, usage accounting. Exit: important constraints survive compaction; a locked skill cannot be overwritten; a fixed task suite shows lower input tokens than the full-history baseline with no loss in success.
4. **Scheduler and Signal:** cron, heartbeats with pre-checks, approvals over chat, `signal-cli` adapter, OpenAI-compatible model adapter, Docker sandbox. Exit: a disabled heartbeat never calls the model; an ungranted write is denied; a restart does not duplicate an occurrence; the cross-channel demo (Telegram → restart → linked Signal chat) passes.
5. **Dashboard and website:** dashboard with all config, achievements and easter eggs; public site; optional demo endpoint. Exit: every config key is editable and validated in the dashboard; the site scores ≥ 95 on Lighthouse in every category, with zero third-party requests.
6. **Release hardening:** Discord, an OpenClaw/Hermes migration importer (workspace files, memory, skills), docs, failure-injection tests, an encrypted secret store, and a backup/restore command.

## Working agreements for contributors and agents

- Read `AGENTS.md` first, then the target module's `AGENTS.md`.
- Change one module at a time where possible; changes to cross-module contracts go in `src/contracts/` with tests.
- Ordinary tests are deterministic and offline; paid model calls only in opt-in smoke tests (`GARNET_LIVE_TESTS=1`).
- Handoffs list changed files, checks run, and known gaps, with no claims beyond what was verified.
