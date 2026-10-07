# context

Builds what the model sees.

- Public API: `systemPrompt`, `frozenContext` (the prompt, tool schemas and optional built-ins (`extras`) frozen for a session via a `context_frozen` event), `messagesFromEvents` (derives a valid conversation from the event log), `planCompaction`/`extractSummary`/`SUMMARY_PROMPT`.
- Compaction is keep-tail: everything before the last N user turns becomes a `checkpoint` summary. It is planned at a user-message boundary (never mid tool round), and prefix-bound provider blocks (signed thinking) are dropped from retained turns recorded before the checkpoint because their prefix no longer exists; turns produced after the checkpoint keep them.
- Guarantees: roles alternate; every tool call has exactly one result (an interrupted call gets a synthetic error result); tool results come first in a user turn.
- Time: with `timeZone`, `messagesFromEvents` (and `planCompaction`) prefix each user message with its send time, e.g. `[Tue 2026-10-06 14:03 Europe/London, UTC+01:00]`, as a separate text block built from the event's own timestamp, so the derived history is stable and cache-friendly. The system prompt only gains a fixed line explaining the stamp (`timestamps: true`).
- `prepareAttachments` (attachments.ts) turns attachment references into what the model gets: bytes (`data`) for images and PDFs the model reads natively, newest first and at most `maxInContext` per request, each preceded by a text label; everything else (and older images past the cap, missing files, unsupported formats) becomes text from `attachmentText` with the reason. Bytes come from an injected `load`, so this module does no I/O. It returns new messages; events are never changed.
- `projectInstructionsSection(workspace)` (workspace.ts): the workspace-root `AGENTS.md` (case-insensitive, regular file only, `CLAUDE.md` ignored) as an owner-written prompt section capped at `MAX_PROJECT_INSTRUCTIONS` with a truncation note. Wired in `src/main.ts` as a prompt section, so it is frozen with the session and edits apply on `/new`.
- Must not: put per-turn data (time, IDs) in the system prompt, or mutate stored events.
