# context

Builds what the model sees.

- Public API: `systemPrompt`, `frozenSystem` (the prompt frozen for a session via a `context_frozen` event), `messagesFromEvents` (derives a valid conversation from the event log), `planCompaction`/`extractSummary`/`SUMMARY_PROMPT`.
- Compaction is keep-tail: everything before the last N user turns becomes a `checkpoint` summary. It is planned at a user-message boundary (never mid tool round), and prefix-bound provider blocks (signed thinking) are dropped from retained turns because their prefix no longer exists.
- Guarantees: roles alternate; every tool call has exactly one result (an interrupted call gets a synthetic error result); tool results come first in a user turn.
- Must not: put per-turn data (time, IDs) in the system prompt, or mutate stored events.
