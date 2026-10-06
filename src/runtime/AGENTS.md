# runtime

The agent loop and task lifecycle.

- Public API: `Agent.run(sessionId, text, { signal, onEvent, source })` → `TaskRecord`; `LaneQueue` for one active run per session with a global cap.
- Loop: check cancel (a request cancelled before it starts records no user message) → persist user message → check cancel/budget → build context → stream model → persist assistant message → for each tool call persist intent (`tool_started`), execute, persist result → repeat.
- The runtime is the only writer of model/tool lifecycle events.
- Context: the system prompt (from `promptSections`: memory snapshot, skills index) and the tool schemas are frozen per session (`context_frozen`). Tools registered or changed later are not sent until the next freeze. Before a task, if the last request used ≥ `compactAtTokens`, the runtime summarizes older turns (keep-tail) with the frozen prompt and tools, records a `checkpoint`, and re-freezes both so memory and tool changes apply.
- Retries: only `provider_transient`, only when no text was streamed yet, with backoff or `retry-after`.
- Tool calls from a `max_tokens` or `refusal` turn are never executed.
- Statuses: `running`, `waiting_for_user`, `waiting_for_approval`, `completed`, `cancelled`, `budget_exhausted`, `failed`.
