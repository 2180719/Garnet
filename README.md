# Ruby

A persistent personal agent you can actually read.

Ruby runs on your own VPS or computer and is designed to be reached through Telegram, Signal, Discord, an opt-in dashboard, or a key-gated API. It is small enough to audit, secure by default, and careful with tokens.

> **Status: pre-release.** Working today: the agent loop, tools with approvals (including over chat), web fetch and search with prompt-injection containment, bounded memory, skills, compaction, the gateway, Telegram, Signal and Discord, a key-gated OpenAI-compatible API, cron jobs and heartbeats, Anthropic and OpenAI-compatible models, and service install. A Docker sandbox for commands, backup and restore, and importing from OpenClaw or Hermes are in too. So is the opt-in dashboard (`ruby dashboard`). See [PLAN.md](PLAN.md).

## Install

Requires Node.js 22.18 or newer and git. No sudo; nothing outside your home directory.

```sh
curl -fsSL https://raw.githubusercontent.com/2180719/Ruby/main/install.sh | sh
```

The installer checks Node.js (and says how to get it if it is missing or too old), clones Ruby into `~/.local/share/ruby`, installs its two dependencies, and puts a `ruby` command in `~/.local/bin`. Then it starts `ruby setup`. Run it again any time to update; it leaves local changes alone. `sh install.sh --help` lists the options (`--dir`, `--bin-dir`, `--name`, `--ref`, `--no-setup`).

> **Already have the Ruby programming language?** Its interpreter is also called `ruby`. The installer never overwrites it and warns when one shadows the other; install with `--name rubyagent` to keep both.

From a clone instead (to develop, or to read the code first):

```sh
git clone https://github.com/2180719/Ruby && cd Ruby
npm install
npm link            # optional: puts `ruby` on your PATH (otherwise use `npm run ruby -- <command>`)
```

`npm install -g` from a tarball or the npm registry does not work: Node.js will not run TypeScript from `node_modules`. `npm link` and `npm install -g .` from a clone do.

## Set up

```sh
ruby setup     # model and key, persona, channels, background service, pairing
ruby doctor    # checks the install and setup, and says how to fix what it finds
ruby chat      # talk to Ruby in the terminal (`ruby chat --fake` needs no key)
```

`ruby setup` asks a few questions and saves nothing until the end:

- **Model:** Anthropic, OpenRouter, a local server (Ollama, LM Studio, llama.cpp, vLLM), any OpenAI-compatible API, or the offline demo model.
- **Keys and tokens:** typed hidden, then kept in the encrypted secret store (setup creates a key file outside `~/.ruby`), in `~/.ruby/env` (mode 600), or left to your own environment variables. Config only ever stores the *name*. If you agree, setup checks each key with one request that costs no tokens.
- **Persona:** the assistant's name, what to call you, and a line about how you like answers.
- **Channels:** Telegram, Discord and Signal, with the steps for each.
- **Service and pairing:** installs the background service (systemd or launchd), then helps you approve your own account when you message the bot.
- **Import:** if it finds OpenClaw or Hermes, it previews what it can bring over before importing: memory (it offers bigger caps when yours is larger), persona and name, skills (flagging the tools and programs they need), scheduled jobs (added disabled for you to review), and the people on your allowlists (paired only if you say so). `ruby import openclaw|hermes` does the same outside setup.

Run it again to change one part: it shows what is set and offers a menu. For scripts and CI, `ruby setup -y` takes every answer from flags (`ruby setup --help`), for example:

```sh
printf '%s' "$KEY" | ruby setup -y --provider anthropic --key-stdin --name Juno --telegram --service
```

### Telegram by hand

`ruby setup` covers this. Without it: create a bot with [@BotFather](https://t.me/BotFather), store the token (`ruby secrets set TELEGRAM_BOT_TOKEN`, or a `TELEGRAM_BOT_TOKEN=...` line in `~/.ruby/env`), set `"channels": { "telegram": { "enabled": true } }` in `~/.ruby/config.json` (`ruby config explain` lists every setting), run `ruby start`, message your bot, and approve the pairing code it sends with `ruby pair approve <code>` (or pair someone whose ID you know with `ruby pair add telegram <user-id>`). `ruby service install` keeps it running; give each extra Ruby home its own instance with `RUBY_HOME=~/.ruby-work ruby service install --name work`.

### Encrypted secrets

`ruby setup` uses the encrypted store by default (`~/.ruby/secrets`, AES-256-GCM with a scrypt-derived key). To manage it by hand:

```sh
ruby secrets keygen /etc/ruby/key      # a key file outside ~/.ruby, mode 600
export RUBY_SECRETS_KEY_FILE=/etc/ruby/key         # or put this line in ~/.ruby/env; the path is not secret
ruby secrets import-env                # move the keys config refers to out of ~/.ruby/env
ruby secrets set TELEGRAM_BOT_TOKEN    # or add one; the value is read from stdin
ruby secrets list                      # names only
```

`RUBY_SECRETS_PASSPHRASE` works instead of a key file. Environment variables always win over stored secrets, so existing setups keep working unchanged.

### Use the API (optional, off by default)

```sh
ruby api enable
ruby api key create --name laptop --scopes chat
```

Point any OpenAI-compatible client at `http://127.0.0.1:7311/v1` with that key. Ruby keeps the conversation on the server and only reads your newest message. Each chat in Open WebUI, LibreChat and similar apps gets its own conversation (named by the chat's first message, or by `X-OpenWebUI-Chat-Id` when Open WebUI forwards it). A client that sends only its newest message should name the conversation with an `X-Ruby-Conversation: <name>` header. `/approve CODE` and `/deny CODE` work in API chats, Open WebUI's title and tag requests are answered without running the agent, and browser apps can call the API directly once their origin is listed in `api.corsOrigins`.

In any chat, `/help` lists the commands: `/new`, `/stop`, `/retry`, `/usage`, `/status`, `/approve` and `/deny`.

`ruby dashboard` turns on the web dashboard and prints a login link. The link works once and only for 15 minutes: the dashboard swaps it for a session key that stays in that browser tab.

Ruby keeps its data in `~/.ruby` (override with `RUBY_HOME`). Tools can only touch `~/.ruby/workspace`; writes ask for your approval by default. A `workspace` setting that would contain `~/.ruby` itself is refused, since tools could then rewrite Ruby's config and secrets.

### Web access and untrusted content

`web_fetch` reads a page as Markdown and `web_search` searches the web. Both ask first by default (`permissions.net.fetch`); list hosts you trust in `web.allowHosts` to skip the question for them, or set `net.fetch` to `allow`. They only reach public internet addresses: private, loopback, link-local and cloud-metadata addresses are refused, after DNS and on every redirect. Search uses DuckDuckGo's HTML page by default, which needs no key but is unofficial and may be rate limited; `web.search.backend` can be `searxng` (your instance), `brave` or `tavily` (keys by secret name, e.g. `ruby secrets set BRAVE_API_KEY`).

Web pages can carry instructions meant for Ruby (prompt injection). Once a conversation has read a page or search results, Ruby asks before any action that could do harm or leak data, even ones you set to `allow`: writing files, running commands, sending messages, changing memory, skills or schedules, and fetching a URL that neither you wrote nor a page contained word for word. The approval says why, `ruby chat` shows `⚠ untrusted content read`, and the dashboard marks the session. It lasts until `/new` starts a fresh conversation. `containment` in config changes which actions this covers.

## Develop

```sh
npm run check    # lint + typecheck + tests (offline)
```

Start with [AGENTS.md](AGENTS.md), the map of the codebase for humans and agents alike. To test a real deployment, see [docs/LIVE-TESTING.md](docs/LIVE-TESTING.md).

## License

Apache-2.0
