# runtime

The agent loop and task lifecycle.

- Public API: `Agent.run(sessionId, text, { signal, onEvent, source })` → `TaskRecord`; `LaneQueue` for one active run per session with a global cap.
- Loop: persist user message → check cancel/budget → build context → stream model → persist assistant message → for each tool call persist intent (`tool_started`), execute, persist result → repeat.
- The runtime is the only writer of model/tool lifecycle events.
- Retries: only `provider_transient`, only when no text was streamed yet, with backoff or `retry-after`.
- Tool calls from a `max_tokens` or `refusal` turn are never executed.
- Statuses: `running`, `waiting_for_user`, `waiting_for_approval`, `completed`, `cancelled`, `budget_exhausted`, `failed`.
