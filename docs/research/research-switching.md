# Switching to Ruby on day one: what breaks or gets lost (2026-10-06)

The question: **"What breaks or is lost on day one if I replace OpenClaw or Hermes with Ruby?"**

**Method.** I read Ruby's `src/migrate/*` (plan, apply, cli), `src/main.ts`, `src/config/schema.ts`, `src/gateway/{gateway,http,admin}.ts`, `src/channels/telegram.ts`, `src/scheduler`, `src/sandbox`, `src/tools/builtin`, `src/skills`, `src/context/builder.ts`, `src/models` and `src/cli/setup`. For Hermes I used the local clone at `/home/user/nousresearch/hermes-agent` (docs and `cron/jobs.py`). For OpenClaw I fetched live docs from `raw.githubusercontent.com/openclaw/openclaw/main` (`docs/gateway/openai-http-api.md`, `heartbeat.md`, `automation/cron-jobs*`, `concepts/agent-workspace.md`, `channels/pairing.md`, the workspace templates) and sparse-cloned its `skills/` folder (49 bundled skills).

**Limits.** I ran nothing live: no real Open WebUI, LibreChat or OpenAI SDK against Ruby, and no real provider calls. Claims about client behavior come from their documented or well-known request shapes. Each such claim is marked **[unverified live]**.

Legend: **Import** = what `ruby import` does. **Runtime** = whether Ruby supports it once running. **Effort**: S ≈ under a day, M ≈ a few days, L ≈ a week or more.

---

## 0. Bottom line

`ruby import` handles the **text** well: curated memory, persona, and skill bodies. It is careful (dry run by default, no secrets, never overwrites) and idempotent.

Day one still breaks, because what users rely on is the **behavior**:

- The agent has **no web access**.
- It **cannot run** the CLI tools most skills wrap.
- **Scheduled jobs don't come over**, and the agent cannot create them from chat.
- **Groups, Discord servers, WhatsApp, Slack and voice notes** go silent.
- API frontends like **Open WebUI collapse every chat into one conversation**.

A typical OpenClaw or Hermes user who switches today gets a polite notes-and-files bot on Telegram DMs, with a shorter memory than before.

---

## 1. Realistic OpenClaw switcher

**Setup.** OpenClaw 2026.9.x on a Mac mini or VPS:

- **Channels:** Telegram DM, WhatsApp, a Discord server channel.
- **Automations:** a 30-minute heartbeat; cron jobs for a morning brief and an inbox digest.
- **Workspace:** SOUL, IDENTITY, AGENTS (with the `## Tools` section), USER and MEMORY files, plus `memory/YYYY-MM-DD.md`.
- **Skills:** bundled ones (`weather`, `github`, `gog`, `summarize`, `himalaya`) plus a few from ClawHub.
- **Models:** OpenRouter or OpenAI, with a fallback chain.
- **Integrations:** MCP servers; Open WebUI pointed at the gateway's `/v1/chat/completions`.

| Item | `ruby import` | Ruby runtime | Minimal change for a seamless switch |
| --- | --- | --- | --- |
| **SOUL.md + IDENTITY.md** | Folded into `config.persona`, capped at 4,000 chars total (`plan.ts` `PERSONA_MAX`). Truncated with a note; originals copied to `workspace/imported/openclaw/`. | Persona is appended under "Owner's standing instructions". The fixed prompt still opens with "You are Ruby…" (`context/builder.ts`), and `/start` replies "Hi! I'm Ruby" (`gateway.ts`). An imported name like "Molty" competes with "Ruby". | Make the first line use the configured name (setup's `Your name is X` block exists). Have the importer parse the IDENTITY.md name into that block. **S** |
| **AGENTS.md** (operating rules; since 9.x also the `## Tools` section) | Included in the persona only "if room". The template alone is about 6.6k chars, so in practice it is **mostly cut**. Original archived. | OpenClaw injects up to 20k chars per file and 60k total. Ruby has 4k for everything. Standing orders and tool notes are lost from the prompt. | Load persona files from disk (e.g. `<home>/persona/*.md`) with a larger, configurable budget, frozen per session as now. **M**. Stopgap: raise `persona` max. **S** |
| **USER.md** | Each line becomes an entry in Ruby `USER.md`. The cap is **1,400** chars vs OpenClaw's 4,000, so the oldest lines are dropped. Superseded directives are imported too. | Bounded snapshot works. | Importer sets `memory.userChars` / `memoryChars` to fit the import, up to the existing 20k schema max, and asks first. **S** |
| **MEMORY.md** | Each line is an entry; only the **most recent ~2,200 chars** are kept. Full file archived. | Works as a bounded memory. | Same cap bump. **S** |
| **memory/YYYY-MM-DD.md** daily notes | Copied to `workspace/imported/openclaw/memory/`. Not loaded. | No `memory_search` / `session_search` tool. PLAN.md claims FTS5 session search, but it is not built. The agent doesn't know the archive exists. | Add one line to the system prompt (or memory) pointing at `imported/…`. **S**. A real search tool over workspace notes and sessions. **M** |
| **HEARTBEAT.md** | Copied only if present. **Since 2026.9.x OpenClaw has retired HEARTBEAT.md and TOOLS.md.** The heartbeat checklist ("monitor scratch") lives in `~/.openclaw/state/openclaw.sqlite`, so current users get **nothing**. | A `heartbeat` job exists (`everyMinutes` ≥ 5, cheap pre-checks, `NOTHING_TO_REPORT` silence). Not supported: active hours, running in the main session (Ruby uses a separate `job:<id>` conversation), and the legacy `HEARTBEAT_OK` token. If a user pastes old instructions saying "reply HEARTBEAT_OK", Ruby forwards that text to Telegram every run. | Treat `HEARTBEAT_OK` as an alias of `NOTHING_TO_REPORT`. **S**. Importer reads the checklist from `openclaw automations scratch <id>` output or a JSON export and drafts a disabled heartbeat job. **M**. Add `activeHours`. **S** |
| **Cron / automations** (morning brief, digests, one-shot reminders) | Not imported. They now live in SQLite; the plan only says "openclaw.json … cron jobs are not imported". | Config-only jobs (cron or heartbeat). No **one-shot** jobs ("remind me at 5pm"). No agent `cron`/schedule tool, so nothing can be created from chat (`schedule.edit` is a declared capability with no tool). No per-job model. `notify` needs a raw `chatId`: `ruby pair list` shows sender IDs, not chat IDs (identical for Telegram DMs, **different for Discord DMs**). A reply to a job's message lands in the chat's conversation, which never saw the job output (`gateway.notify` only enqueues), so "tell me more" has no context. | (1) A `schedule` tool behind `schedule.edit: ask`. **M**. (2) One-shot jobs. **S–M**. (3) `ruby jobs add` that picks the notify chat from paired identities. **S**. (4) Record notified text in the target chat's session as an assistant event (append-only, so it is allowed). **S** |
| **Telegram DM** | Detected; token not copied. | Works: long-poll, with `deleteWebhook` on start. Replies are plain text, so markdown shows raw `**`. Must stop OpenClaw first or both hit 409 on the same token. | Send `parse_mode` HTML with a markdown→HTML converter and plain-text fallback. **S** |
| **Telegram / WhatsApp / Discord groups** | — | **All non-private messages are ignored** (`gateway.ts` `dispatch`). The Discord adapter passes guild messages, and the gateway drops them. Users who talk to the bot in a Discord server channel get silence. | Mention-gated group support with no private memory and tool-less or narrowed permissions. **M** |
| **WhatsApp** (OpenClaw's origin channel), iMessage, Slack, Matrix… | Detected and listed as not imported. | **Absent.** Only Telegram, Signal and Discord. | WhatsApp via an out-of-process bridge, following the signal-cli pattern. **L**. Slack. **M** |
| **Voice notes / photos / files** | — | Telegram drops any message without `text` (`telegram.ts:214`), so **the user gets no reply at all**. Contracts are text-only. | Day-one minimum: reply "I can't read voice notes/photos yet". **S**. Transcription and vision. **M–L** |
| **Pairing / allowlists** (`allowFrom`, pairing store in SQLite) | Not imported. | Each sender must message the bot and the owner runs `ruby pair approve <code>` within 60 minutes. No `pair add <channel> <id>`. **Every paired identity is effectively an owner**: same `default` memory namespace, and any of them can `/approve`. | `ruby pair add <channel> <id>`, and import Hermes `*_ALLOWED_USERS` and OpenClaw `allowFrom` IDs as pre-approved identities after confirmation. **S**. Per-identity roles and namespaces. **M** |
| **Skills** (workspace and managed `~/.openclaw/skills`) | Imported with `SKILL.md` body and description. Frontmatter `metadata` (`requires.bins`, env, OS) is dropped. Supporting `scripts/` and `references/` are copied to `workspace/imported/openclaw/skills/<name>/`, but the body still says `{baseDir}/scripts/…`, which is not rewritten. **Bundled skills** (`weather`, `github`, `gog`…) live in the npm package and are **not imported**. | See §3: most skills fail for lack of exec, network or CLIs. | Rewrite `{baseDir}` to the archived path. Keep `metadata` and hide skills whose required bins are missing from the index. **S** |
| **Models / fallbacks** (`openclaw.json`, auth profiles) | Not imported; env var names listed. | Anthropic or OpenAI-compatible only. **No OAuth subscriptions** (Codex/ChatGPT), **no cross-provider fallback chain**, no key rotation, no per-job model. The OpenAI-compatible adapter always sends `max_tokens` (default 32k). OpenAI reasoning models (o-series, GPT-5) reject `max_tokens` and require `max_completion_tokens` **[unverified live]**. A 32k cap also exceeds many local servers' context limits (vLLM rejects prompt + max_tokens > max_model_len). | Send `max_completion_tokens` for `api.openai.com`, and clamp to `contextWindow`. **S**. Add `model.fallbacks: [{provider, name, baseUrl}]`. **M** |
| **MCP servers** | Not imported. | **No MCP client.** | Stdio/HTTP MCP client whose tools are bound at session start (fixed tool set), with each server under a capability. **M–L** |
| **Open WebUI → OpenClaw `/v1/chat/completions`** | — | See §4: one shared conversation, background tasks become agent turns, and more. | §4 fixes |
| **Multiple agents** (`workspace-<id>`, bindings) | Warns and suggests `--from`. | One agent per `RUBY_HOME`. The service unit is hard-coded to `ruby.service` / one launchd label, so a second instance overwrites the first. | `ruby service install --name`. **S**. Document "one RUBY_HOME per agent". |
| **Custom workspace path** (`agents.defaults.workspace`, `OPENCLAW_PROFILE`, `OPENCLAW_WORKSPACE_DIR`, old `~/openclaw`, `~/.clawdbot`) | Only `<home>/workspace` or `--from`. With a custom path the plan is **silently near-empty**. | — | Read `agents.defaults.workspace` from `openclaw.json` and honor the env vars. Warn when no workspace files are found. **S** |
| **Secrets** (`.env`, inline keys) | Names only (correct by design). | Re-enter each value. | Optional `ruby secrets import-env --from ~/.openclaw/.env`, asking per name. **S** |

---

## 2. Realistic Hermes switcher

**Setup.** Hermes v0.21 on a $5 VPS:

- **Channels:** Telegram plus a Discord server.
- **Automations:** 10–30 `cronjob`s created in chat; some no-agent script jobs.
- **Memory and skills:** `MEMORY.md`/`USER.md` (`§` entries); 30 agent-created skills plus bundled ones.
- **Models:** OpenRouter with `fallback_providers`.
- **Integrations:** a couple of MCP servers; Open WebUI on `:8642`; maybe a second profile (`~/.hermes/profiles/work`).

| Item | `ruby import` | Ruby runtime | Minimal change |
| --- | --- | --- | --- |
| **MEMORY.md / USER.md** (`§`-delimited) | Parsed correctly (`parseDelimitedEntries`). Hermes caps (2,200 / 1,375) ≤ Ruby (2,200 / 1,400), so **everything fits**. Entries over 500 chars are shortened (`MAX_ENTRY_CHARS`). | Equivalent frozen snapshot. Good parity. | — |
| **SOUL.md** | Becomes the persona. | Same "You are Ruby" caveat as OpenClaw. | Same **S** fix |
| **External memory provider** (Honcho, mem0, Hindsight…) | Not mentioned. | None. | Note in the plan. **S** |
| **Skills** (`skills/<category>/<name>`) | Imported; bundled skills skipped via `.bundled_manifest` (`name:hash`). Bundled skills the **user edited** (hash differs) are skipped too, so their customizations are lost. | Imported as provenance `user`, so locked (good). Agent-created skills lose their "agent" status and Curator history; the agent can only propose changes, while in Hermes it patched them itself. | Compare the manifest hash and import edited bundled skills. **S** |
| **Cron jobs** (`~/.hermes/cron/jobs.json`: `schedule.kind` cron/interval/once, `prompt`, `skills`, `deliver`, `model`, `script`, `no_agent`) | **Not imported**; only "recreate them under jobs in config.json". This is the **stickiest asset** ("I run 28 cron jobs"). | `cron` maps to a cron job and `interval` to a heartbeat (≥ 5 min). Unsupported: `once`, script-only/no-agent jobs, attached skills, per-job model, `deliver: origin`, `TELEGRAM_HOME_CHANNEL`. | Importer converts `jobs.json` cron and interval jobs into **disabled** Ruby jobs. It inlines a "use skill X" line, maps `deliver` to `notify` when a chat ID is known, and lists the rest. **M** |
| **Gateway allowlists** (`TELEGRAM_ALLOWED_USERS`, `DISCORD_ALLOWED_USERS`…) | Names are noted as "secrets"; values are never read. | Pairing only. | Treat `*_ALLOWED_USERS` as non-secret and offer to pre-pair those IDs. **S** |
| **Discord server use, groups, WhatsApp, Slack, Email, 30+ other platforms** | Detected. | DMs only, and only on Telegram, Signal and Discord. | As in §1 |
| **Voice memos / images / `MEDIA:` deliverables** | — | Dropped silently. | As in §1 |
| **Tools: `web_search`/`web_extract`, `browser_*`, `patch`, `search_files`, `execute_code`, `delegate_task`, `cronjob`, `send_message`, `session_search`, `vision_analyze`, `clarify`, `todo`** | — | Ruby has `list_files`, `read_file`, `write_file`, `memory`, `skill_view/create/update` and `read_artifact`; `run_command` only if `exec` ≠ deny (default **deny**). | See §3 |
| **Model** (`config.yaml` `model`, `fallback_providers`, credential pools, Nous Portal OAuth) | Not imported. | No fallback, no pools, no Portal. Nous Portal users (whose Tool Gateway also supplied web, image and TTS) need a new API key and lose those tools. | As in §1 |
| **MCP servers** (`mcp_servers` in `config.yaml`) | Noted as not imported. | None. | As in §1 |
| **Profiles** (`~/.hermes/profiles/<name>`, same layout) | **Not detected.** No warning, unlike OpenClaw's `workspace-*`. `HERMES_HOME` is not honored. | One agent per `RUBY_HOME`; service name fixed. | Warn per profile with the `--from` command, and honor `HERMES_HOME`. **S** |
| **Session history** (`state.db`) | Not imported (stated). | — | Acceptable |
| **Chat commands** `/model`, `/retry`, `/undo`, `/usage`, `/status`, `/cron`, `/<skill>` | — | Gateway handles only `/start`, `/new`, `/stop`, `/approve`, `/deny`. Others go to the model as plain text. | Add `/usage`, `/status`, `/retry`. **S** each |
| **API server** (`:8642`, `API_SERVER_KEY`, stateless chat completions, `/v1/responses`, `X-Hermes-Session-Id`, CORS opt-in, keepalives) | — | See §4. | — |

---

## 3. Skill compatibility (sampled real skills)

### Tool surface comparison

Ruby's whole tool surface is `list_files`, `read_file` (text only), `write_file` (whole-file replace) and `run_command`. That last one is:

- absent by default (`exec: deny`, so the tool isn't even registered; `main.ts`);
- when enabled with the Docker backend: `debian:stable-slim`, **`--network none`**, read-only root, workspace-only mount, `HOME=/tmp`, and no host binaries or credentials;
- when enabled with the local backend: `HOME=<workspace>` (`sandbox/local.ts:48`), so `gh`, `gog`, `himalaya` and similar **lose their `~/.config` auth**.

PLAN.md promises "credentials injected into tools by name". **That is not implemented**: `run_command` has no env or secret parameter. Skills that need `TRELLO_API_KEY`, `OPENAI_API_KEY` and so on cannot get them.

**OpenClaw bundled skills** (49, counted from `skills/*/SKILL.md`):

- **40/49** declare `requires.bins` (`gh`, `gog`, `himalaya`, `summarize`, `obsidian`, `ntn`, `curl`/`jq`, `claude`, `mcporter`…). They need host exec with the user's real environment.
- 8 are macOS-only; 4 need env API keys.
- Of the 9 without `requires`:
  - `weather` needs `web_fetch` or `curl` with network;
  - `clawhub`, `control-ui` and `node-connect` are OpenClaw-specific;
  - `healthcheck` needs exec;
  - only `skill-creator`, `diagram-maker`, `visualize` and `spike` are plausibly usable.

**Roughly 4 of 49 work in Ruby as-is.** Bundled skills aren't imported anyway.

**Hermes bundled skills** (58):

- 33 reference `terminal`/`execute_code`.
- 15 reference `web_search`/`web_extract`/`browser_*`.
- Also referenced: `delegate_task` (21 across bundled and optional), `cronjob` (11), `patch` (14) and `vision_analyze` (16).
- Only **about 8 are pure instructions** with no tool or shell use: `weekly-review-planning`, `meeting-action-items`, `email-inbox-triage` (which still needs mail access), `songwriting`, `humanizer`-style creative ones, `claude-design`, `p5js`, and `github` (prose only).

### Sampled popular skills

| Skill (source) | Needs | Ruby day one |
| --- | --- | --- |
| `weather` (OC) | `web_fetch` or `curl wttr.in` | **Fails**: no web tool; the sandbox has no network |
| `github`, `gh-issues` (OC/H) | `gh` + host auth | **Fails**: exec off; Docker lacks `gh` and network; local hides `~/.config/gh` |
| `gog` / `google-workspace` (OC/H) | `gog`/`gws` CLI + OAuth | **Fails** (same reason). The morning brief depends on this |
| `himalaya` email (OC/H) | CLI + IMAP creds | **Fails** |
| `summarize`, `youtube-content` (OC/H) | CLI + network | **Fails** |
| `notion`, `trello`, `openai-whisper-api` (OC) | `curl` + API key env | **Fails**: no network by default; no secret injection |
| `obsidian` (OC/H) | `obsidian` CLI, or vault files | **Partial**: works only if the vault is inside the Ruby workspace (read/write_file) |
| `product-price-monitor`, `competitor-news-monitor` (H) | `web_search`, `web_extract`, `browser_navigate`, `cronjob` | **Fails** on all four tools |
| `arxiv` (H) | `web_extract` + scripts | **Fails** |
| `coding-agent` / `claude-code` / `codex` (OC/H) | Host `claude`/`codex` binaries, background processes | **Fails** |
| `mcporter` (OC) | MCP CLI | **Fails** (no MCP either) |
| `weekly-review-planning`, `meeting-action-items` (H) | Instructions only | **Works** |

### Missing-tool ranking

Ordered by how many sampled skills break without the tool:

1. Host exec with the user's environment and network
2. `web_fetch`
3. `web_search`
4. Scheduling (`cron`/`cronjob`)
5. A targeted file edit (`patch`/`edit`)
6. `send_message` to a channel
7. Browser
8. Vision / STT
9. Subagents (`delegate_task`)

### Minimal fixes for skills

- **`web_fetch` tool** (S–M): behind `net.fetch: ask` (the capability already exists), with an SSRF guard, host scopes, and a readability-to-text conversion. A keyless search provider (SearXNG URL or DuckDuckGo HTML) adds **M**.
- **"Host tools" exec profile** (M), opt-in: local backend that keeps the real `HOME`, plus per-command env injection of **named** secrets via `ruby.secret(name)`. Docker `network: bridge` with a user-chosen image. Document a recipe image (`curl`, `jq`, `gh`, `python3`).
- **`edit_file` tool** (S): exact-match replace.
- **`send_message` tool** (S–M): behind `message.send: ask`, limited to paired chats.
- **Importer** (S): rewrite `{baseDir}`, keep `metadata`, and flag skills whose bins aren't on PATH or that reference tools Ruby lacks. Show these in `ruby skills` as "needs: web_fetch, gh".

---

## 4. Ruby's OpenAI-compatible API vs common clients

Source: `src/gateway/http.ts`.

**What Ruby does:**

- **Routes:** `GET /v1/models` returns one model, `ruby`. `POST /v1/chat/completions` supports `stream` true or false.
- **Request handling:** the zod body schema is non-strict, so unknown fields (`tools`, `tool_choice`, `user`, `temperature`, `stream_options`, `max_tokens`) are **silently ignored**. **Only the last message is used.** It must be `role: user`, and only its text parts are kept (images dropped). Client `system` messages are ignored.
- **Conversation:** chosen by the `X-Ruby-Conversation` header (default `default`) per key.
- **Streaming:** the first chunk is `{role: assistant}`, then text deltas, a finish chunk and `[DONE]`. There are no keepalives. Usage is reported only in non-stream mode.
- **Auth:** `Authorization: Bearer ruby_<id>_<secret>` keys only.
- **CORS:** no headers and no OPTIONS handling.

| Client behavior | Ruby result | Severity | Minimal fix |
| --- | --- | --- | --- |
| **Open WebUI / LibreChat / NextChat send the full history, statelessly, per chat.** None of them send `X-Ruby-Conversation`. | **Every chat from that key shares one server-side conversation** (`default`). Starting a "New chat" in Open WebUI doesn't start a new Ruby conversation, and context bleeds between chats. Hermes is stateless by default; OpenClaw is stateless and keys sessions from the OpenAI `user` field. | **High** | Derive the conversation from, in order: `X-Ruby-Conversation`, Open WebUI's forwarded `X-OpenWebUI-Chat-Id` (with `ENABLE_FORWARD_USER_INFO_HEADERS`), the `user` field, or a hash of the first user message plus the key. **S** |
| **Open WebUI background tasks** (title, tags, follow-ups, autocomplete) go to the selected model as normal non-stream requests | Each runs as a **full agent turn, with tools and memory writes, appended to the user's conversation**. Tokens are wasted and history polluted. **[unverified live]** | **High** | Detect task prompts (e.g. a request whose last user message embeds `<chat_history>`, or a `metadata.task` field), or offer a stateless "utility" mode for requests with ≥ 2 user messages that don't match the session. Simplest: document "set Open WebUI's Task Model to an external model". **S** |
| **Regenerate / edit message** resends the same or edited last message | A duplicate turn is appended; the old answer stays in history. | Med | With the per-chat key above, detect a resend (same text as the last user turn) and branch from it, or ignore. **M** |
| **`tools` / `tool_choice` / `role: tool`** (LibreChat agents, n8n AI Agent, LangChain, Vercel AI SDK, Continue/Cline) | `tools` is ignored, so the client never gets `tool_calls`. A request whose last message is `role: tool` gets 400. **Any history message with `content: null`** (an assistant message that carried `tool_calls`) fails zod validation with **400**, because the whole array is validated even though only the last message is used. | Med for these clients | Accept `content: null`/missing on non-last messages. **S**. Client-side tools: document them as unsupported (Ruby runs its own tools). Hermes doesn't support them either; OpenClaw does. |
| **Images** (`image_url` parts) | Silently dropped; image-only messages get 400. | Med | Return a clear 400 `unsupported_content_type` like Hermes. **S**. Vision later. |
| **`POST /v1/responses`** (OpenAI Agents SDK default, Codex-style clients, Responses-mode frontends) | 404. Hermes and OpenClaw both serve it. | Med | Minimal Responses endpoint mapping `input` to a turn, with `previous_response_id` and `conversation` keys. **M** |
| **Long tool runs while streaming** | No bytes are sent between the role chunk and the first text, so reverse proxies (nginx 60 s by default, Cloudflare 100 s) and client idle timeouts cut the stream. Hermes sends `: keepalive` every 10 s. | Med | Write `: keepalive\n\n` every 10–15 s. **S** |
| **Browser-direct clients** (TypingMind, NextChat client mode, BetterChatGPT) | The preflight `OPTIONS` falls into auth and gets 401, with no CORS headers, so they fail. | Low–Med | `api.corsOrigins` opt-in. **S** |
| **`GET /v1/models/{id}`** (some SDK and IDE clients) | 404 | Low | Add it. **S** |
| **`stream_options.include_usage`** | No usage chunk | Low | Emit a final usage chunk. **S** |
| **Approvals from an API chat** | The reply shows `/approve CODE`, but typing that in Open WebUI just goes to the model as text, because `chatCompletions` bypasses `dispatch`. Only a paired chat, the dashboard or `POST /api/approvals/:code/approve` (admin key) works. | Med | Handle `/approve` and `/deny` in `gateway.chat` for API keys with the `chat` scope (owner key). **S** |
| **Existing client config** (Hermes `:8642` with a self-chosen `API_SERVER_KEY`; OpenClaw `:18789` with the gateway token; model ids `hermes-agent` / `openclaw`) | Port 7311 and a generated `ruby_…` key mean every client must be edited. Model ids are ignored (fine), but Open WebUI chats saved with the old model id show "model not found" until reselected. | Low (one-time) | Configurable advertised model id or aliases. **S**. Optional: `api.port` already configurable. |

Note: Ruby's "server keeps the state, client sends only the newest message" design is fine for Ruby-aware clients and the dashboard. For generic OpenAI frontends it is the wrong default. Neither predecessor works that way, so switchers will notice immediately.

---

## 5. Ranked day-one blockers (with minimal fixes)

Ranked by (share of switchers hit) × (severity):

1. **No web access.** No `web_fetch`/`web_search`; the Docker sandbox has no network. Weather, news, research, briefings, price monitors and URL summaries all fail.
   - Fix: `web_fetch` behind `net.fetch: ask` with an SSRF guard (**S–M**), plus one keyless search backend (**M**).
2. **Scheduled work doesn't survive the move, and can't be recreated from chat.**
   - Hermes `cron/jobs.json` and OpenClaw automations (now in SQLite) aren't imported. No `schedule` tool. No one-shot reminders. `notify` needs a raw chat ID. Replies to job messages lack context.
   - Fix: importer converts Hermes cron/interval jobs to **disabled** Ruby jobs (**M**); `schedule` tool behind `schedule.edit: ask` (**M**); one-shot jobs (**S–M**); write notify text into the target chat's session (**S**); `HEARTBEAT_OK` alias (**S**).
3. **Skills that wrap CLIs or APIs can't run.**
   - `exec` is denied by default. Docker has no tools, no network and no auth. Local mode hides `~/.config`. No named-secret injection. Bundled skills aren't imported. Script paths (`{baseDir}`) break.
   - Fix: an opt-in "host tools" exec profile (real `HOME`, named-secret env injection) (**M**); importer rewrites `{baseDir}`, keeps `metadata`, and flags skills whose bins or tools are missing (**S**).
4. **Silent channels.** Groups and Discord server channels are ignored; voice, photo and file messages are dropped with **no reply**; WhatsApp and Slack are absent.
   - Fix: reply "can't handle voice/photos yet" (**S**); mention-gated groups without private memory (**M**); WhatsApp bridge (**L**).
5. **API frontends misbehave.** All Open WebUI/LibreChat chats share one conversation. Background title and tag tasks become agent turns. `content: null` history gets 400. No keepalive. No `/v1/responses`. No CORS. `/approve` doesn't work over the API.
   - Fix: per-chat conversation key from `X-OpenWebUI-Chat-Id`, `user` or a hash (**S**); accept null content (**S**); keepalive (**S**); API `/approve` (**S**); CORS opt-in (**S**); Responses API (**M**).
6. **Persona and memory get squeezed.**
   - SOUL+IDENTITY+AGENTS (with the Tools section) must fit in 4,000 chars. OpenClaw USER.md goes from 4k to 1.4k; MEMORY.md is cut to the last 2.2k. Daily notes are unsearchable. "You are Ruby" overrides the imported name.
   - Fix: importer offers to raise `memory.*Chars` to fit (**S**); name-aware prompt line (**S**); point the agent at `imported/` (**S**); file-based persona with a bigger budget (**M**); notes and session search tool (**M**).
7. **Model access and resilience.**
   - No OAuth subscriptions (Codex/ChatGPT, Nous Portal). No fallback chain. OpenAI reasoning models likely reject `max_tokens` **[unverified live]**. A 32k output cap can exceed local servers' limits.
   - Fix: send `max_completion_tokens` for OpenAI and clamp to `contextWindow` (**S**); `model.fallbacks[]` list (**M**).
8. **No MCP client.** Gmail, Calendar, Notion and Home Assistant via MCP are gone.
   - Fix: MCP client bound at session start, with servers gated by a capability (**M–L**).
9. **Multi-user and multi-agent.**
   - Allowlists aren't imported. Every paired person shares owner memory and approval rights. Hermes profiles aren't detected. The service unit name is fixed.
   - Fix: `ruby pair add` plus importing `*_ALLOWED_USERS` / `allowFrom` (**S**); profile warnings and `HERMES_HOME` (**S**); `service install --name` (**S**); per-identity roles and namespaces (**M**).
10. **Paper cuts.**
    - No current date/time in interactive turns (add a timestamp envelope to user messages, not the system prompt) (**S**).
    - Telegram shows raw markdown (**S**).
    - Import after `ruby setup` leaves the persona `kept-existing` with a terse message (append the imported text outside the setup block) (**S**).
    - Custom OpenClaw workspace path or profile isn't found, and the importer gives no warning (**S**).
    - Edited Hermes bundled skills are skipped (**S**).
    - Missing chat commands: `/usage`, `/status`, `/retry` (**S**).

### Cheapest bundle that changes the day-one experience

About a week of S/M work:

- `web_fetch`
- A schedule tool
- The Hermes cron importer
- Per-chat API conversation keys plus keepalive and null-content fixes
- A "can't read media" reply
- The cap bump at import
- `{baseDir}` rewrite and missing-dependency flags
- `pair add`

Groups, WhatsApp, MCP and host-exec-with-secrets are the larger follow-ups.

---

## 6. Verified vs not verified

**Verified by reading code:**

- Importer mapping, caps, skips and archive behavior (`src/migrate/plan.ts`, `apply.ts`).
- Tool set and the exec default (`main.ts`, `config/schema.ts`).
- Group drop (`gateway.ts` `dispatch`); Telegram drops non-text messages (`telegram.ts:214`).
- `notify` doesn't touch the session.
- API last-message-only, header-keyed conversations, zod schema shape, no CORS or keepalive (`http.ts`).
- Local sandbox `HOME=workspace`; no secret injection in `run_command`.
- `max_tokens` is always sent (`openai-compatible.ts`); service unit name is fixed; no date in the interactive prompt.

**Verified from the source projects' docs or code:**

- OpenClaw: HEARTBEAT.md and TOOLS.md retired; jobs and pairing in `~/.openclaw/state/openclaw.sqlite`; 20k/60k bootstrap budgets; USER.md 4k; stateless `/v1/chat/completions` with `user`-keyed sessions and client tools; `/v1/responses`.
- Hermes: `cron/jobs.json` schema fields; stateless chat completions, `/v1/responses`, keepalives, CORS opt-in; `*_ALLOWED_USERS`; profiles layout; `.bundled_manifest` `name:hash`.
- Skill requirement counts come from the actual SKILL.md files.

**Not verified live:**

- Real Open WebUI, LibreChat or SDK traffic against Ruby (title-task pollution, regenerate, timeouts).
- OpenAI's current rejection of `max_tokens` for GPT-5/o-series.
- Which ClawHub community skills are most installed (the registry was not queried; I sampled bundled skills, which are what most users run).
