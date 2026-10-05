# context

Builds what the model sees.

- Public API: `systemPrompt` (deterministic stable prefix, cache-friendly) and `messagesFromEvents` (derives a valid conversation from the event log).
- Guarantees: roles alternate; every tool call has exactly one result (an interrupted call gets a synthetic error result); tool results come first in a user turn.
- Must not: put per-turn data (time, IDs) in the system prompt, or mutate stored events.
- Planned: memory snapshot, compaction checkpoints, clean history after tool-call repair (PLAN.md phase 3).
