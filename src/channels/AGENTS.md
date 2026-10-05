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
