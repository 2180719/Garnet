# Live testing handoff

For an agent (or person) who deploys Garnet on a real host and tests it against real providers and channels. The offline suite (`npm run check`) passes; nothing below has been run live. Do not assume it works because the tests are green.

Rules while you work: report what you ran and saw, not what you expect. Never paste secrets into issues or logs. If you change Garnet, use a branch and `npm run check` (see [AGENTS.md](../AGENTS.md)).

## Prerequisites

- Linux host (systemd user services) or macOS (launchd). Node.js 22.18 or newer (`node -v`).
- Docker, if you test the sandbox. Pull the image first: `docker pull debian:stable-slim` (the default `sandbox.image`; the sandbox does not pull).
- A regular, non-root user for the service. Run `loginctl enable-linger <user>` yourself if the service must survive logout (Garnet only prints the hint).
- Garnet itself: `curl -fsSL https://raw.githubusercontent.com/garnet-foundation/Garnet/main/install.sh | sh` (installs to `~/.local/share/garnet` with a `garnet` command in `~/.local/bin`), or `git clone https://github.com/garnet-foundation/Garnet && cd Garnet && npm install` and use `npm run garnet --` in place of `garnet`.
- Accounts and credentials, with the names Garnet reads by default (all configurable in `config.json`):

| Needed for | Name | Config field |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `model.apiKeyEnv` |
| Google Gemini | `GEMINI_API_KEY` | `model.provider = "gemini"` (or a named entry in `providers`); `model.name` e.g. `gemini-3.8-flash` (`garnet models` lists current ones with prices). Not covered by automated tests: live Gemini calls are untested until you try one. |
| OpenAI-compatible (OpenRouter) | any name, e.g. `OPENROUTER_API_KEY` | `model.apiKeyEnv`, plus `model.provider = "openai-compatible"` and `model.baseUrl` (`https://openrouter.ai/api/v1`) |
| Telegram | `TELEGRAM_BOT_TOKEN` | `channels.telegram.tokenEnv` |
| Discord | `DISCORD_BOT_TOKEN` | `channels.discord.tokenEnv` |
| Signal | no token; a registered number and a running `signal-cli` daemon | `channels.signal.account` (E.164), `channels.signal.baseUrl` (default `http://127.0.0.1:8080`) |
| Secret store unlock | `GARNET_SECRETS_KEY_FILE` (path) or `GARNET_SECRETS_PASSPHRASE` | not in config |

Names resolve from the process environment first, then from the encrypted store. Service installs also read `<GARNET_HOME>/env` (`KEY=value` lines, mode 0600). `GARNET_HOME` defaults to `~/.garnet`.

## Deploy

All commands run from the repo root as the non-root service user. Every command below appears in `npm run garnet -- help`.

```sh
garnet setup                                 # model, key, persona, channels, tools and extras, service, pairing
garnet doctor                                # checks the install and setup
npm run garnet -- config explain             # every setting
npm run garnet -- chat --fake                # offline sanity check
```

Or by hand: `npm run garnet -- init --defaults`, put the provider key in `~/.garnet/env` (`chmod 600`), then edit `~/.garnet/config.json` to enable what you will test. Check it:

```sh
npm run garnet -- config check
npm run garnet -- config show                # secrets redacted
```

Encrypted secret store (optional, but test it; see `src/secrets/AGENTS.md`):

```sh
npm run garnet -- secrets keygen /etc/garnet/key            # key file outside ~/.garnet, mode 0600
export GARNET_SECRETS_KEY_FILE=/etc/garnet/key              # also add this line to ~/.garnet/env for the service
npm run garnet -- secrets import-env                      # moves the names config refers to out of ~/.garnet/env (add --keep to leave them)
npm run garnet -- secrets set DISCORD_BOT_TOKEN           # value read from stdin
npm run garnet -- secrets list                            # names only
npm run garnet -- secrets rm <NAME>
```

Foreground run first, then the service:

```sh
npm run garnet -- start                      # Ctrl+C to stop; watch the output
npm run garnet -- service show               # prints the unit without installing
npm run garnet -- service install
npm run garnet -- service status
journalctl --user -u garnet -f               # Linux logs (macOS: <GARNET_HOME>/logs/garnet.out.log)
npm run garnet -- service uninstall
```

Other commands you will use: `garnet pair list|approve <code>|revoke <channel> <id>`, `garnet api status|enable|disable`, `garnet api key create --name <n> [--scopes chat,read,admin] [--expires-days N]`, `garnet api key list|revoke <id>`, `garnet dashboard` (enables the dashboard and prints a login link), `garnet jobs list|history <id>|run <id>|resume <id>`, `garnet sessions`, `garnet backup [dir]`, `garnet restore <dir>`, `garnet import <openclaw|hermes> [--from <dir>] [--apply]`.

A running service reads the secret store once. Restart it after `garnet secrets` changes.

## Checklist

Mark each item pass or fail with a redacted log excerpt. A reasonable order is: install and setup, models, one channel, restart recovery, API, dashboard, the rest.

### 0. Install and setup

Only tested offline and in a scratch `HOME` on one Linux container (no systemd user bus, root user). Test on a real host as a regular user, on Linux and macOS.

1. Run the `curl … | sh` one-liner as a non-root user with Node 22.18+. Expect the shim in `~/.local/bin`, a PATH hint if that is not on PATH, and `garnet setup` to start on the terminal (stdin comes from `/dev/tty` even though the script was piped). Run it again: expect "Already up to date" and no prompts about an existing setup.
2. Without Node.js, and with Node 20: expect a clear message with install options and exit 1.
3. With another program called `garnet` on PATH: expect the installer to warn about shadowing and never to overwrite it; `--name garnet-agent` works; `garnet doctor` reports which `garnet` is on PATH.
4. `garnet setup` on a real terminal: numbered menus, the channels checklist (arrows or numbers to tick, Enter to confirm, none ticked is fine, with and without `NO_COLOR`), hidden key input (dots only), Ctrl+C at any question saves nothing. Accept the live checks: a real Anthropic key (expect "key accepted"), a wrong key (expect "rejected", and the offer to re-enter), an OpenRouter key (uses `GET /api/v1/key`; confirm that endpoint still exists), a local Ollama (`/v1/models`), a Telegram token (expect the bot's @username), a Discord token. The key must not appear on screen, in `config.json` or in shell history.
5. Let setup install the service, then pair through it: message the bot, press Enter at the prompt, approve the code. Expect the greeting in the chat. On macOS check that `launchctl kickstart -k` restarts the agent when setup offers a restart.
6. Wake-up: in `garnet setup` choose "Wake it up" with a real key (and again with a weak or local model). Expect the agent to speak first, ask name, your name, answer style, time zone and what you want help with, call `set_profile` and `memory` (visible tool rows), and print "Tool check passed". Check `config.json` (`persona` between the `garnet setup` markers, `timezone`) and `memory/default/USER.md`. With a model that cannot call tools, expect the chat to stop with "Setup chat is stopping because ..." and the three form questions, never a loop. `garnet setup -y` must not open a chat. `garnet wake` re-runs it.
7. Re-run `garnet setup`: the menu shows the current values (tools, connectors and skills, voice notes, spending cap and dashboard are entries too: tick commands and expect the sandbox question, add a calendar feed and expect the address never on screen or in `config.json`); changing only the persona keeps everything else in `config.json` byte-for-byte apart from `persona`.
8. `garnet doctor` on the finished host: expect no failures; stop Docker with `permissions.exec` at `ask` and expect a sandbox failure with a fix.

### 1. Anthropic model

1. `model.provider = "anthropic"`, `model.name` as shipped (`claude-opus-5-5`). Run `garnet chat`. Expect: tokens stream as they arrive, reply completes.
2. Send two turns in one session. Expect in the second turn's usage (dashboard Usage or Sessions page, or the event log) `cacheReadTokens` greater than 0. If it is 0 or null, record the first turn's `cacheWriteTokens` and the prompt size; very short prompts may be under the provider's minimum cacheable size.
3. Set `model.effort` to `high` and give a task that needs several tool calls (for example read three files in the workspace, then summarize). Expect a normal tool loop with no provider error about thinking blocks.
4. Force a compaction: set `context.compactAtTokens` to its minimum (10000) and keep chatting with large tool outputs until the next task starts with a checkpoint summary. Then run another multi-tool task. Expect: no 400 error about signed thinking, and the model still knows constraints you stated before compaction. The prompt and tool set change only at the checkpoint.
5. Set an invalid key. Expect a clear error that does not contain the key.

### 2. OpenAI-compatible provider (OpenRouter)

1. Set `model.provider = "openai-compatible"`, `model.baseUrl = "https://openrouter.ai/api/v1"`, `model.name` to a tool-capable model, `model.apiKeyEnv` to your key's name, and optionally `model.contextWindow`.
2. Chat with a prompt that needs a tool. Expect streaming, a tool call executed, and usage recorded (the adapter sends `stream_options.include_usage`).
3. Repeat with a local server (Ollama or llama.cpp) if available. Note any server that rejects `stream_options` or `max_tokens`.

### 3. Telegram

1. Enable `channels.telegram`, start Garnet, message the bot from a new account. Expect one pairing code reply. Messaging again before the code expires must not issue a second code.
2. `garnet pair approve <code>`. Expect the next message to be answered. `garnet pair revoke telegram <id>` must stop replies.
3. With `fs.write` at `ask`, ask the bot to write a file. Expect an approval prompt in the chat. `/approve <code>` runs it once; `/deny <code>` refuses; reusing a code fails.
4. Ask for a reply longer than 4096 characters. Expect several messages, in order, none cut mid-word badly and none missing.
5. Rate limiting: send many messages quickly (or a long split reply to several chats). If Telegram returns 429, expect the outbox to wait for `retry_after` and then deliver. This is hard to trigger on purpose; record whether you saw it.
6. `/new` starts a fresh conversation; `/stop` cancels a running task; `/retry` repeats your last message; `/usage`, `/status` and `/help` answer without calling the model.
6a. Ask for a reply with headings, **bold**, `code`, a fenced code block, a link and a table. Expect it rendered (bold, monospace, a tappable link), with no raw `**` or backticks. If any reply arrives as plain text, check the log for a Telegram "can't parse entities" fallback and record the text that caused it.
6b. Send a voice note, a photo with a caption, a file and a sticker. Expect one short "I can't … yet" reply to each and no model call.
7. Start a second Garnet with the same token. Expect a 409 conflict reported in health with backoff, not a crash. Stop it and expect the first to recover.
8. Group chats: expect Garnet to ignore them (the gateway ignores group chats).

### 4. Signal (signal-cli daemon)

1. Run `signal-cli -a +<bot number> daemon --http 127.0.0.1:8080`. Set `channels.signal.enabled`, `account`, and `baseUrl` if different.
2. Message the bot number from a phone. Expect a pairing code, then replies after approval.
3. Check what the incoming envelope actually looks like (`dataMessage.message`, sender number or uuid, timestamp) and compare with `src/channels/signal.ts`. Record any field the adapter misses. This shape was only partly verified against documentation.
4. Send a message from a number that has a uuid but no visible number (a contact with phone-number privacy). Expect it to be handled, with the chat id being the uuid.
5. Groups: add the bot to a group and post. Expect it to be ignored (group chats are ignored by the gateway).
6. Reconnect: stop the daemon for a minute, restart it, send a message. Expect `health` to recover and the message to be answered. Messages sent while the daemon was down may be lost; Signal inbound is not at-least-once. Record what happened.
7. Non-loopback `baseUrl` over plain http must be refused at start; https is accepted.

### 5. Discord

1. Create a bot. In the Developer Portal enable Message Content under Privileged Gateway Intents. Enable `channels.discord`.
2. DM the bot. Expect a pairing code, then replies.
3. Disable the intent and restart. Expect the gateway to close with 4014 and `lastError` to explain it; no reconnect loop.
4. Guild: invite the bot to a server and mention it. Expect no reply. Guild messages are passed through but the gateway ignores them for now; this is the shipped behavior, not a failure. Record it.
5. Drop the network (for example `iptables` block or `ip link set down` for 30 to 60 seconds, then restore). Expect the socket to reconnect and RESUME, and no duplicate replies.
6. Ask for a reply longer than 2000 characters. Expect several messages in order, with no `@everyone` or role pings even if the model writes them.

### 6. Restart recovery

1. Start a long task on any channel (for example a task that runs `run_command sleep 120`, or a long model response). Run `kill -9 <pid>` while it runs. Restart.
2. Expect: the task is not replayed, and the sender is told it was interrupted.
3. While Garnet is stopped, send three messages to the bot. Start Garnet. Expect each to run once, in the order sent, with no message overtaking an older one. (Telegram keeps them server-side; Signal and Discord may not.)
4. Kill -9 during an outgoing reply. Expect that message to be marked `uncertain` and not resent, unless the channel dedupes sends.

### 7. HTTP API

1. `garnet api enable`, `garnet api key create --name test --scopes chat`. Restart. Expect `GET /health` to work without a key and every other route to return 401 without one.
2. `curl http://127.0.0.1:7311/v1/chat/completions -H "Authorization: Bearer <key>" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'`. Then the same with `"stream": true`. Expect SSE chunks ending in `data: [DONE]`. Try an OpenAI client library pointed at `/v1`.
3. A `chat` key must be refused on `/api/*` admin routes (403). A revoked key and an expired key (`--expires-days`) must be refused.
4. Send more than `api.rateLimitPerMinute` requests in a minute. Expect 429.
5. Set `api.host` to `0.0.0.0` with no keys. Expect Garnet to refuse to listen. Create a key; expect it to listen.
6. Behind a reverse proxy (nginx or Caddy) with `api.trustProxy = true`: the proxy must append the client address to `X-Forwarded-For`. From two client IPs, confirm the audit log (dashboard Logs page) shows the right addresses, and that a spoofed `X-Forwarded-For: 1.2.3.4` sent by a client does not become the logged address (rightmost entry wins). Also confirm streaming is not buffered by the proxy.
7. Send a request body slower than 30 s to an authenticated route. Expect 408 and a closed connection.
8. Open WebUI: add Garnet as an OpenAI connection (`http://<host>:7311/v1`, a `chat` key). Start two chats with different first messages and check that neither sees the other (ask "what did I just say?"). Check that generated titles, tags and follow-ups do not appear as turns in `garnet sessions`. Repeat with `ENABLE_FORWARD_USER_INFO_HEADERS=true` (conversations then follow `X-OpenWebUI-Chat-Id`). Ask for something that needs approval and type `/approve CODE` in the same chat.
9. Behind nginx with default timeouts (60 s), run a task longer than a minute with streaming. Expect the stream to survive (keepalive comments every 15 s).
10. A browser-direct client (for example TypingMind) on an origin listed in `api.corsOrigins`: expect the preflight to pass and chats to work; from an unlisted origin expect a browser CORS error.

### 8. Dashboard

1. `garnet dashboard`, open the printed link within 15 minutes. It works once: the dashboard trades the key in the URL fragment for a session key and revokes it, so opening the same link again shows "expired or already used".
2. Visit every page: overview, chat, approvals, memory, skills, schedules, channels and pairing, API keys, usage, settings, sessions, logs, routing, achievements. Note any page that errors or renders empty with real data.
3. Settings: protected fields (permissions, sandbox, model provider, base URL, key names, API host/port/proxy, demo origins, workspace, channel token names, Signal URL) must be read-only; saving a change to one over the API must fail. Changing a normal field must show a review step before saving and report that a restart is required.
4. Keyboard navigation: not yet checked by hand. Tab through each page, operate every control without a mouse, check visible focus and that dialogs trap focus and close on Escape. Record failures.
5. Open the page source and the browser console. Expect no CSP violations and no third-party requests.

### 9. Public site and demo endpoint

1. Serve `site/` from a static host. Run Lighthouse (mobile and desktop). Expect at least 95 in every category, and zero third-party requests in the network panel.
2. Enable `api.demo` with `allowedOrigins` set to the site origin. From that origin the demo chat should work with no key. From another origin, expect the CORS preflight and the request to be refused.
3. Send more than `perIpPerHour` messages from one IP. Expect refusal. Set a small `dailyTokenBudget` (minimum 1000) and spend it. Expect the demo to pause. Send several concurrent requests near the limit and confirm the total does not exceed the budget by more than one request's worst case.
4. Confirm the demo uses no tools and keeps no history (nothing new in `garnet sessions`).

### 10. Scheduler

1. Add a cron job with a near-term schedule and a `notify` channel. Expect it to run once at the slot, not twice after a restart.
2. Pre-checks: a `file_changed` job with an unchanged file must not call the model (check usage). Change the file and expect a run. Do the same with `url_changed`.
3. Pausing: make the job's runs fail, for example with an invalid model key. After 3 consecutive failures expect the job to pause and the owner to be notified on the notify channel. `garnet jobs resume <id>` re-enables it. Also try `garnet jobs run <id>` and `garnet jobs history <id>`.
4. A job across a real DST boundary cannot be tested live on demand. It is covered only by offline tests. Do not mark it passed.

### 11. Docker sandbox as non-root

1. Allow `exec` (`permissions.exec = "ask"`), `sandbox.backend = "docker"`. Ask Garnet to run `id` and `curl https://example.com`. Expect a non-zero uid, and the network call to fail (`sandbox.network` is `none`).
2. Write a file in the workspace from the command; confirm it appears on the host owned by the expected user. Try writing outside the workspace; expect failure (read-only root, `/tmp` is a 64 MB tmpfs).
3. Run Garnet as root on a test host (not production). Expect the container user to be the workspace owner if that is not root, else 65534:65534; if that user cannot write the workspace, startup should refuse with a remedy. Set `sandbox.user` to a valid `uid:gid` and to `0:0` (expect a config error).
4. Run `sleep 600` and cancel with `/stop`; expect the container to be killed. Check `docker ps` for leftovers.
5. Docker not running: expect a clear failure, not a silent fallback to the local backend.

### 11b. SSH sandbox

Use a throwaway VM or a dedicated unprivileged account, never your own login.

1. On the remote: `mkdir -p /srv/garnet/work`. Set `permissions.exec = "ask"`, `sandbox.backend = "ssh"` and `sandbox.ssh` (`host`, `user`, `workdir`, and `agent: true` or `identityFile`). Leave `hostKeyChecking` at `strict`.
2. `garnet sandbox check` before the host is in `known_hosts`: expect a failure that says how to add the key. Add it (`ssh-keyscan`), check again: expect ok and the real workdir. `garnet doctor` shows the same under `sandbox`.
3. Ask Garnet to run `hostname; id; pwd`. Expect the remote host, the remote account and the workdir. Run with `cwd: "sub"` after `mkdir sub` remotely; try `cwd: ".."` (expect a refusal) and a symlink out of `workdir` (expect a refusal).
4. Run `sleep 600` and cancel with `/stop`; expect the local `ssh` client to exit. Check the remote with `ps` for leftovers (a command that ignores SIGHUP may keep running; the account's limits are the backstop).
5. Wrong user or key: expect a clear failure, never a fallback to `local` or Docker. With a passphrase-protected key and `passphraseEnv` set, expect it to work without a prompt (OpenSSH 8.4+).
6. Change the remote host key (or use a different `known_hosts`): expect refusal under `strict`.

### 12. Backup and restore

1. With secrets in the store, run `garnet backup /path/to/dir`. Confirm the encrypted `secrets` file is in it and the key file is not.
2. Stop Garnet, `garnet restore /path/to/dir` on a fresh `GARNET_HOME`, set `GARNET_SECRETS_KEY_FILE` to the same key, start. Expect sessions, memory, skills, config, pairings and secrets to work. Wrong key: expect a clear error that does not print values.
3. Check backup file modes. The backup holds the database (API key hashes, conversations) and the encrypted store; treat it as sensitive. The env file is not included, so keep your own copy.

### 13. Importers

1. Against a real OpenClaw install: `garnet import openclaw --from <dir>` (dry run), review the output, then `--apply`. Expect memory within caps (originals archived), persona, and skills as owner skills. Expect no secrets read.
2. Same for `garnet import hermes`.
3. Record any `openclaw.json` channel key shape that the importer misreads or ignores.

## Known gaps and unverified items

- Telegram behavior (limits, 429 `retry_after`, 409 handling, update semantics) was implemented without checking the official docs, which were unreachable at the time. Verify against live behavior and the docs.
- The Signal incoming envelope shape was only partly verified against documentation.
- The OpenClaw `openclaw.json` channel key shapes used by the importer are unverified.
- Hidden terminal input for `garnet secrets set` is untested on a real TTY (offline tests use piped stdin).
- Dashboard keyboard navigation has not been checked by hand.
- A long message that was split, where a later chunk fails with a retryable error, resends the earlier chunks too (duplicates are possible).
- A client without a key can trickle a request body to paths that never read bodies, holding a connection.
- `mkdir -p` in `write_file` could create empty directories outside the workspace if a symlink is swapped in during a race. No file content is written there.
- Hourly (wildcard-hour) cron jobs fire in both repeated hours at a DST fall-back. This is deliberate and matches cronie.
- DST behavior of scheduled jobs is only tested offline.
- Discord guild messages and Signal/Telegram group messages are ignored by design for now.
- A running service does not see `garnet secrets` changes until restarted. Two concurrent `garnet secrets` writers: last write wins.

## Reporting

For each checklist item record pass or fail, the commit hash (`git rev-parse --short HEAD`), the Node version, the OS, and a short log excerpt with secrets removed (tokens, API keys, `garnet_...` keys, pairing codes, phone numbers). `garnet config show` output is already redacted; raw logs may not be. Put results in a single file or issue comment, one section per checklist item.

File one issue per failure with: steps, expected, actual, log excerpt, and whether it is already listed above. Items under "Known gaps" that you confirm are still worth an issue if they bite in practice. Do not file issues containing secrets.
