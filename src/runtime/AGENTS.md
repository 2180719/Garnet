# runtime

The agent loop and task lifecycle.

- Public API: `Agent.run(sessionId, text | ContentBlock[], { signal, onEvent, source })` → `TaskRecord` (blocks carry attachments already stored by the media ingest; any `data` is stripped before the user message is persisted); `Agent.compact(sessionId, { signal })` → `CompactionOutcome` (compact now, regardless of the threshold; never while a task runs on that session); `LaneQueue` for one active run per session with a global cap.
- Loop: check cancel (a request cancelled before it starts records no user message) → persist user message → check cancel/budget → build context → stream model → persist assistant message → for each tool call persist intent (`tool_started`), execute, persist result → repeat.
- Every model request (and the compaction request) goes through `prepareAttachments` with the model's `capabilities.media`, `loadAttachment` and `maxAttachmentsInContext`, so adapters only ever see attachment blocks with bytes they can send, or text.
- The runtime is the only writer of model/tool lifecycle events.
- Context: the system prompt (from `promptSections`: memory snapshot, skills index) and the tool schemas are frozen per session (`context_frozen`). Tools registered or changed later are not sent until the next freeze. Before a task, if the last request used ≥ `compactAtTokens`, the runtime summarizes older turns (keep-tail) with the frozen prompt and tools, records a `checkpoint`, and re-freezes both so memory and tool changes apply.
- Retries: only `provider_transient`, only when no text was streamed yet, with backoff or `retry-after`, and never past the task's `maxWallMs` (a longer `retry-after` fails the task instead of holding the lane).
- Tool calls from a `max_tokens` or `refusal` turn are never executed. A compaction summary that stopped at `max_tokens` is discarded (compaction fails; history stays whole).
- An unexpected exception (store failure, bug) marks the task `failed` before it propagates, so no task is left `running`.
- `LaneQueue` hands a finished job's slot straight to the next waiter, so the global cap holds.
- Statuses: `running`, `waiting_for_user`, `waiting_for_approval`, `completed`, `cancelled`, `budget_exhausted`, `failed`.
