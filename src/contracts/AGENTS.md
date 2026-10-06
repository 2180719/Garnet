# contracts

Shared, dependency-light types every module uses: `ChatMessage` and content blocks, `ModelAdapter`/`ModelEvent`, `ToolDefinition`/`ToolResult`, `SessionEvent`, `TaskRecord`, `Usage`, `RubyError` categories, `newId`.

- Owns: shapes that cross module boundaries. Nothing else.
- Must not: import other Ruby modules or do I/O.
- Changing a contract: update every implementation in the same change and add or adjust tests.
- `Usage` fields are `null` when unknown; never coerce unknown to zero.
- `ProviderBlock` carries opaque provider data (for example, signed thinking) that must be replayed unchanged.
- Attachments: `AttachmentBlock` holds an `AttachmentRef` (media id, kind, sniffed MIME type, size, name) plus derived `text` (transcript, extracted text) and a `note`. `data` (base64) is set only on blocks inside a `ModelRequest` and is never persisted; the runtime strips it before writing events. `attachmentText` is the provider-neutral text rendering. `ModelCapabilities.media` says which files a model reads natively.
- Channels: `InboundMessage.attachments` are unfetched (`ref` is adapter-private) so nothing is downloaded for unpaired senders; `unsupported` describes content nobody can read (stickers, locations). `OutboundMessage.attachments` are stored files the adapter uploads; `ChannelAdapter.fetchAttachment` downloads with a byte cap; `ChannelCapabilities.maxUploadBytes` is set by adapters that send files.
