# contracts

Shared, dependency-light types every module uses: `ChatMessage` and content blocks, `ModelAdapter`/`ModelEvent`, `ToolDefinition`/`ToolResult`, `SessionEvent`, `TaskRecord`, `Usage`, `RubyError` categories, `newId`.

- Owns: shapes that cross module boundaries. Nothing else.
- Must not: import other Ruby modules or do I/O.
- Changing a contract: update every implementation in the same change and add or adjust tests.
- `Usage` fields are `null` when unknown; never coerce unknown to zero.
- `ProviderBlock` carries opaque provider data (for example, signed thinking) that must be replayed unchanged.
