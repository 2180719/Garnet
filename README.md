# Ruby

A persistent personal agent you can actually read.

Ruby runs on your own VPS or computer and is designed to be reached through Telegram, Signal, Discord, an opt-in dashboard, or a key-gated API. It is small enough to audit, secure by default, and careful with tokens.

> **Status: pre-release.** Phase 1 (the core loop, tools, policy, storage and CLI) works today. Channels, the gateway and the dashboard are in progress. See [PLAN.md](PLAN.md).

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

Ruby keeps its data in `~/.ruby` (override with `RUBY_HOME`). Tools can only touch `~/.ruby/workspace`; writes ask for your approval by default.

## Develop

```sh
npm run check    # lint + typecheck + tests (offline)
```

Start with [AGENTS.md](AGENTS.md), the map of the codebase for humans and agents alike.

## License

Apache-2.0
