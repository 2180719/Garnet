# Missing features (2026-10-06)

What Ruby needs to be a drop-in replacement for OpenClaw, Hermes Agent and the agent features people now expect elsewhere. Ranked by how much each one changes a real user's day, then by cost. Effort: **S** under a day, **M** a few days to two weeks, **L** more.

Sources, with every claim marked sourced or inferred: [research/research-openclaw.md](research/research-openclaw.md), [research/research-hermes.md](research/research-hermes.md), [research/research-landscape.md](research/research-landscape.md) (coding agents, hosted assistants, frameworks, standards) and [research/research-switching.md](research/research-switching.md) (what breaks on day one for someone switching). Gaps were checked against `src/`; nothing here was tested against a live product.

## Where Ruby stands

Ruby already fixes the things people complain about most in OpenClaw and Hermes: no public bind without keys, exec denied by default and sandboxed in Docker with no network, cheap pre-checks before heartbeats wake the model, bounded frozen memory, locked user-edited skills, honest completion reports, compaction that keeps constraints, and an encrypted secret store.

What it lacks is reach. The built-in tools are files, `run_command`, memory, skills and `read_artifact`. The `net.fetch`, `message.send` and `schedule.edit` permissions exist in config but no tool uses them. Channels are text only, groups are ignored, and there is no MCP. A typical switcher today ends up with a Telegram notes-and-files bot that cannot look anything up, cannot schedule anything, and is silent on voice notes and in groups.

## Tier 0: day-one fixes for switchers (each S)

Small changes that remove the sharpest edges. About a week in total.

| # | Fix | Why |
| --- | --- | --- |
| 0.1 | Reply "I can't read voice notes/photos yet" instead of dropping non-text messages | Silence looks broken |
| 0.2 | OpenAI-compatible API: key conversations by `X-OpenWebUI-Chat-Id`, the `user` field, or a hash of the history instead of one shared `default`; accept `content: null`; SSE keepalives; handle `/approve` in API chats; opt-in CORS | Open WebUI and LibreChat currently merge every chat into one conversation |
| 0.3 | Treat `HEARTBEAT_OK` like `NOTHING_TO_REPORT`; write job notifications into the chat's session so replies have context | Imported heartbeat checklists spam the chat; replies to a job message lose context |
| 0.4 | Current date and time in each turn (in the turn, not the frozen system prompt) | Reminders and "today" questions are wrong |
| 0.5 | Use the configured assistant name in the system prompt; tell the agent where `imported/` lives | The prompt says "You are Ruby" over an imported persona |
| 0.6 | Importer: offer larger memory caps (schema allows 20k), import Hermes `cron/jobs.json` as disabled jobs, rewrite `{baseDir}` in skills, keep `metadata.requires` and flag skills whose tools or binaries are missing, import allowlists, warn about Hermes profiles and custom OpenClaw paths | Imports silently lose memory, schedules and working skills |
| 0.7 | `ruby pair add`, `ruby service install --name` | Re-adding people by hand; a second instance overwrites the first |
| 0.8 | OpenAI: send `max_completion_tokens`, clamp output tokens to the context window | Reasoning models and small local servers likely reject the request |
| 0.9 | Render markdown for Telegram (or strip it) | Raw `**` and backticks in replies |
| 0.10 | `/usage`, `/status`, `/retry` in chat | Expected from both Hermes and the terminal chat |

## Tier 1: core capabilities (build in this order)

| # | Feature | Effort | Notes |
| --- | --- | --- | --- |
| 1.1 | **Untrusted-content containment** | M | Once web pages, email or MCP results enter a task, consequential actions (send, write outside workspace, exec, schedule) need approval for the rest of that task. Built first because 1.2, 1.6 and the connectors bring untrusted text in. OpenClaw's email-deletion incident and Hermes' injection CVEs are the cautionary tales; this can be Ruby's distinguishing feature. |
| 1.2 | **`web_fetch` and `web_search`** | S–M | `web_fetch` behind `net.fetch: ask` with an SSRF guard (no private, loopback or metadata addresses; re-check after redirects), HTML to text, large pages as artifacts. One keyless search backend first, others pluggable. Top gap in every report. |
| 1.3 | **`schedule` and `send_message` tools, one-shot reminders** | M | Behind the existing `schedule.edit` and `message.send` permissions. Jobs created from chat deliver back to that chat. Script-only jobs that never call the model (Hermes users love these). |
| 1.4 | **Media** | M | Images and documents in (to the model when it supports them, else extracted text), voice-note transcription (local whisper or a provider, configurable), files out as attachments. Changes the shared message contract, so do it early. |
| 1.5 | **Session search** | S–M | FTS5 over past sessions and imported daily notes, through a tool. PLAN.md already promises it. Treat the index as derived and rebuildable; never fail a turn because of it (Hermes lost 14 hours of data to index corruption). |
| 1.6 | **MCP client** | M | stdio and Streamable HTTP, OAuth for remote servers, stdio servers inside the sandbox, tools bound at session start so the tool set stays fixed. Results are untrusted (1.1). The route to email, calendar, Home Assistant and browser control without building each one. |

## Tier 2: expected by switchers and power users

| # | Feature | Effort | Notes |
| --- | --- | --- | --- |
| 2.1 | Group chats, mention-gated | M | Telegram groups and Discord channels; no private memory in groups; only the owner can approve |
| 2.2 | Host-tools exec profile with named-secret injection | M | Opt-in profile with the real `HOME` and secrets injected by name, so CLI skills (gh, himalaya, gog, notion) work. Only ~4 of 49 OpenClaw and ~8 of 58 Hermes bundled skills work today |
| 2.3 | Model fallbacks and key rotation | M | `model.fallbacks[]` across providers |
| 2.4 | Learning loop through proposals | M | After a session, a cheaper model proposes memory and skill changes; the owner reviews them. Hermes' most-loved feature, made safe by Ruby's proposal flow |
| 2.5 | Event triggers | M | Webhooks (signed), incoming email, file changes, all feeding jobs |
| 2.6 | Headless use | S–M | `ruby run -p "…" --json`; an API to start a task and stream its events |
| 2.7 | Session modes | S | Read-only/plan, normal, and auto-approve-within-scope per session |
| 2.8 | Hooks | M | Owner scripts around tool calls and turns, run outside the process; they can only tighten permissions; every decision logged |
| 2.9 | Email channel and connector presets | M | IMAP in, SMTP out; ready-made MCP configs for mail, calendar and drive |
| 2.10 | Dollar cost per turn and budget caps | S–M | Cost is the top complaint about OpenClaw; Ruby has token usage already |
| 2.11 | Persona as workspace files with a larger budget | M | SOUL/AGENTS/USER files instead of one 4,000-character config string; OpenClaw's AGENTS template alone is 6.6k |
| 2.12 | Load the workspace `AGENTS.md`; let skills read their `references/` and `scripts/` | S | Agent Skills and AGENTS.md compatibility |

## Tier 3: later or larger

| Feature | Effort | Notes |
| --- | --- | --- |
| WhatsApp | L | Skipped for now (owner decision): only unofficial bridges work for personal accounts |
| Slack, Matrix | M each | |
| Browser use | S on top of MCP | Playwright MCP in Docker; L if built into Ruby |
| Subagents (`delegate`, up to two levels) | M | Owner decision: must have. Moved into the build; see Build order |
| Ruby as an MCP server | S after 1.6 | Ask Ruby, read memory, create tasks |
| `/v1/responses` (Open Responses) | S–M | |
| File snapshots and `/rewind` | M | Rewind is a new event; the log stays append-only |
| Voice replies (TTS voice notes) | S | Realtime voice stays a non-goal |
| Streaming replies to channels, inline approval buttons, SSH sandbox | M each | Promised in PLAN.md, not built |
| Data retention for inbox, outbox, job runs and approvals | S | Found in the polish pass |
| Dashboard session cookie (HttpOnly, SameSite=Strict) | S–M | Found in the polish pass |
| A2A | M | Low value for a personal agent |

## Decisions (2026-10-06)

1. **Name:** gem-name alternatives under review; see the session notes. No rename yet.
2. **Subagents:** in scope, one to two levels deep.
3. **WhatsApp:** skipped for now.
4. **No version split.** Everything here is in scope; build as much as possible, polished.

## Build order

- **Wave 1 (done):** Tier 0 (all), 1.1 containment + 1.2 web tools, 1.3 scheduling and messaging, 1.4 media.
- **Wave 2 (deferred for budget):** subagents, 1.5 session search, 1.6 MCP client, 2.1 groups, 2.2 host-tools exec with named secrets, 2.3 model fallbacks.
- **Wave 3:** the rest of Tier 2, then Tier 3 by value.
