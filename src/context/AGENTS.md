# context

Builds what the model sees.

- Public API: `systemPrompt`, `frozenContext` (the prompt and tool schemas frozen for a session via a `context_frozen` event), `messagesFromEvents` (derives a valid conversation from the event log), `planCompaction`/`extractSummary`/`SUMMARY_PROMPT`.
- Compaction is keep-tail: everything before the last N user turns becomes a `checkpoint` summary. It is planned at a user-message boundary (never mid tool round), and prefix-bound provider blocks (signed thinking) are dropped from retained turns recorded before the checkpoint because their prefix no longer exists; turns produced after the checkpoint keep them.
- Guarantees: roles alternate; every tool call has exactly one result (an interrupted call gets a synthetic error result); tool results come first in a user turn.
- Time: with `timeZone`, `messagesFromEvents` (and `planCompaction`) prefix each user message with its send time, e.g. `[Tue 2026-10-06 14:03 Europe/London, UTC+01:00]`, as a separate text block built from the event's own timestamp, so the derived history is stable and cache-friendly. The system prompt only gains a fixed line explaining the stamp (`timestamps: true`).
- Must not: put per-turn data (time, IDs) in the system prompt, or mutate stored events.
