# channels

Messaging-platform adapters that implement `ChannelAdapter` from `contracts/channels.ts`.

- Public API: `TelegramChannel` (long-polling Telegram bot, no dependencies beyond global `fetch`).
- Adapters only normalize a platform: they never own identity, routing, dedupe or durable delivery (the gateway does).
- Inbound is at-least-once: acknowledge to the platform (advance offsets) only after `await sink(message)` resolves. If the sink throws, stop the batch and retry later from the same offset.
- `send` never throws. It returns `{ status: 'failed', retryable, retryAfterMs? }`: rate limits and 5xx/network are retryable; blocked bot or bad chat is not.
- `start` fails fast with `RubyError('config')` on a bad token. After start, errors (conflicts, outages) go to `health().lastError` and are retried with backoff; they never crash the process.
- `stop` must abort the in-flight long poll and wait for the loop to exit, so a restart does not hit a 409 conflict. It is idempotent.
- Never log or return the bot token; redact it from every error message.
- Tests are offline: inject `fetch` and `sleep`; no real timers above 50ms.
- Adding a channel: create `<name>.ts` with a class implementing `ChannelAdapter` (constructor takes options plus optional `fetch`/`sleep`), add a `<name>.test.ts`, export it from `index.ts`, and wire it in `src/main.ts` from config.

## Signal

- `SignalChannel` talks to a local `signal-cli -a +NUMBER daemon --http 127.0.0.1:8080` (`GET /api/v1/check`, SSE `GET /api/v1/events`, JSON-RPC `POST /api/v1/rpc`). No dependencies. The RPC endpoint is unauthenticated, so a non-loopback `baseUrl` must be https (else `RubyError('config')`).
- Chat ids: `group:<groupId>` for groups, otherwise the sender's number (or uuid). `externalId` is `<sender uuid|number>:<timestamp>`. Envelopes without `dataMessage.message` (receipts, typing, sync) and messages from the bot's own number are ignored.
- Inbound is NOT at-least-once. SSE has no durable offsets: the sink is awaited sequentially, a failing sink is retried 4 times with backoff, then the message is dropped and `lastError` is set. A crash or restart can lose messages (the daemon only replays its last ~1000 events to a `Last-Event-ID` reconnect within one daemon lifetime). The gateway must not assume Signal gives at-least-once.
- `health().ok` is true while the event stream is connected, or if traffic was seen in the last 2 minutes.
- Send errors: network/5xx are retryable; JSON-RPC errors and per-recipient failures (unregistered, invalid group) are not, except NETWORK_FAILURE. `replyToExternalId` is ignored (Signal quoting needs the author).
