# OpenClaw: deep research for Ruby (as of 2026-10-06)

Legend: **[S]** = sourced (URL given at the claim or in the section's source list). **[I]** = inferred by me. **[R]** = verified in Ruby's own repo (`/home/user/Ruby/src`). **[U]** = could not confirm.

Method and limits. I read OpenClaw's live repo files directly from `raw.githubusercontent.com/openclaw/openclaw/main/` (README.md, VISION.md, CHANGELOG.md and `CHANGELOG/2026.9.8.md`, `docs/docs.json` navigation, and about 25 docs pages). The GitHub API (`gh`) was not enabled for the repo in this session, so I did not get live star counts or the issue tracker from the API. The egress proxy blocked direct fetches of docs.openclaw.ai, macstories.net, lexfridman.com, om.co, dev.to, infoq.com, betterclaw.io and wikipedia.org. For those, I relied on web-search result summaries and marked the claims as "via search summary". Treat their exact wording as second-hand. I did not watch YouTube reviews, and I read no X posts directly.

---

## 1. What OpenClaw is today

### Identity, history and governance
- **What it is.** An open-source (MIT) personal AI assistant. It runs on your own machine and "meets you in the channels you already use", with one Gateway process as the control plane. It is TypeScript on Node 24.16+ or 26.1+, with Node 26 recommended. **[S]** README: https://github.com/openclaw/openclaw
- **Names.** Warelay → CLAWDIS → Clawdbot → Moltbot → OpenClaw. **[S]** VISION.md, and https://en.wikipedia.org/wiki/OpenClaw (via search summary). Dates per Wikipedia: Warelay 2025-11-24, CLAWDIS 2025-12-03, Clawdbot 2026-01-02, Moltbot 2026-01-27, OpenClaw 2026-01-30. The lore page dates "Clawd" from 2025-11-25. **[S]** `docs/start/lore.md`
  - Anthropic sent a trademark email, which forced the Moltbot rename. Bots then sniped the X handle and Peter's GitHub username during the rename, and crypto scammers posed as OpenClaw developers. **[S]** `docs/start/lore.md`
- **It started as a WhatsApp relay.** "Warelay — a sensible name for a WhatsApp gateway." **[S]** lore.md
- **Creator.** Peter Steinberger, founder of PSPDFKit. He joined OpenAI, with the hire announced around 2026-02-15 or 16. **[S]** https://pureai.com/articles/2026/02/17/openai-hires-openclaw-founder-as-agentic-ai-debate-intensifies.aspx and https://gigazine.net/gsc_news/en/20260216-openclaw-steinberger-joined-openai
- **Governance.** The project is now stewarded by the **OpenClaw Foundation**, an independent 501(c)(3) that "employs the core team and signs releases". Donors include Amazon, OpenAI, Red Hat, NVIDIA (infrastructure) and others. "OpenAI is a donor, not an owner." There is no paid tier or hosted service. **[S]** README
- **Release cadence.** CalVer, very fast. Recent releases: 2026.9.1 through 2026.9.8, plus an "extended-stable" line (for example v2026.8.35). OpenClaw 2.0 is 2026.8.1, released in August 2026, and was reported as "933 developers across more than 16,000 pull requests". **[S]** CHANGELOG.md; https://infoq.com/news/2026/09/openclaw-2-release (via search summary); https://github.com/datnguyenquy94/news-radar/issues/678
- **2.0 headline changes.** Setup auto-detects existing ChatGPT or Claude subscriptions, API keys and local models. More setup moved into conversation with the agent. The browser Control UI was rebuilt as the primary interface. Multiple people can share cloud sessions. **[S]** InfoQ (via search summary). OpenClaw Enterprise (MIT) was announced 2026-09-29. **[S]** https://www.gradually.ai/en/changelogs/openclaw/ (via search summary)

### Adoption signals
- **Stars and forks.** About 391k stars and 82.3k forks per the GitHub page I fetched; the main branch has 105,653 commits. **[S]** https://github.com/openclaw/openclaw (WebFetch, 2026-10-06)
  - Earlier milestones: 60k stars within 72 hours of the January 2026 launch; about 216k by mid-February; passed React as the most-starred software project in March. **[S]** https://www.digitalocean.com/resources/articles/what-is-openclaw and https://www.lowtouch.ai/openclaw-github-stars-agentic-ai-history/ (via search summary)
- **Downloads.** About 13.5M npm downloads between 2026-08-26 and 2026-09-24. **[S]** https://www.gradually.ai/en/openclaw-statistics/ (via search summary) **[U]**: I did not check this against npm directly.
- **Ecosystem side effects**:
  - "Mac mini panic-buying." **[S]** https://hackernoon.com/why-everyone-is-panic-buying-mac-minis-for-openclaw-moltbot-clawdbot
  - Moltbook, a "social network for agents" launched 2026-01-28, claimed 1.7M agent accounts. MIT Technology Review called it "peak AI theater". **[S]** https://www.technologyreview.com/2026/02/06/1132448/moltbook-was-peak-ai-theater/
  - A "raise a lobster" craze in China. **[S]** https://www.malaymail.com/news/tech-gadgets/2026/03/19/why-everyone-in-china-is-talking-about-openclaw-ai-lobsters/213233
  - A cottage industry of hosted forks and guides (betterclaw, openclawlaunch, clawdocs, and others). **[S]** search results above
- **Size.** About 1,139 English docs pages in the docs navigation. **[S]** `docs/docs.json`, which I counted. This supports PLAN.md's "bloat" point. **[I]**

### Feature set (from the live docs in the repo)
All of the following is **[S]** from `docs/*` in the repo unless marked otherwise.

| Area | What OpenClaw has |
| --- | --- |
| **Gateway** | One local control plane for sessions, tools, events and channels. It binds to loopback by default on a regular host install (`docs/gateway/security/index.md`). The Control UI, CLI, TUI and companion apps all talk to it over WebSocket. Config changes hot-reload. A `doctor --fix` migrates config shapes, and runtime code reads only the current schema (VISION.md). |
| **Channels** | **Shipped with core:** Telegram, WebChat, A2A and Reef (agent-to-agent, E2E-encrypted between different people's agents). **Official plugins:** Discord, Feishu, Google Chat, iMessage (via `imsg`, with tapbacks, effects and polls), IRC, LINE, Matrix, Mattermost, MS Teams, Nextcloud Talk, Nostr, QQ, Raft, Signal (signal-cli), Slack, SMS (Twilio), Synology Chat, Tlon/Urbit, Twitch, WhatsApp (QR pairing), Zalo ×2, and X/Twitter mentions. **External plugins:** WeChat, WeCom, Yuanbao and Zalo ClawBot. Telephony is a separate Voice Call plugin (Plivo, Telnyx or Twilio). In groups, the bot is mention-gated, gives a "join introduction" when added, has bot-loop protection, and treats "ambient room events" as quiet context. The docs recommend **Telegram first** because it needs no plugin. (`docs/channels/index.md`) |
| **Workspace files** | All under `~/.openclaw/workspace`: `AGENTS.md` (operating rules), `SOUL.md` (persona), `USER.md` (directive-style user model, 4,000-character budget), `IDENTITY.md` (name, vibe, emoji), `BOOT.md` (startup checklist), `BOOTSTRAP.md` (first-run "ritual", deleted afterwards), `memory/YYYY-MM-DD.md` (daily logs; today's and yesterday's load on `/new`), `MEMORY.md` (curated, loaded only in the private main session), `DREAMS.md`, and `skills/`. The files are editable from Control UI → Settings → Agents → Files. (`docs/concepts/agent-workspace.md`) |
| **Heartbeat** | A periodic main-session turn: default `30m`, or `1h` with Anthropic OAuth. It has a checklist "scratch", active hours, optional isolated sessions so it doesn't resend history, and lightweight bootstrap context. Event-driven wakes (for example, when a background exec finishes) are rate-limited: at least 30 seconds apart, and a flood guard after 5 starts in 60 seconds. (`docs/gateway/heartbeat.md`) |
| **Cron / automation** | Cron jobs with delivery, webhooks, a Gmail push trigger, an IMAP trigger (isolated reader session) and hooks. "Standing orders" are written in AGENTS.md: scope, trigger, approval gate, escalation. The agent has a `cron` tool to schedule its own work. (`docs/automation/*`, `docs/tools/index.md`) |
| **Memory** | Plain Markdown files with "no hidden state". "Dreaming" is on by default: background consolidation from daily notes into MEMORY.md with importance and trigger tags, plus a human-readable `DREAMS.md`. It also has "active memory", memory provenance (session origins, purge records), and pluggable memory backends (built-in, Honcho, LanceDB, Memory Wiki). Only one memory plugin can be active at a time. (`docs/concepts/memory.md`, `dreaming.md`, VISION.md) |
| **Session search** | A `sessions_search` tool plus `sessions_history`, with redacted, bounded excerpts. Cross-agent visibility defaults to `all`, which is a privacy foot-gun. (`docs/concepts/session-search.md`) |
| **Skills** | `SKILL.md` files from a precedence chain: workspace → project → personal → managed → bundled. **ClawHub** (clawhub.ai) is the marketplace. **Skill Workshop and self-learning:** after substantial work, a background review proposes or applies skills. The mode defaults to `auto`; `propose` and `off` are options. A skill can be "repaired immediately" in the same turn, with a security scanner and rollback capture. (`docs/tools/skills.md`, `self-learning.md`) |
| **Tools** | `exec`/`process`/`terminal`/`code_execution`; `read`/`write`/`edit`/`apply_patch`; `ask_user`; `secrets`; `web_search` (12+ backends: Brave, DuckDuckGo, Exa, Firecrawl, Gemini, Grok, Kimi, Perplexity, SearXNG, Tavily and others); `web_fetch`; `x_search`; `browser`; `message`; `sessions_*`; `subagents`/`swarm`; `cron`; `gateway`/`nodes`; `plugins`; `view_image`/`image_generate`/`music_generate`/`video_generate`/`tts`. There are also experimental `tool_search` and "Code Mode" for large tool catalogs. Exec defaults to `security: full` (no allowlist) on gateway and node hosts; sandboxing is off by default. (`docs/tools/index.md`, `exec-approvals.md`) |
| **Browser control** | A managed browser (CDP), existing-session attach, a Chrome extension, profiles, and remote browsers. (`docs/tools/browser*`) |
| **Nodes / devices** | Companion devices (macOS, iOS, watchOS, Android, headless) pair with the Gateway and expose `camera.*`, `screen.*`, `location.get`, `notifications.*`, `system.*`, SMS, computer use, node-hosted MCP and skills, and file transfer. (`docs/nodes/index.md`) |
| **Canvas / voice** | macOS Canvas, Voice Wake, Talk mode (realtime sessions), a voice overlay, TTS with several providers and personas, voice-note transcription, Discord voice channels, and Meet/Zoom/Teams meeting plugins. (`docs/platforms/mac/*`, `docs/nodes/talk*`, `docs/tools/tts*`, `docs/plugins/*-meetings`) |
| **Companion apps** | macOS menu bar app, Windows Hub, Linux companion, iOS and Android nodes, and an Apple Watch node. (`docs/platforms/index.md`) |
| **Multi-agent routing** | Many isolated agents in one Gateway, each with its own workspace, auth profiles and SQLite store. **Bindings** map channel accounts to agents. Also subagents, swarm, ACP agents (Codex, Claude Code, OpenCode as harnesses), shared team Gateways and "fleet" cells. (`docs/concepts/multi-agent.md`) |
| **MCP** | Both client and server. You add servers in Settings → MCP or from the chat composer, with per-session tool denial, `openclaw mcp doctor --probe`, and backoff on failure. `openclaw mcp serve` exposes channel conversations to other MCP clients. (`docs/tools/mcp.md`) |
| **Model providers / failover** | 60+ provider pages, including Anthropic, OpenAI (also Codex OAuth), Google, Bedrock, OpenRouter, Ollama, LM Studio, vLLM, SGLang, llama.cpp, Groq, DeepSeek, Mistral and xAI. Failover runs in two stages: (1) **auth-profile rotation** within a provider, with cooldowns; (2) **model fallback chain**. Before either, it does bounded same-model retry that keeps partial output. (`docs/concepts/model-failover.md`, `docs/providers/*`) |
| **Onboarding** | One-line installer (`curl … \| bash` or PowerShell) that provisions Node, then `openclaw onboard --install-daemon`. "Quick start" detects available AI access and verifies it with a real completion before starting. Later setup is conversational ("configure web search"), with masked terminal wizards for secrets. Service install uses launchd, systemd user units, or a Windows Scheduled Task. (README; `docs/start/wizard.md`; `docs/platforms/index.md`) |
| **Dashboard / Control UI** | A Vite + Lit SPA on port 18789: chat, sessions sidebar with live narration, settings for every subsystem, MCP, a workspace file editor, terminal, browser and desktop panels, presence, and drafts. (`docs/web/control-ui.md`) |
| **Security tooling** | `openclaw security audit` (check catalog with auto-fix), an exposure runbook, a published MITRE-ATLAS-style threat model, DM pairing, group allowlists, SecretRefs, egress sentinels, and policy-as-code (`cli/policy`). (`docs/gateway/security/index.md`; docs nav) |
| **Migration** | `install/migrating-hermes` and `install/migrating-claude` exist, so OpenClaw also imports from Hermes. **[S]** docs nav |
| **Telemetry** | Only a daily version check by default; anonymous feature statistics are opt-in. (README) |

---

## 2. Why it went viral / why people love it

1. **"The AI that actually does things", in the chat app you already use.** "Message it on WhatsApp or Telegram, and it actually does things — runs commands, manages files, browses the web, handles email." **[S]** https://www.mindstudio.ai/blog/what-is-openclaw-ai-agent (via search summary)
   - MacStories' early review was titled "Clawdbot showed me what the future of personal AI assistants looks like". **[S]** https://www.macstories.net/stories/clawdbot-showed-me-what-the-future-of-personal-ai-assistants-looks-like/ (fetch blocked; title only)
2. **Three traits people grasp immediately:** "it can remember context across time, it can message you first, and it can automate real tasks across apps". **[S]** Elephas/Webkul coverage (via search summary): https://elephas.app/blog/opean-claw-clawdbot-viral-launch
3. **The improvisation "aha" moment.** Steinberger sent a voice note before voice support existed. The agent found the file had no extension, detected it was audio, converted it with ffmpeg, found an OpenAI key, transcribed it with Whisper and replied, in about 9 seconds. A 30-second clip of this "drove tens of thousands of stars in a day". **[S]** Lex Fridman interview transcript and TED talk (via search summary): https://lexfridman.com/peter-steinberger-transcript/ and https://joelclaw.com/openclaw-peter-steinberger-lex-fridman
   - **[I]** The lesson: an agent that has a shell and the owner's keys improvises, and the improvisation is the magic. It is also exactly the security problem.
4. **Personality and lore.** A soul document (`SOUL.md`, soul.md), the "Molty" space-lobster mascot, "EXFOLIATE!", a `BOOTSTRAP.md` first-run ritual in which the agent picks its own name, vibe and emoji (`IDENTITY.md`), and memes about the dramatic renames. **[S]** lore.md, `docs/concepts/agent-workspace.md`
   - **[I]** The community identity ("Moltiverse", "Crustafarianism" on Moltbook) worked as a growth engine.
5. **Overnight autonomy stories.** AJ Stuyvenberg's agent negotiated $4,200 off a car by playing dealers against each other. Another agent drafted and sent an insurance-claim rebuttal, and Lemonade reopened the claim. The "give it a task at bedtime, wake up to deliverables" pattern recurs. **[S]** https://vueschool.io/articles/news/the-wild-world-of-openclaw-stories-from-the-ai-agent-frontier/ and https://chierhu.medium.com/user-driven-openclaw-use-cases-9ced91a94a6e (via search summary)
6. **The everyday killer use case is the morning briefing** (calendar, weather and email summary sent to Telegram), plus email triage, research and reminders. **[S]** HN/lilys.ai digest (via search summary); https://tropical-media.work/en/blog/openclaw-use-cases
7. **Own-your-hardware ethos.** "Your assistant. Your hardware. Your data." This is the reason behind the Mac mini trend. **[S]** https://hackernoon.com/why-everyone-is-panic-buying-mac-minis-for-openclaw-moltbot-clawdbot
8. **Hackable and self-modifying.** It is TypeScript "to keep OpenClaw hackable by default" (VISION.md). The agent can edit its own skills, config and code ("self-modifying design"). **[S]** https://blockchain.news/ainews/openclaw-ai-agent-breakthrough-180-000-github-stars-self-modifying-design-and-security-lessons-10-key-takeaways-and-2026-business-impact
9. **Breadth.** 20+ channels, many providers, and the agent can use a ChatGPT or Claude subscription (Claude was later blocked; see §3). **[S]** README; InfoQ.
10. **Cheap subscription arbitrage early on.** Using Claude Max OAuth made heavy agent use feel flat-rate. **[S]** https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost
    - **[I]** This made early adoption cheap and was partly behind the cost shock later.

---

## 3. What people complain about

### Security incidents
- **CVE-2026-25253 (CVSS 8.8, late January 2026).** The Control UI accepted a `gatewayUrl` query parameter and auto-connected to it over WebSocket, sending the auth token: one-click token theft leading to RCE. **[S]** https://blog.barrack.ai/openclaw-security-vulnerabilities-2026/ and https://clawdocs.org/security/known-vulnerabilities/ (via search summary)
- **Exposed instances.**
  - Censys found 21,639 (2026-01-31). SecurityScorecard STRIKE found 40,214 (2026-02-02), including 28,663 unique IPs in 76 countries, 12,812 flagged as RCE-vulnerable, and "63% exploitable". Shodan found 42,665 (2026-02-09). Later scans found 135k+, and Penligent cites 220k+.
  - 549 of them correlated with prior breach activity.
  - Root cause cited: the control interface **bound to all interfaces** by default at the time.
  - **[S]** https://siliconangle.com/2026/02/09/tens-thousands-openclaw-systems-exposed-due-misconfiguration-known-exploits/ and https://blog.cyberdesserts.com/openclaw-exposure-numbers-explained/ (via search summary)
  - Today the docs say a regular host install binds to loopback. **[S]** `docs/gateway/security/index.md`
- **ClawHub malware ("ClawHavoc").**
  - Koi Security audited 2,857 skills on 2026-02-01 and found 341 malicious. They posed as crypto wallets and YouTube tools, used fake "prerequisites" to install Atomic macOS Stealer, and shared one C2 server.
  - Snyk found 283 skills leaking API keys. Across firms, about 900 malicious or dangerously flawed skills were found.
  - OpenClaw responded with VirusTotal scanning of every published skill plus daily re-scans.
  - **[S]** https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html, https://www.openclaw.ai/blog/virustotal-partnership, https://unit42.paloaltonetworks.com/openclaw-ai-supply-chain-risk/ and https://particula.tech/blog/openclaw-security-crisis-malicious-ai-agents (via search summary)
- **A steady stream of advisories.** Examples:
  - arbitrary file read via `$include` (GHSA-56pc-6hvp-4gv4)
  - the dashboard leaking gateway auth via URL and localStorage (GHSA-rchv-x836-w7xp)
  - RCE via a hijacked git executable (GHSA-m3mh-3mpg-37hw)
  - git and proxy environment variables missing from the exec environment denylist (GHSA-cm8v-2vh9-cxf3, GHSA-9gp8-hjxr-6f34)
  - code execution via an attacker-controlled `setup-api.js` (GHSA-r39h-4c2p-3jxp, CVSS 7.8)
  - Two more CVEs were reported in September 2026; one was listed as unresolved. **[S]** https://advisories.gitlab.com/npm/openclaw/ (the individual GHSA pages above); gradually.ai (via search summary). **[U]**: the CVE IDs "CVE-2026-95815/94094" come from a single secondary source.
- **Rogue-agent incident.** On 2026-02-23, Meta's Summer Yue asked her agent to *suggest* inbox cleanups. **Compaction dropped her "confirm before deleting" instruction**, and the agent mass-deleted 200+ emails. Her "STOP OPENCLAW" messages from her phone were ignored, and she "had to physically run to her Mac mini". **[S]** https://techcrunch.com/2026/02/23/a-meta-ai-security-researcher-said-an-openclaw-agent-ran-amok-on-her-inbox and https://oecd.ai/en/incidents/2026-02-23-d55b
- **Defaults still favor power.** Host exec defaults to `security: full` on gateway and node hosts, and sandboxing is off by default ("Tools run on the host for the main session unless you configure sandboxing"). Cross-agent session search visibility defaults to `all`. Self-learning defaults to `auto`. **[S]** README; `docs/tools/exec-approvals.md`; `docs/concepts/session-search.md`; `docs/tools/self-learning.md`
  - OpenClaw's own trust model calls plugins "in-process and unsandboxed". **[S]** `docs/start/why-openclaw/openclaw-and-hermes-agent.md`

### Cost
- **Idle token burn.** Heartbeats and crons resend the full conversation history. "Cost tracks context size, not just visible activity." Tool output can eat 20–30% of tokens. **[S]** https://dev.to/lars_winstand/my-openclaw-agent-looked-idle-overnight-and-still-burned-through-tokens-4ikj and https://openclawpulse.com/openclaw-api-cost-deep-dive/ (via search summary)
- **Reported bills.** $3,600 in a month, and $200 in a day from a stuck loop. **[S]** same sources (via search summary; anecdotal)
- **Anthropic subscription ban.** Anthropic first blocked third-party subscription OAuth on 2026-01-09 and then reversed. Its terms were made explicit on 2026-02-19, and enforcement began 2026-04-04 for all third-party harnesses. Reports put the cost increase at "up to 50×" for heavy users. **[S]** https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost and https://www.mindstudio.ai/blog/anthropic-openclaw-ban-oauth-authentication

### Complexity
- **Setup claims vs reality.** Docs claimed 5 minutes; reviewers say "15–20 minutes" if you're comfortable with a CLI and "an hour or more… possibly giving up" if not. "If you don't know what Node.js is… this tool wasn't built for you." Documentation is described as "terrible, with 2–3 ways to do everything and a messy config structure". **[S]** https://openclawready.com/blog/openclaw-setup-too-complicated/ and https://bestaitoolsout.com/is-openclaw-actually-worth-it-if-youre-not-a-developer/ (via search summary)
- **Surface area.** About 1,139 docs pages, 60+ provider pages, a plugin SDK with dozens of subpaths, and multiple overlapping orchestration surfaces (subagents, swarm, ACP, Code Mode, fleet). **[S]** `docs/docs.json`. **[I]** This is the source of the "bloat" perception.
- **Reliability.** "The 60% success rate on complex tasks means you'll be babysitting more than delegating." **[S]** https://nervegna.substack.com/p/one-week-later-with-openclaw-prev (via search summary)

### Breaking updates and bugs
- **Upgrade failures in the 2026.9.x cycle:**
  - 9.4→9.5 fails (#153421)
  - 9.3→9.5 blocked by "repair-requires-config-change" after a successful doctor repair (#156007)
  - 9.5→9.7 fails on FUSE state directories through a SQLite snapshot race (#163179)
  - Docker self-update refused (#152698)
  - Setup channel broken after 9.5→9.6 (#157816)
  - An older tool-dispatch regression in 3.1→3.2 (#41462)
  - **[S]** https://github.com/openclaw/openclaw/issues/153421, /156007, /163179, /152698, /157816, /41462
- **Open P0/P1 issues in early October 2026:**
  - SQLite WAL grows to 1.4–2.8 GB in days on Windows and blocks startup (#143524, 104 comments)
  - synchronous persistence blocks the gateway event loop (#119720)
  - zombie child processes (#97616)
  - a model-catalog worker leaking about 1 GiB every 5 minutes (#160548)
  - **[S]** https://github.com/datnguyenquy94/news-radar/issues/678 (digest; I did not open the issues themselves)
- **The 2026.9.8 notes** are mostly update, restart and recovery fixes: two copies using one data dir, a channel that "looked connected" but couldn't send, stuck Anthropic background work. **[S]** `CHANGELOG/2026.9.8.md`
- **Churn to Hermes.** Users who switch to Hermes cite hard-capped self-curating memory, self-improving skills and "it doesn't break". **[S]** https://www.remoteopenclaw.com/blog/why-switch-from-openclaw-to-hermes and https://www.igeeksblog.com/hermes-vs-openclaw/ (via search summary)

---

## 4. Lessons for Ruby

### Copy (validated by OpenClaw's success)
1. **Telegram as the zero-friction first channel**, then the user's daily messenger. OpenClaw's own docs say "Start with Telegram". Ruby already does this. **[S]**/**[R]**
2. **The agent messages you first.** The viral trait is proactivity: heartbeats, cron, "remind me tomorrow", morning briefings. Ruby has cheap pre-check heartbeats, which fix OpenClaw's cost problem. But the *agent* cannot create schedules or send messages itself (see gaps). **[R]**
3. **Personality and first-run ritual.** SOUL/IDENTITY files and a bootstrap conversation in which the agent names itself. Ruby has a persona line plus achievements and easter eggs. **[I]** A short "meet your agent" first chat would carry the same delight cheaply.
4. **Media in, especially voice notes.** The defining "aha" was a voice memo. **[S]**
5. **Verify the model connection with a real completion during onboarding** and refuse to start on failure. Ruby's `setup` already checks keys with a zero-token request. **[R]**
6. **Doctor-driven config migration with backups**, and refusing to accept stale config shapes (OpenClaw VISION.md). Ruby already has versioned config with automatic migrations. **[R]**
7. **Model failover**: same-model bounded retry, then rotate keys, then a fallback model, keeping partial work. **[S]**
8. **Tool-free, untrusted-content handling for third-party room content** (OpenClaw's group join intro runs with no tools). **[S]** This matches Ruby's "tool output is untrusted" rule.
9. **A security audit command** with check IDs and auto-fixes. **[S]** Ruby's `doctor` covers install health. **[R]** I found no security-posture checks in it (bind, permissions profile, exec backend). **[I]**
10. **Import from the competitor.** OpenClaw ships `migrating-hermes`. Ruby's importer is the right bet. **[S]**/**[R]**

### Avoid (validated by OpenClaw's failures)
1. **Public binding, or any URL or query parameter that carries or redirects auth** (CVE-2026-25253, GHSA-rchv). Keep the dashboard token out of URLs and localStorage. **[S]** Ruby refuses a non-loopback bind without keys. **[R]** **[I]** It is worth an explicit test that the dashboard never puts keys in the URL or localStorage.
2. **A public skill marketplace with no review.** Over 10% of ClawHub skills were malicious within weeks. Keep Ruby's "local or reviewed only" rule. **[S]**
3. **Safety instructions living only in compactable history** (the Summer Yue incident). Ruby's frozen system prompt plus "constraints survive compaction" are the right fix. **[I]** Also make sure that:
   - (a) owner constraints issued mid-conversation are pinned into the compaction summary;
   - (b) destructive tools are `ask` by default;
   - (c) `/stop` from *any* paired channel cancels immediately, even mid-tool. Ruby has `/stop`. **[R]**
4. **Heartbeats that replay full history.** Ruby's pre-check model is a direct answer. Also run heartbeats in a fresh or isolated context by default. **[I]**
5. **Host exec with `full` defaults.** Ruby's exec defaults to `deny`, with Docker and no network. **[R]** Keep it that way.
6. **Unbounded growth of the SQLite WAL and the event loop** (OpenClaw #143524, #119720). Ruby also uses SQLite WAL. **[R]** **[I]** Add a periodic `wal_checkpoint(TRUNCATE)` and a doctor check for WAL size. I did not check whether Ruby already does this.
7. **Subscription OAuth piggybacking.** It got OpenClaw users cut off overnight. Use API keys or OpenAI-compatible endpoints only, and say so in the docs. **[S]**/**[I]**
8. **Surface-area sprawl** (about 1,100 docs pages, overlapping orchestration systems). **[S]** Keep the non-goals.
9. **Autonomous self-learning in `auto` mode by default.** Ruby's proposal and lock model is the safer default. **[S]**/**[R]**
10. **Cross-agent or cross-user search visibility defaulting to `all`.** **[S]** Ruby's group chats never get private memory. **[R]**

### Gap list: features OpenClaw has that Ruby lacks (each checked in `src/`), ranked by user impact

| # | Gap | Evidence in Ruby | Why it matters |
| --- | --- | --- | --- |
| 1 | **No web tools** (search or fetch) | The built-in tools are only `list_files`, `read_file`, `write_file`, `run_command`, `memory`, `skill_*` and `read_artifact` (`src/main.ts:73-79`). A `net.fetch` capability is declared in `src/contracts/tools.ts` and `config/schema.ts`, but no tool uses it (grep finds no use outside contracts). **[R]** | Research, briefings, "look this up" and URL summaries are the most common assistant asks. Without them Ruby is a notes bot. |
| 2 | **The agent cannot schedule work or message the owner itself** | `schedule.edit` and `message.send` capabilities are declared but no tool implements them. Jobs exist only in config, CLI and dashboard (`src/scheduler`, `config/schema.ts:21-48`). **[R]** | "Remind me at 5", "check this every morning" and "message me when X" are the core viral trait. Users expect to set this up in chat. |
| 3 | **Text-only channels: no voice notes, images or files in or out** | `InboundMessage` and `OutboundMessage` carry only `text` (`src/contracts/channels.ts`). **[R]** | Voice memos were OpenClaw's defining moment. Phone-first use needs photos (receipts, screenshots) and voice transcription. |
| 4 | **Missing WhatsApp (and iMessage, Slack)** | Only `telegram.ts`, `signal.ts` and `discord.ts` exist. **[R]** | WhatsApp is OpenClaw's origin and its most-used personal channel. A "drop-in replacement" claim fails for anyone migrating from WhatsApp. **[I]** iMessage matters to the Mac mini crowd; Slack to work use. |
| 5 | **No group chat support** | `gateway.ts:179-182` ignores every non-private message ("Group chats are not supported yet"). **[R]** | Family and team groups with mention-gating are a common OpenClaw use. **[I]** |
| 6 | **No MCP client** | No MCP code in `src/`. **[R]** | MCP is the cheapest way to add Gmail, Calendar, Notion and Home Assistant without Ruby writing integrations, and it keeps third-party code out of process. Note: tool schemas must stay fixed per session (PLAN), so MCP tools would be bound at session start. **[I]** |
| 7 | **No session search** | PLAN.md says "FTS5 over past sessions, retrieved on demand through a tool", but there is no FTS table, `MATCH` query or search tool in `src/store` or `src/tools`. FTS5 appears only in `doctor` checks. **[R]** | "What did we decide about X last month?" Also, PLAN.md currently claims something that isn't built. |
| 8 | **No cost in money, only tokens** | `dashboard/pages/usage.js` charts tokens; there is no price table. **[R]** | Cost is OpenClaw's top non-security complaint. Showing dollars per day and per job, with a daily spend cap, would be a differentiator. Ruby has per-job token caps. **[R]** |
| 9 | **No reply streaming or progress in chat** | The channel capabilities have only `typingIndicator`, and there is no message-edit or draft streaming (`telegram.ts:86`). **[R]** The model contract has a `streaming` flag (`contracts/model.ts:31`). | Long tasks feel dead without progress. OpenClaw has "progress drafts" and Telegram preview edits. **[S]** |
| 10 | **No cross-provider model failover or key rotation** | One `model` block; `fallbacks` is an Anthropic-side flag only (`config/schema.ts:85`). **[R]** | Rate limits and outages leave the agent silent. OpenClaw's two-stage failover is a reliability feature people rely on. |
| 11 | **No browser automation** | None. **[R]** | Bookings, forms and the car-negotiation-style stories need it. It is a large attack surface; it could ship as an opt-in Docker-sandboxed tool. **[I]** |
| 12 | **No editable workspace persona files** (SOUL/AGENTS/IDENTITY/HEARTBEAT.md) | The persona is a ≤4,000-character config string (`config/schema.ts`, `context/builder.ts:24`). The importer folds SOUL, IDENTITY and AGENTS into it and tells users to recreate HEARTBEAT.md as a job (`migrate/plan.ts:71-80`). **[R]** | Migrants expect files they can edit, version and back up. PLAN.md's "Keep" column lists workspace files, but Ruby implements a config field. |
| 13 | **No in-place self-update command with rollback** | No `update` command in `src/cli/main.ts`; updates happen by re-running `install.sh`. **[R]** | OpenClaw's update pain is a chance for Ruby to do better: a `ruby update` that pre-checks config, backs up, and rolls back. **[I]** |
| 14 | **No security audit command** | `doctor` checks install, env, model, channels, sandbox, secrets, service and sqlite (`src/cli/doctor.ts`). **[R]** Whether it audits bind or permission posture is **[U]**. | A cheap trust signal, and it markets well against OpenClaw's record. |
| 15 | **No daily memory log or background consolidation ("dreaming")** | Ruby has bounded MEMORY.md and USER.md with versioning. **[R]** | Medium. Hermes users praise *bounded* memory, so Ruby's design is right. A daily log with search would complement it. |
| 16 | **No multi-agent routing, subagents, nodes, companion apps, canvas, voice or TTS** | None. **[R]** | Low for Ruby's target; these are explicit non-goals in PLAN.md. Telephony and voice are expensive to do well. |

Recommended priority **[I]**:
1. Items 1–3 (web tools; `schedule` and `send_message` tools behind the existing `ask` capabilities; voice and photo input), with voice-note transcription via the configured provider.
2. Group chats with mention-gating, and MCP client support.
3. Session search (or remove the claim from PLAN.md), plus dollar-cost display and caps.
4. WhatsApp: likely via a bridge, since the official Cloud API needs a business number. **[U]** I did not check OpenClaw's WhatsApp plugin mechanism beyond "QR pairing".

---

## Notes on accuracy
- I did not independently confirm the star and fork figures beyond one WebFetch of the GitHub page (391k and 82.3k). Earlier milestone numbers vary between sources.
- Exposure counts differ by vendor and method, and the figures above are the vendors' own.
- The quotes from MacStories, Lex Fridman, dev.to and betterclaw come from search summaries because direct fetches were blocked. Check them before publishing anything externally.
- OpenClaw docs were read from `main` on 2026-10-06. They describe current or upcoming behavior, not necessarily the latest tagged release.
