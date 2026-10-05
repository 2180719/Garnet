# models

Provider adapters implementing `ModelAdapter` from contracts.

- `FakeModel`: scripted and offline, for tests and `--fake`. Records every request.
- `AnthropicModel`: official SDK, streaming, with a cache breakpoint on the system prompt plus automatic conversation caching, `eager_input_streaming` tools, server-side refusal fallback (`fallbacks: "default"`) and configurable effort. SDK retries are off; the runtime retries.
- Adapter rules: end every stream with exactly one `done` or `error` event; never throw for provider failures; map errors to `provider_transient`/`provider_fatal`/`cancelled`; keep unknown blocks as `provider` blocks in their original position so history replays byte-for-byte.
- Tests use recorded SSE through an injected `fetch`; never call the network in `npm test`.
