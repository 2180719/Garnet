# Ruby

A persistent personal agent you can actually read.

Ruby runs on your own VPS or computer and is designed to be reached through Telegram, Signal, Discord, an opt-in dashboard, or a key-gated API. It is small enough to audit, secure by default, and careful with tokens.

> **Status: pre-release.** Working today: the agent loop, tools with approvals (including over chat), bounded memory, skills, compaction, the gateway, Telegram, Signal and Discord, a key-gated OpenAI-compatible API, cron jobs and heartbeats, Anthropic and OpenAI-compatible models, and service install. A Docker sandbox for commands, backup and restore, and importing from OpenClaw or Hermes are in too. So is the opt-in dashboard (`ruby dashboard`). See [PLAN.md](PLAN.md).

## Try it

Requires Node.js 22.18 or newer.

```sh
git clone https://github.com/2180719/Ruby && cd Ruby
npm install
npm run ruby -- init
npm run ruby -- chat --fake        # offline, no API key needed
export ANTHROPIC_API_KEY=...       # then chat for real
npm run ruby -- chat
```

### Run it as a Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and put the token in `~/.ruby/env` (mode 600) along with your provider key:
   ```sh
   ANTHROPIC_API_KEY=...
   TELEGRAM_BOT_TOKEN=...
   ```
2. Set `"channels": { "telegram": { "enabled": true } }` in `~/.ruby/config.json` (`npm run ruby -- config explain` lists every setting).
3. `npm run ruby -- start`, then message your bot. It replies with a pairing code; approve it with `npm run ruby -- pair approve <code>`.
4. Keep it running with `npm run ruby -- service install` (systemd on Linux, launchd on macOS).

### Encrypt your secrets (optional)

Instead of plain-text values in `~/.ruby/env`, Ruby can keep them in an encrypted store (`~/.ruby/secrets`, AES-256-GCM with a scrypt-derived key):

```sh
npm run ruby -- secrets keygen /etc/ruby/key      # a key file outside ~/.ruby, mode 600
export RUBY_SECRETS_KEY_FILE=/etc/ruby/key         # or put this line in ~/.ruby/env; the path is not secret
npm run ruby -- secrets import-env                 # move the keys config refers to out of ~/.ruby/env
npm run ruby -- secrets set TELEGRAM_BOT_TOKEN     # or add one; the value is read from stdin
npm run ruby -- secrets list                       # names only
```

`RUBY_SECRETS_PASSPHRASE` works instead of a key file. Environment variables always win over stored secrets, so existing setups keep working unchanged.

### Use the API (optional, off by default)

```sh
npm run ruby -- api enable
npm run ruby -- api key create --name laptop --scopes chat
```

Point any OpenAI-compatible client at `http://127.0.0.1:7311/v1` with that key. Ruby keeps the conversation on the server: it only reads your newest message.

Ruby keeps its data in `~/.ruby` (override with `RUBY_HOME`). Tools can only touch `~/.ruby/workspace`; writes ask for your approval by default.

## Develop

```sh
npm run check    # lint + typecheck + tests (offline)
```

Start with [AGENTS.md](AGENTS.md), the map of the codebase for humans and agents alike.

## License

Apache-2.0
