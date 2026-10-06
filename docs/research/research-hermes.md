# Hermes Agent (Nous Research): research for Ruby, 2026-10-06

## How this was researched, and what could not be checked

- **[R] Repo**: I shallow-cloned `NousResearch/hermes-agent` at commit `4787e4d` (2026-10-05) to `/home/user/nousresearch/hermes-agent` and read its README, SECURITY.md and docs (`website/docs/**`, which is the source of hermes-agent.nousresearch.com/docs), and some code. Claims marked [R] come from that checkout.
- **[S] Sourced**: web pages I fetched, with the URL given. github.com pages could be fetched.
- **[S-snippet]**: the sandbox's egress policy blocked these domains: news.ycombinator.com, hn.algolia.com, reddit.com, nousresearch.com, turingpost, lumadock, thetoolnerd, gauraw, kilo.ai, dupple, aiagentstore, cloudsecurityalliance, repello and others. For those I only have what the search engine's summary said about the page, so treat them as weaker evidence.
- **[Q] Curated quotes**: Hermes' docs site ships `website/src/data/userStories.json`, a file of 326 community quotes, each with a source URL (116 Discord, 61 X, 60 Reddit, 38 GitHub, 20 blog, 17 YouTube, 4 HN). It is a handy quote source, but Nous chose the quotes, so it is biased toward praise.
- **[I] Inferred**: my own judgement.
- **[Ruby] Verified in Ruby**: checked against `/home/user/Ruby/src`.

---

## 1. What Hermes Agent is today

### Identity and adoption

| Claim | Evidence |
| --- | --- |
| An MIT-licensed "self-improving AI agent" by Nous Research. Its pitch is a "closed learning loop": it creates skills from experience, improves them during use, is nudged to persist knowledge, searches its own past sessions, and models the user | [R] README.md |
| Launched in February 2026 | [S-snippet] https://getcoai.com/article/hermes-ai/ ; https://aiweekly.co/alerts/nous-research-nears-75m-round-at-15b-valuation-for-hermes |
| **About 251.5k stars, 54.0k forks, 49,045 commits, 5k+ open issues and 5k+ open PRs**. The issue tracker shows about 33.5k total issues | [S] https://github.com/NousResearch/hermes-agent (fetched 2026-10-06) ; https://github.com/NousResearch/hermes-agent/issues |
| Early growth: about 22k stars and 242 contributors "within weeks" of launch | [S-snippet] search summary of mexc.com news |
| Release cadence: v0.21.5 on 2026-09-24 (about 460 PRs since v0.21.4), v0.21.4 on 09-21 (1,812 merged PRs), v0.21.3 on 09-14. Versions also carry a date tag (v2026.9.24) | [S] https://github.com/NousResearch/hermes-agent/releases |
| Ranked #1 coding app on OpenRouter and was "closing in" on #1 overall | [S-snippet] https://news.ycombinator.com/item?id=47754556 |
| Nous is raising about $75M at a $1.5B valuation (led by Robot Ventures, with USV participating) | [S-snippet] https://aiweekly.co/alerts/nous-research-nears-75m-round-at-15b-valuation-for-hermes ; HN https://news.ycombinator.com/item?id=48903272 |
| Hermes Desktop (native macOS/Windows/Linux app) entered public preview on 2026-06-02 at v0.15.2. It was demoed in Jensen Huang's GTC keynote | [S-snippet] https://www.marktechpost.com/2026/06/03/nous-research-releases-hermes-desktop-a-native-cross-platform-front-end-for-hermes-agent-v0-15-2-with-streaming-tool-output/ ; https://x.com/NousResearch/status/2061843507417944552 |
| Paid "Hermes Cloud" hosting exists, and Desktop auto-discovers Cloud agents | [S-snippet] https://x.com/NousResearch/status/2075675120442486931 |
| Community: its own subreddit (r/hermesagent, often cited in the quotes), a Discord, hackathons, and many third-party GUIs, bridges and memory plugins | [Q] userStories.json |
| Size: about **906k lines of non-test Python** by my count of `.py` files outside test dirs. Nous's own refactor PR says source shrank from 1,063,826 to 698,363 LOC (−34%) using 1,393 subagents. The two counts were measured differently | [R] ; [S-snippet] https://github.com/NousResearch/hermes-agent/pull/102117 |

### Feature set (all [R] from docs at `website/docs/`, unless marked otherwise)

- **Interfaces**: an Ink-based TUI (`hermes --tui`) and the classic CLI with multiline editing, slash-command autocomplete, interrupt-and-redirect and streaming tool output; Hermes Desktop (Electron); a web dashboard (`hermes dashboard`, port 9119) with themes, UI plugins and backend plugins; an ACP server for editors; an MCP server (`mcp_serve.py`); a Python library; "bot screen" (each bot gets its own Xfce desktop that streams into Desktop, so the user can take over for 2FA or CAPTCHA steps). Also 17 UI languages, CLI skins and animated "pets".
- **Messaging gateway**: one process. There are 35 messaging docs pages, covering Telegram, Discord, Slack, WhatsApp (Baileys and Cloud API), Signal, Email, SMS, Matrix, Mattermost, Teams (including meeting pipelines), Google Chat, iMessage via BlueBubbles/Photon, Home Assistant, IRC, LINE, ntfy, SimpleX, DingTalk, Feishu/Lark, WeCom, WeChat, QQ, Yuanbao, Open WebUI, A2A, generic webhooks and more. Gateway features include:
  - DM pairing codes and allowlists, with admins separated from regular users.
  - Per-channel model and system-prompt overrides.
  - A busy-input mode (queue, interrupt or steer).
  - Multi-select clarify questions and tool-progress notifications.
  - Background sessions, and "intentional silence" tokens.
  - Voice memos transcribed by STT.
  - `MEDIA:/path` tags and "deliverable mode", which send generated files as native attachments (images, PDFs, xlsx).
  - Slash commands shared with the CLI: `/new`, `/retry`, `/undo`, `/model`, `/personality`, `/compress`, `/usage`, `/insights`, `/status`, `/sethome`, `/stop`, `/<skill>`.
- **Tools** (about 100 in `reference/tools-reference.md`):
  - Shell and processes: `terminal` (with background processes and `process_manage`), `execute_code` (a Python script that calls Hermes tools over a Unix-socket RPC, "collapsing multi-step pipelines into zero-context-cost turns").
  - Files: `read_file` (converts PDF, DOCX, XLSX and ipynb), `write_file`, `patch` (fuzzy find-and-replace with 9 strategies), `search_files` (ripgrep), plus LSP diagnostics after edits (pyright, gopls, tsserver and others).
  - Web and browser: `web_search` and `web_extract` (providers: Brave-free, DuckDuckGo, SearXNG, Exa, Firecrawl, Tavily, Parallel, Perplexity, xAI and others), `x_search`, about 12 `browser_*` tools (local Chrome via Browser Use CLI, Browserbase, Browser Use cloud, Camofox, Lightpanda, raw CDP).
  - Media and desktop: `computer_use` (background desktop control on macOS, Windows and Linux), `vision_analyze`, `video_analyze`, `image_generate` (FAL), video generation, `text_to_speech`.
  - Memory, skills and sessions: `memory`, `session_search` (FTS5), `skill_manage`, `skill_view`, `skills_list`.
  - Coordination: `todo_list`, `clarify`, `cronjob_manage`, `delegate_task`, `kanban_*`.
  - Integrations: Discord admin, Spotify, Feishu, Home Assistant.
  - Tools are grouped into **toolsets** that can be switched on or off per platform. "Tool Search" adds opt-in progressive disclosure for MCP and plugin tools.
- **Memory**:
  - Built in: `MEMORY.md` (2,200 chars) and `USER.md` (1,375 chars), injected as a **frozen snapshot** with usage percentage shown, entries separated by `§`. Writes over the cap fail, and the agent must consolidate. Optional `write_approval` staging (`/memory pending`).
  - A **background review fork** runs after turns (governed by `memory.nudge_interval` and `skills.creation_nudge_interval`). It shares the parent's prompt cache, or can route to a cheaper model using a digest. The docs warn it "can burn a meaningful share of total tokens on busy hosts".
  - External memory providers through plugins (Honcho dialectic user modelling, mem0, byterover, holographic, openviking, retaindb, Hindsight, Supermemory). Only one is active at a time.
- **Skills**:
  - Format: agentskills.io `SKILL.md`, loaded by progressive disclosure. 58 bundled skills and 152 optional ones in the repo.
  - Install: a Skills Hub with a trust-tiered install and a "Skills Guard" scanner; external skill directories; project-local skills with a trust prompt.
  - Learning: `/learn` builds a skill from docs, a URL, the current conversation or a whole corpus. The agent creates and patches skills itself (`skill_manage` with create/patch/delete/write_file), and an advisory linter checks the result.
  - Upkeep: the **Curator** tracks use and moves agent-created skills through active → stale → archived, using an auxiliary-model consolidation pass. **Pinning** protects a skill from deletion, though the agent can still patch it. `skills.write_approval` (default `false`) stages every skill write for `/skills diff` and approval. Bundled skills keep their origin hash in `.bundled_manifest`, so user edits survive sync.
- **Scheduling**: the `cronjob_manage` tool, so jobs can be created in natural language from any chat, or with `/cron add "every 2h" …`.
  - Job types: one-shot and recurring; attached skills; **no-agent script-only jobs** (no LLM call at all); jobs triggered by webhooks.
  - Delivery: results go back to the origin chat or any platform.
  - Model: per-job model and reasoning-effort pins, plus a `cron.model` fleet default.
  - Safety: cron runs cannot create cron jobs.
  - In-session loops: `/heartbeat every 10m …` (a recurring prompt inside the current session), `/loop` (modelled on Claude Code's), and `/goal` (a Ralph loop: a judge model checks after each turn whether the goal is met).
- **Delegation and multi-agent**: `delegate_task` (isolated child agents that run in the background and post completions back), Mixture-of-Agents virtual models, and **Kanban** (a durable SQLite task board across "profiles", with worker lanes, reviewer handoffs and multi-gateway delivery). **Profiles** run several isolated agents, each with its own memory, gateway and config.
- **Sandboxes** (terminal backends): local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox. Modal and Daytona hibernate when idle. Whole-process wrapping via Docker or NVIDIA OpenShell. Egress controls ("iron-proxy" and network isolation docs).
- **Models**: 38 provider plugins (Anthropic, OpenAI, Codex OAuth, OpenRouter, Bedrock, Vertex, Azure Foundry, Gemini, xAI, DeepSeek, Kimi, Qwen OAuth, MiniMax, Z.ai, Ollama Cloud, Copilot, Hugging Face, NVIDIA, a custom endpoint and others).
  - Switching: `/model` changes the model at runtime.
  - Resilience: **credential pools** (rotate keys within one provider, with the docs warning that this resets the cache), **fallback providers**, and auxiliary-model routing for side tasks. Provider routing works on OpenRouter.
  - Optional Codex app-server runtime.
- **Nous Portal and Tool Gateway** (the paid upsell): one OAuth login covers 300+ models plus hosted web search, image generation, TTS and a cloud browser (`hermes setup --portal`). Reported tiers: Free, Plus $20/mo (includes the Tool Gateway), Super $100/mo, Ultra $200/mo. [S-snippet] https://www.hostinger.com/tutorials/hermes-agent-cost
- **API server**: an OpenAI-compatible endpoint behind `API_SERVER_KEY`, with run idempotency and inline tool progress when streaming. A separate "subscription proxy" exposes the user's provider subscription to other apps.
- **Security features**:
  - Approvals: dangerous-command approval with modes, YOLO mode, a hardline blocklist, deny rules, `hermes approvals suggest` (mines history for allowlist suggestions) and a permanent allowlist.
  - Filesystem and network: protected paths, an optional `HERMES_WRITE_SAFE_ROOT`, SSRF protection and website access policy.
  - Credentials: env-var filtering for subprocesses; a credential vault for browser logins (the model never sees passwords).
  - SECURITY.md is unusually candid: "**The only security boundary against an adversarial LLM is the operating system**"; the approval gate, redaction and Skills Guard are "heuristics … not boundaries"; plugins and skills run with full agent privileges. [R] SECURITY.md
- **Other**: hooks (gateway, plugin and shell hooks), a plugin system and a curated plugin catalog, checkpoints and rollback of file edits, git worktrees, `@file:` context references, context files (`HERMES.md`, `AGENTS.md`, `SOUL.md`), batch trajectory generation for training, voice mode (including Discord voice channels) and a "Hey Hermes" wake word.
- **Install and onboarding**:
  - Installers: a curl installer for Linux, macOS and WSL2; native Windows via PowerShell or MSIX; a Termux APT repo; Nix; Docker.
  - Commands: `hermes setup` wizard, `hermes doctor`, `hermes update`.
  - Migration: `hermes claw migrate` imports from OpenClaw, including allowlisted API keys (with `--dry-run` and `--preset user-data` to skip secrets). `hermes import-agent claude-code|codex` imports instructions, allowlists, MCP servers, skills and memories. The setup wizard detects `~/.openclaw` automatically.

---

## 2. Why people love it

| Theme | Evidence |
| --- | --- |
| **Memory that just works across sessions.** This is the "it remembered" moment. "Just set up Hermes Agent with Telegram. Almost no friction. The part that actually impressed me: memory works… pulled back my exact drafts and topic ideas from earlier, without me re-explaining anything." | [S-snippet] https://x.com/hqmank/status/2042949362427531348 |
| The same moment on video: "Brand new session test: it recalled everything, including preferred emojis." | [Q] https://www.youtube.com/watch?v=HdxtLpL9CC8 |
| **Skills it writes itself.** "Every time you do something… it uses that experience to create a new skill. Next time… you don't have to give it the same instructions." | [Q] https://www.youtube.com/watch?v=Mom3GVeiBR8 |
| "I run 28 cron jobs and 30+ custom skills. Every single one was built with Hermes, not downloaded." | [Q] https://www.reddit.com/r/hermesagent/comments/1udesr1/ |
| **Phone-first via Telegram or WhatsApp.** "Hermes handles the bulk of the actual implementation. It files its own tasks, writes the code, runs QA, deploys… I mostly review things over Telegram." | [Q] https://www.reddit.com/r/hermesagent/comments/1u9fa2w/ |
| A family deployment: "lives inside whatsapp and has magic proactive behaviors". | [Q] https://x.com/EXM7777/status/2049869015221510424 |
| **Cron and proactive automations** delivered to chat: daily listing emails, news triage, "18 cron jobs, 35 scripts… Total cost: $21/month" | [Q] https://x.com/witcheer/status/2037530350763524482 ; https://www.reddit.com/r/hermesagent/comments/1umvy8k/ |
| **Cheap hosting**: a $4–10 VPS, a $175 used OptiPlex, even an Android phone via Termux. "OpenClaw setup: Mac Mini M4 ($599) + Opus… ~$80–150/mo. Hermes on VPS: under $20/mo" | [Q] https://medium.com/@0xmega/hermes-agent-the-complete-setup-guide-telegram-discord-vps-no-mac-mini-required-dda315a702d3 ; https://x.com/pengsonal/status/2076665891580756285 |
| **Script-only cron** (`--script --no-agent`) praised as the hidden cost saver: "The script is the job. No agent loop, no LLM call, period." | [Q] https://www.reddit.com/r/hermesagent/comments/1uxwlyj/ |
| **Better than OpenClaw at browser automation and data wrangling**: "Hermes is dramatically better than OpenClaw at browser automation." | [Q] https://rumjahn.substack.com/p/complete-guide-to-mastering-hermes |
| **Switching from OpenClaw** because of maintenance fatigue, configs broken by updates and bloated memory. Users found Hermes more reliable, with less disruptive updates and safer defaults | [S-snippet] https://www.mindstudio.ai/blog/hermes-agent-vs-openclaw-comparison-switch ; https://www.thetoolnerd.com/p/i-tested-hermes-agent-for-a-week-openclaw-vs-hermes |
| **Any model, easy switching**, including cheap ones (MiniMax, local Qwen) for subagents | [Q] https://x.com/gkisokay/status/2044339964612362499 |
| **Hackability**: a large third-party ecosystem (web UIs, a Kid Mode, smart-glasses front ends, knowledge-graph memory, Obsidian workflows) | [Q] userStories.json, multiple |
| HN user: "Having a competent agent with constant state has been good for memorializing and organizing important info directly into Obsidian… running on a cheap VPS and it's fairly locked down." | [Q] https://news.ycombinator.com/item?id=47786673 |

[I] Across these, the delight comes from three moments: (1) a fresh session recalls something without being told; (2) the agent does something useful on a schedule and pings the phone; (3) "it made a skill on its own." Ruby has partial support for (1) and (3), and for (2) only through config-file jobs.

---

## 3. What people complain about

### Cost and token overhead
- A default install spends **16K+ tokens on a "who u?" prompt**. The issue was closed as not planned. [S] https://github.com/NousResearch/hermes-agent/issues/13983 (2026-04-22)
- **73% of every call is fixed overhead** (about 13.9K tokens), mostly tool definitions and the system prompt. [Q] https://github.com/NousResearch/hermes-agent/issues/4379 ; [S-snippet] lumadock summary.
- "Agent burns 60k–100k tokens on trivial setup tasks and delivers nothing… the deliverable is instructions for the human." Closed as not planned. [S] https://github.com/NousResearch/hermes-agent/issues/115482 (2026-09-18)
- Session fragmentation and replay wasted about 2.6M tokens a day (69%) in one heavy user's report. [S] https://github.com/NousResearch/hermes-agent/issues/5563 (2026-04-06)
- "Take the default setup at face value and you end up with a working agent and a $400 OpenRouter bill." [Q] medium.com/@anup.karanjkar08. Another user reported a "$47 surprise bill from an overnight run". [Q] https://dev.to/chintanonweb/hermes-agent-gets-smarter-every-day-so-does-the-bill-4i8o
- The background review fork "can burn a meaningful share of total tokens". [R] docs/user-guide/features/memory.md

### Reliability and data integrity
- **state.db corruption** keeps recurring:
  - 18 of 128 sessions were lost in one report ([S] #5563).
  - SIGTERM under load corrupted the DB. https://github.com/NousResearch/hermes-agent/issues/30636
  - With no recovery path, a corrupted DB is replaced by fresh empty tables. https://github.com/NousResearch/hermes-agent/issues/32687
  - FTS5 index corruption caused **about 14h of silent data loss** (2026-10-04/05). https://github.com/NousResearch/hermes-agent/issues/133375
  - FTS errors were treated as structural corruption, and the recovery advice was destructive. https://github.com/NousResearch/hermes-agent/issues/97794
  - Concurrent WAL writers on virtiofs corrupted the DB. https://github.com/NousResearch/hermes-agent/issues/110847
  - All [S-snippet] titles from search.
- **Update races**:
  - "Telegram bot token already in use after hermes update": the old process holds the poll. Closed (fixed on main). [S] https://github.com/NousResearch/hermes-agent/issues/23783 (2026-05-11)
  - The updater restarts the gateway and OOMs small VPSes. https://github.com/NousResearch/hermes-agent/issues/26770
  - A stalled event loop hangs `hermes update`. https://github.com/NousResearch/hermes-agent/issues/81642
  - An interrupted update leaves the gateway on stale code forever. https://github.com/NousResearch/hermes-agent/issues/95294
  - The updater prints a false "✓ Restarting" while the gateway is left down. https://github.com/NousResearch/hermes-agent/issues/129171
  - [S-snippet] titles.
- **Hallucinated completion**: the agent claims tools ran when they didn't, "model-agnostic". [S] https://github.com/NousResearch/hermes-agent/issues/78712 ; https://github.com/NousResearch/hermes-agent/issues/131979. "Hermes always thinks it did well." [S-snippet] aiagentstore summary. Hermes' own memory docs admit models often say "I've added that to my memory" without calling the tool. [R]
- **Silent parameter dropping**: unknown tool args are ignored and reported as success. [S-snippet] https://github.com/NousResearch/hermes-agent/issues/115641
- **Environment hallucination** after long contexts (the agent believed it ran in a cloud container). [S] #5563
- Gaps in compaction durability: ACP `/compress` state is lost on restart. [S-snippet] https://github.com/NousResearch/hermes-agent/issues/76215
- Memory caps too small for complex projects (2,200 chars). [S] #5563

### Security
- **Many CVEs in a short window.** CSA titled a note "9 CVEs in 4 Days" ([S-snippet] https://labs.cloudsecurityalliance.org/research/csa-research-note-hermes-agent-cves-20260504-csa-styled/). They include:
  - CVE-2026-7112: auth bypass in the API server's `_check_auth`, v0.8.0. https://github.com/advisories/GHSA-r7hr-pvjh-r4p3
  - CVE-2026-11461: session-resolution authorization bypass, up to v0.12.0.
  - CVE-2026-9366: prompt-pipeline injection in `_scan_context_content`, patched in 0.15.0, CVSS 5.5. The advisory says "the vendor was contacted early, they did not respond." [S] https://github.com/advisories/GHSA-pgp4-xr4j-h5cg
  - CVE-2026-10223: memory-content scanner injection.
  - CVE-2026-9350: missing authorization in `check_all_command_guards`.
  - CVE-2026-9368: `execute_code`.
  - CVE-2026-14628: path traversal in webhook `extract_media`. https://github.com/advisories/ghsa-85cr-q769-68x2
  - Except where a URL is given, these are [S-snippet] from SentinelOne, Tenable and CVEnew on X.
- **Skills Guard bypass**: a malicious hub skill exfiltrates all env vars (via dynamic import and string construction; the regex scanner checks one line at a time). CVSS 7.7, closed as not planned. [S] https://github.com/NousResearch/hermes-agent/issues/7072 (2026-04-10)
- Skill DESCRIPTION.md files were not scanned and went straight into the system prompt. https://github.com/NousResearch/hermes-agent/issues/8884
- Cron could load injected skill content with system-prompt authority. https://github.com/NousResearch/hermes-agent/issues/3968
- Snyk reportedly found 76 malicious skill payloads across agent skill registries. [S-snippet; registry scope unclear]
- **Process**: an open P3 issue asks for a security assurance baseline, covering SAST/SCA, adversarial tests, SBOM and provenance. [S] https://github.com/NousResearch/hermes-agent/issues/92618 (2026-08-23). One reporter's security email bounced. [S-snippet] https://github.com/NousResearch/hermes-agent/issues/15750. No bug bounty. [R] SECURITY.md

### Complexity and maintenance
- Early reviews criticized 2,700-line god files and a 1,000-line `run_conversation` function, and worried about a "bloated spaghetti monster". [S-snippet] summaries of hackernoon/dev.to/buildmvpfast. Nous answered with an agent-driven refactor (−34% LOC). [S-snippet] PR #102117. An open issue tracks "residual 2K tasks" of "godfile eradication". [S] issues sorted by comments (#78647)
- Issue volume: 33.5k issues, with many closed by a "sweeper" bot as "not planned" or "implemented-on-main". [S] #13983, #115482, #23783, #7072 [I: this makes it hard for users to see whether their problem was fixed]
- Setup can take 2–4 hours for a full local setup, versus under 30 minutes for OpenClaw with Docker Compose. [S-snippet] https://blog.ishosting.com/en/hermes-agent-vs-openclaw. The setup wizard can loop, and early Docker images lacked dependencies. [S-snippet] aiagentstore summary
- The docs push the Nous Portal upsell on nearly every page ("`hermes setup --portal`" tips). [R] [I: risk of perceived lock-in]
- **Self-improvement wiping user customizations**: "power users who tweak skills [find] this a dealbreaker". [S-snippet] aiagentstore summary. Mitigations now exist (pinning, `write_approval`, origin-hash protection for bundled skills), but `write_approval` defaults to off and pinning only blocks *delete*. The agent can still patch a pinned skill. [R] curator.md / skills.md
- An unsubstantiated claim of breadth gaps: some users said Hermes lacked OpenClaw's channel breadth. [S-snippet] This is now outdated: the channel count is similar or larger. [R]

### Governance and trust
- **Plagiarism allegation.** EvoMap (a Chinese team) said Hermes' self-evolution loop copied their open-source Evolver. The original issue was reportedly retitled to ".", commenters were blocked, and a "delete your account" reply was posted. Nous publicly said it had "never heard of" Evolver. [S-snippet] https://github.com/NousResearch/hermes-agent/issues/17688 ; https://github.com/NousResearch/hermes-agent/issues/27266 ; https://news.ycombinator.com/item?id=48187581 ; https://eu.36kr.com/en/p/3767967755371011 ; https://www.aibase.com/news/27171. I could not verify the technical merits.

---

## 4. Lessons for Ruby

### Copy (high value, fits Ruby's principles)
1. **Agent-managed schedules from chat** ("remind me every morning…"), delivered to the chat they came from. Add **script-only jobs** that never call the model; Ruby's "cheap pre-check" philosophy taken to its conclusion. Block cron runs from creating cron jobs. [R Hermes cron.md]
2. **Memory-claim honesty**: Hermes' docs admit that "I'll remember" without a tool call is the #1 memory complaint. Ruby could detect a memory-claim phrase in a turn that made no `memory` tool call and append a visible note ("not saved"). This fits Ruby's "report honestly" rule. [I]
3. **Background learning review, but cheap and gated**: after a turn with N or more tool calls, a fork proposes memory or skill changes. Ruby can run it on a cheaper model with a digest (Hermes reports about 3–5× cheaper with the same capture), and use Ruby's existing proposal flow, so nothing lands silently. [R Hermes memory.md] [I]
4. **Inbound media**: voice-memo transcription, images to the vision model, documents to text (`read_file` converting PDF/DOCX/XLSX). **Outbound attachments** ("deliverable mode"). [R]
5. **Busy-input modes** (queue / interrupt / steer), `/retry`, `/undo`, `/model`, `/usage`, `/compress` in chat. [R]
6. **Usage gauge in the memory header** (`[67% — 1,474/2,200 chars]`) so the model knows capacity. Cheap to add. [R]
7. **Candid SECURITY.md trust model**, naming the one load-bearing boundary (the OS or container). Ruby has the stronger stance ("an unavailable backend is an error, never a silent downgrade") and should write it down the same way. [R]
8. **Preview-first importers**, now also for Claude Code and Codex (`hermes import-agent`). [R]
9. **`approvals suggest`**: mine approval history to propose allowlist rules, which reduces approval fatigue. [R]

### Avoid
1. **Fixed prompt overhead**: 16K tokens for "who u?". Publish Ruby's per-turn baseline (`ruby usage`) as a headline number and keep it gated in tests. [S #13983, #4379]
2. **SQLite fragility**: Ruby also uses WAL + FTS5.
   - Keep FTS as a *derived* index that can be rebuilt; never fail a turn closed on an FTS error.
   - Have a single writer per DB.
   - Run `PRAGMA integrity_check` and auto-backup in `ruby doctor` and at startup.
   - Never "recover" by creating empty tables.
   - Test SIGTERM mid-write. [S #5563, #32687, #133375, #97794]
3. **Updater races and false success messages**: Ruby's ordered handover is right. Add a failure-injection test that interrupts an update mid-flight and checks the service is restored. [S #23783, #95294, #129171]
4. **Regex "scanners" presented as security**: Skills Guard was bypassed (#7072). Ruby's stance of never running third-party code in-process is the real fix. Don't ship a scanner that implies safety. [S]
5. **Silent arg dropping**: Ruby's zod validation should reject unknown keys (strict schemas), not strip them. [S #115641] *(Not checked whether Ruby's schemas are `.strict()`.)*
6. **Self-improvement overwriting user work**: Ruby's lock + proposal design is stricter than Hermes' (Hermes defaults `write_approval: false` and lets the agent patch pinned skills). Keep it that way and say so on the website. [R]
7. **Tracker hygiene and disclosure non-response**: publish a security contact that works, give a response SLA, and avoid bot-closing real bugs as "not planned". [S #15750, GHSA-pgp4…]
8. **Attribution**: credit prior art explicitly. Ruby's PLAN already credits OpenClaw and Hermes. [S plagiarism controversy]
9. **Upsell creep in docs**: keep Ruby's docs vendor-neutral. [I]

### Corrections to Ruby's current PLAN.md "What we learned" table and claims
- *"Hermes overwriting user-edited skills"*: partly outdated. Hermes now has pinning, `skills.write_approval`, and origin-hash protection for bundled skills. The fair claim is that write-approval is off by default and pins don't stop patches. [R]
- *Keep: "Pluggable sandbox backends: local, Docker, SSH"*: Ruby implements only `local` and `docker`. There is no ssh in `src/sandbox/`. [Ruby]
- PLAN § Memory says **"Session search: FTS5 over past sessions, retrieved on demand through a tool"**, but there is **no session-search tool or FTS table** in `src/` (no `fts`/`session_search` matches; tools are `list_files`, `read_file`, `write_file`, `run_command`, `read_artifact`, `memory`, `skill_view`, `skill_create`, `skill_update`). [Ruby]
- PLAN § Policy says approvals use "inline buttons where available". No `inline_keyboard`/`callback_query` in channels; approvals are by `/approve <code>`. [Ruby]
- PLAN § Scheduler lists pre-checks "file changed, URL hash changed, command exit code, time window". Only `file_changed` and `url_changed` exist. [Ruby]
- PLAN § Agent loop says "forward text to channels that support streaming". The Telegram adapter sends finished text in chunks. [Ruby]

---

## 5. Gap list: Hermes has it, Ruby lacks it (ranked by user impact)

Each Ruby entry was checked against `src/`.

| # | Gap | Hermes | Ruby today | Why it matters / suggestion |
| --- | --- | --- | --- | --- |
| 1 | **Media on channels** (voice memos in, images and documents in, files out) | STT on all platforms, vision, `read_file` doc conversion, `MEDIA:` / deliverable mode | Text only: the Telegram type has only `text`, non-text messages are dropped (`telegram.ts` returns null when `text` is missing), and `contracts/messages.ts` has only `TextBlock` | Phone-first use is the core love moment, and voice notes plus photos are routine. Highest-impact gap for a drop-in replacement |
| 2 | **Web search and fetch tools** | `web_search` / `web_extract` with about 12 providers, including keyless (DDGS, Brave-free, SearXNG) | None (no web tool; `net.fetch` capability exists in policy but no tool uses it) | Most showcased automations (news, listings, research) depend on it. Add `web_fetch` (readability → text, SSRF guard, host scopes) plus one keyless search provider |
| 3 | **Schedules created from chat, with delivery to the origin chat** | `cronjob_manage` tool, `/cron add`, NL times, attached skills, delivery anywhere, no-agent script jobs, webhook-triggered jobs | Jobs only in config (`jobs` schema) or CLI; no scheduling tool; no script-only mode | Cron is the #2 love moment ("28 cron jobs"). Add a `schedule` tool gated by `schedule.edit` (the capability already exists), and script-only jobs that fit Ruby's pre-check ethos |
| 4 | **Cross-session recall (session search)** | `session_search` (FTS5) | Missing, even though PLAN says it exists | Drives "it remembered" beyond the 2.2k-char cap; also the main answer to the "memory too small" complaint (#5563) |
| 5 | **Learning loop automation** (nudged skill/memory capture, `/learn`, curator) | Background review fork, nudge intervals, curator lifecycle | Tools exist (`skill_create/update`, `memory`), stale-skill surfacing exists, but no automatic post-task review and no `/learn` | Hermes' headline differentiator. Ruby can do it with proposals by default (safer than Hermes) on a cheaper model |
| 6 | **MCP client** | Full client (OAuth, health, sampling, tool search) | Only mentioned in the importer (`migrate/plan.ts`) | Main extension path without in-process plugins. MCP servers run out-of-process, which fits Ruby's "no third-party code in-process" rule if they are gated by policy and run in the sandbox |
| 7 | **Chat ergonomics**: `/retry`, `/undo`, `/model`, `/usage`, `/compress`, `/status`; queue/interrupt/steer; tool-progress messages; inline approval buttons | Yes | Gateway handles `/start`, `/new`, `/stop`, `/approve`, `/deny` only | Cheap, high-frequency UX wins |
| 8 | **More channels**: WhatsApp, Slack, Email (then Matrix, iMessage) | 30+ | Telegram, Signal, Discord | WhatsApp shows up in family and SMB stories; email unlocks the "agent inbox" pattern. Respect Ruby's adapter contract |
| 9 | **Group chats** | Supported, with admin vs user roles | `dispatch` ignores group chats | Families and teams; needs Ruby's "groups never inherit private memory" rule |
| 10 | **Model resilience**: cross-provider fallback, credential pools, per-job model pins | Yes | Anthropic server-side refusal fallback only; per-job cheaper model not verified | Unattended jobs fail on provider outages |
| 11 | **Targeted file edit tool** (`patch`) and doc conversion in `read_file` | Fuzzy patch, LSP diagnostics | `write_file` replaces whole files | Token efficiency and correctness on edits |
| 12 | **Importer completeness** for a true drop-in | `claw migrate` brings allowlists, platform settings and (optionally) keys; `import-agent` covers Claude Code and Codex | Ruby imports memory, persona and skills; **skips Hermes cron jobs, profiles (`~/.hermes/profiles/*`), allowlists and config** (`migrate/plan.ts`) | Users switching from Hermes lose their schedules, which are the stickiest asset. Import `cron/jobs.json` into Ruby jobs as disabled-by-default proposals; detect profiles |
| 13 | **Inbound webhooks / event-triggered runs** | Webhook platform, plus cron jobs fired by webhook | None | GitHub/CI/alert automations |
| 14 | **Subagent delegation / programmatic tool calling** | `delegate_task`, `execute_code`, Kanban, MoA | None (v1 non-goal) | Power-user feature; keep deferred |
| 15 | **Browser automation / computer use** | Many backends | None | High value for some users but heavy; offer via MCP rather than core |
| 16 | **More sandbox backends** (SSH, then serverless) | 7 backends | local, docker | PLAN promises ssh; moderate impact |
| 17 | **Checkpoints / rollback of file edits** | Yes | Memory/skill versioning only (not workspace files) | Safety net for write approvals |
| 18 | **Voice replies / TTS, wake word, desktop app, mobile apps** | Yes | None (voice is a v1 non-goal) | Low priority for Ruby's positioning |
| 19 | **Multiple agents (profiles)** | Profiles with separate homes and gateways | Routing profiles + memory namespaces (partly equivalent) | Low; document the equivalence |

[I] The best order for "drop-in replacement" adoption is #1–#4 first, since they cover the delight moments users cite most, then #7 and #12 (cheap and sticky), then #5–#6.

---

## 6. Things I could not confirm
- Exact contributor count, the star-growth curve, and Discord or subreddit member counts.
- Whether the plagiarism claims have technical merit. Nous' formal position beyond press quotes.
- The full list of the "9 CVEs in 4 days" and which versions fixed each (the CSA page was blocked).
- Reddit and HN thread content beyond search snippets and Nous' curated quotes. The ranked "20 biggest problems" list (aiagentstore, blocked) came only through a search summary.
- Whether Ruby's zod schemas reject unknown keys (not checked).
