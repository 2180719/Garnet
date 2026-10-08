# Garnet

A persistent personal agent you can actually read.

Garnet runs on your own VPS or computer and is designed to be reached through Telegram, Signal, Discord, an opt-in dashboard, or a key-gated API. It is small enough to audit, secure by default, and careful with tokens.

> **Status: pre-release.** Working today: the agent loop, tools with approvals (including over chat), web fetch and search with prompt-injection containment, bounded memory, skills, compaction, the gateway, Telegram, Signal and Discord (with photos, files and voice notes in, and files out), a key-gated OpenAI-compatible API, cron jobs and heartbeats, reminders and schedules created from chat, script-only jobs, messages Garnet sends on its own (with your approval), Anthropic and OpenAI-compatible models, and service install. A Docker sandbox for commands, backup and restore, and importing from OpenClaw or Hermes are in too. So is the opt-in dashboard (`garnet dashboard`). See [PLAN.md](PLAN.md).

## Install

Requires Node.js 22.18 or newer and git. No sudo; nothing outside your home directory.

```sh
curl -fsSL https://raw.githubusercontent.com/2180719/Garnet/main/install.sh | sh
```

The installer checks Node.js (and says how to get it if it is missing or too old), clones Garnet into `~/.local/share/garnet`, installs its two dependencies, and puts a `garnet` command in `~/.local/bin`. Then it starts `garnet setup`. Running it again also updates and leaves local changes alone, but the usual way is `garnet update` (`--check` only looks; it fast-forwards, reinstalls dependencies only when they changed, smoke-checks the new code, rolls back if anything fails, and offers to restart the service; see [docs/UPDATING.md](docs/UPDATING.md)). `sh install.sh --help` lists the options (`--dir`, `--bin-dir`, `--name`, `--ref`, `--no-setup`).

> **Something else already called `garnet`?** The installer never overwrites a command it did not write and warns when another one shadows it; install with `--name garnet-agent` to keep both.

From a clone instead (to develop, or to read the code first):

```sh
git clone https://github.com/2180719/Garnet && cd Garnet
npm install
npm link            # optional: puts `garnet` on your PATH (otherwise use `npm run garnet -- <command>`)
```

`npm install -g` from a tarball or the npm registry does not work: Node.js will not run TypeScript from `node_modules`. `npm link` and `npm install -g .` from a clone do.

## Set up

```sh
garnet setup     # model and key, persona, where commands run, channels (a checklist), background service, pairing
garnet doctor    # checks the install and setup, and says how to fix what it finds
garnet chat      # talk to Garnet in the terminal, full screen (`--inline` keeps it in the scrollback; `--fake` needs no key)
garnet wake      # first-run wake-up: Garnet introduces itself and sets itself up by talking (`--fake` works offline)
```

Setup offers two ways to name your assistant and tell it how you like answers: a quick form (three questions), or "Wake it up", a first chat where the agent asks the same things itself and saves them with its real tools (`set_profile` and `memory`). The transcript shows those tool calls. If the model cannot use its tools, the chat stops after a few tries and asks the form questions instead (your replies stay in the session log, and the form starts from whatever was already saved). `garnet setup -y` never starts a chat. Run `garnet wake` (or `garnet chat --onboard`) any time to do it again.

`garnet setup` asks a few questions and saves nothing until the end:

- **Model:** Anthropic, Google Gemini, OpenRouter, a local server (Ollama, LM Studio, llama.cpp, vLLM), any OpenAI-compatible API, or the offline demo model. Keep several named providers (`garnet providers list|add|use|rm`) and swap between them with `/provider` in chat.
- **Keys and tokens:** typed hidden, then kept in the encrypted secret store (setup creates a key file outside `~/.garnet`), in `~/.garnet/env` (mode 600), or left to your own environment variables. Config only ever stores the *name*. If you agree, setup checks each key with one request that costs no tokens.
- **Persona:** the assistant's name, what to call you, and a line about how you like answers.
- **Channels:** Telegram, Discord and Signal, with the steps for each.
- **Service and pairing:** installs the background service (systemd or launchd), then helps you approve your own account when you message the bot.
- **Import:** if it finds OpenClaw or Hermes, it previews what it can bring over before importing: memory (it offers bigger caps when yours is larger), persona and name, skills (flagging the tools and programs they need), scheduled jobs (added disabled for you to review), and the people on your allowlists (paired only if you say so). `garnet import openclaw|hermes` does the same outside setup.
- **Workspace instructions and skill files:** an `AGENTS.md` in the workspace root (any letter case; `CLAUDE.md` is not read) is put in the prompt as your project instructions, capped at 8,000 characters. It is read when a conversation starts, so edits apply after `/new`. Skills can bundle `references/`, `scripts/` and other text files; Garnet lists them when it opens a skill and reads them on request (text only, 64 KB max, never outside the skill folder).

Run it again to change one part: it shows what is set and offers a menu. For scripts and CI, `garnet setup -y` takes every answer from flags (`garnet setup --help`), for example:

```sh
printf '%s' "$KEY" | garnet setup -y --provider anthropic --key-stdin --name Juno --channels telegram --service
```

`--channels telegram,discord` picks several (`--channels none` picks none; `--telegram` and `--no-telegram` still work). On a terminal, setup shows the channels as one checklist: arrow keys or numbers to tick, Enter to continue, then it sets up each ticked channel in turn. If commands are allowed (`permissions.exec` is `ask` or `allow`), setup also asks where they run: Docker, another machine over ssh (`--sandbox ssh --ssh-host ... --ssh-user ... --ssh-workdir ...`) or this machine.
### The terminal chat

`garnet chat` fills the terminal: a status bar at the top (name, model, session, what Garnet is doing, context, tokens and cost, and a warning once the conversation has read untrusted content), the conversation in the middle, and the input at the bottom. Scroll with PgUp/PgDn, Shift+Up/Down, Ctrl+Home/Ctrl+End or the mouse wheel; while you are scrolled up, new replies wait below with a "new messages below" line. With mouse reporting on, hold Shift (Option in iTerm2) to select text, or press F2 to turn it off. `/help` lists every key. Prefer the conversation to stay in your terminal's scrollback? Use `garnet chat --inline`, or `garnet config set chat.fullscreen false` to make that the default. Pipes and `--plain` give a line-based chat.

### Telegram by hand

`garnet setup` covers this. Without it: create a bot with [@BotFather](https://t.me/BotFather), store the token (`garnet secrets set TELEGRAM_BOT_TOKEN`, or a `TELEGRAM_BOT_TOKEN=...` line in `~/.garnet/env`), set `"channels": { "telegram": { "enabled": true } }` in `~/.garnet/config.json` (`garnet config explain` lists every setting), run `garnet start`, message your bot, and approve the pairing code it sends with `garnet pair approve <code>` (or pair someone whose ID you know with `garnet pair add telegram <user-id>`). `garnet service install` keeps it running; give each extra Garnet home its own instance with `GARNET_HOME=~/.garnet-work garnet service install --name work`.

### Photos, files and voice notes

Send Garnet a photo, a PDF, a text or CSV file, or a voice note in any chat (or `/attach <path>` in `garnet chat`, or an `image_url` data URL over the API). Photos and PDFs go to the model natively when it supports them (`model.vision`, `model.pdf`; on for Anthropic, off by default for OpenAI-compatible servers). Voice notes need a transcription backend, off by default:

```json
"media": { "transcription": { "backend": "openai-compatible", "baseUrl": "https://api.groq.com/openai/v1", "model": "whisper-large-v3-turbo", "apiKeyEnv": "GROQ_API_KEY" } }
```

A local whisper server or command works too (`garnet config explain` shows every option). Without one, Garnet says it can't listen to voice notes rather than going silent. Files are stored in `~/.garnet/media`, never inside the conversation log. Garnet can send you files from its workspace with `send_file`, which asks for your approval first.

### Encrypted secrets

`garnet setup` uses the encrypted store by default (`~/.garnet/secrets`, AES-256-GCM with a scrypt-derived key). To manage it by hand:

```sh
garnet secrets keygen /etc/garnet/key      # a key file outside ~/.garnet, mode 600
export GARNET_SECRETS_KEY_FILE=/etc/garnet/key         # or put this line in ~/.garnet/env; the path is not secret
garnet secrets import-env                # move the keys config refers to out of ~/.garnet/env
garnet secrets set TELEGRAM_BOT_TOKEN    # or add one; the value is read from stdin
garnet secrets list                      # names only
```

`GARNET_SECRETS_PASSPHRASE` works instead of a key file. Environment variables always win over stored secrets, so existing setups keep working unchanged.

### Reminders and schedules

Ask in chat: "remind me at 5pm to call mom", "every weekday at 9 summarize my notes folder", "check this page every 30 minutes and tell me when it changes". Garnet asks for your approval first (`schedule.edit` is `ask` by default), shows the next run in your time zone, and sends results back to the chat you asked from. Set your zone once with `"timezone": "Europe/London"` in `config.json` (default: the host's).

- **Reminders** send fixed text and never call the model.
- **Script-only jobs** run a command in the sandbox and send its output only when it is non-empty (or changed). They need `exec` set to `allow` or `ask`, and you approve the exact command.
- `garnet jobs` lists every job (from config, chat or the CLI) with its next run; `garnet jobs add|edit|pause|resume|delete` manage them, and so does the dashboard's Schedules page. Jobs in `config.json` stay yours: Garnet can pause them but not change them.
- Garnet can also message you on its own with `send_message` (`message.send` is `ask` by default), only to paired chats, at most `gateway.messagesPerHour` times an hour.

### Use the API (optional, off by default)

```sh
garnet api enable
garnet api key create --name laptop --scopes chat
```

Point any OpenAI-compatible client at `http://127.0.0.1:7311/v1` with that key. Garnet keeps the conversation on the server and only reads your newest message. Each chat in Open WebUI, LibreChat and similar apps gets its own conversation (named by the chat's first message, or by `X-OpenWebUI-Chat-Id` when Open WebUI forwards it). A client that sends only its newest message should name the conversation with an `X-Garnet-Conversation: <name>` header. `/approve CODE` and `/deny CODE` work in API chats, Open WebUI's title and tag requests are answered without running the agent, and browser apps can call the API directly once their origin is listed in `api.corsOrigins`.

In any chat, `/help` lists the commands: `/new`, `/stop`, `/retry`, `/usage`, `/status`, `/approve` and `/deny`.

`garnet dashboard` turns on the web dashboard and prints a login link. The link works once and only for 15 minutes: the dashboard swaps it for a session key that stays in that browser tab.

Garnet keeps its data in `~/.garnet` (override with `GARNET_HOME`). Tools can only touch `~/.garnet/workspace`; writes ask for your approval by default. A `workspace` setting that would contain `~/.garnet` itself is refused, since tools could then rewrite Garnet's config and secrets.

### Cost

Garnet shows dollar cost beside token usage (terminal turn summary and `/usage`, chat `/usage`, the dashboard Usage page, `GET /api/usage`). Prices come from a model catalog: a list shipped with Garnet, refreshed from openrouter.ai's public model list (Anthropic, Google and OpenAI rates, cache prices included) whenever you add a provider, run a checked `garnet setup` or `garnet models` (cached under `<GARNET_HOME>/cache`; starting Garnet never fetches). `garnet models [provider]` shows what a provider offers and what it costs; a model the catalog does not cover (local servers, other gateways) shows an explicit "price unknown". `model.pricing` in `config.json` always wins, and is how you price those models: USD per million tokens as `{ "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }` (omitted cache prices are derived from `input`: 0.1x read, 1.25x write). Without a price, or when the provider does not report tokens, cost shows `?`, never `$0`. Set `budgets.dailyUsd` to refuse new chat turns and agent jobs once today's (your `timezone`) known cost reaches the cap (a running task stops before its next model call; with no price, or a task of unknown cost today, it refuses rather than count $0); script and reminder jobs are unaffected. It is off by default.

### Web access and untrusted content

`web_fetch` reads a page as Markdown and `web_search` searches the web. Both ask first by default (`permissions.net.fetch`); list hosts you trust in `web.allowHosts` to skip the question for them, or set `net.fetch` to `allow`. They only reach public internet addresses: private, loopback, link-local and cloud-metadata addresses are refused, after DNS and on every redirect. Search uses DuckDuckGo's HTML page by default, which needs no key but is unofficial and may be rate limited; `web.search.backend` can be `searxng` (your instance), `brave` or `tavily` (keys by secret name, e.g. `garnet secrets set BRAVE_API_KEY`).

Web pages can carry instructions meant for Garnet (prompt injection). Once a conversation has read a page or search results, Garnet asks before any action that could do harm or leak data, even ones you set to `allow`: writing files, running commands, sending messages, changing memory, skills or schedules, and fetching a URL that neither you wrote nor a page contained word for word. The approval says why, `garnet chat` shows `⚠ untrusted content read`, and the dashboard marks the session. It lasts until `/new` starts a fresh conversation. `containment` in config changes which actions this covers.

### Built-in skills and connectors (optional, off by default)

Garnet ships three skills (`daily-briefing`, `web-research`, `github-triage`) and four connectors: `calendar` (your calendar's private ICS feed, read-only), `github` (issues, pull requests, notifications; comments only if you allow them), `weather` (Open-Meteo, keyless) and `http` (any public web API, with credentials you list by name). Nothing is on until you enable it, everywhere or for one channel, chat, API key, job or shared conversation:

```sh
garnet connectors enable calendar --channel telegram
garnet secrets set GARNET_CALENDAR_URL
garnet skills enable daily-briefing --channel telegram
garnet skills effective --channel telegram
```

Connectors go through the same permissions and untrusted-content rules as web access, and config only names their secrets. A conversation keeps the set it started with; restart the service and send `/new` to pick up changes. Details and setup for each: [docs/CONNECTORS.md](docs/CONNECTORS.md).

## Develop

```sh
npm run check    # lint + typecheck + tests (offline)
```

Start with [AGENTS.md](AGENTS.md), the map of the codebase for humans and agents alike. To test a real deployment, see [docs/LIVE-TESTING.md](docs/LIVE-TESTING.md).

## License

Apache-2.0
