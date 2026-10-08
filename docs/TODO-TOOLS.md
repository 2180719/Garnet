# Toolset todo (2026-10-08)

Ideas Matt approved in principle but ranked low, left for whoever has time. Each should follow the pattern in [src/tools/AGENTS.md](../src/tools/AGENTS.md): declare a capability, say whether it is read-only or side-effecting, be off by default if it needs a key or reaches outside, and mark outside content untrusted. Opt-in toolsets go in as connectors ([CONNECTORS.md](CONNECTORS.md)); others as core tools.

| Toolset | Shape | Key | Notes |
| --- | --- | --- | --- |
| Image generation (`image_generate`) | connector | OpenAI-compatible images endpoint | Save into the workspace, return the path; `send_file` delivers it. Spend should count toward the daily cap. |
| Text-to-speech (`text_to_speech`) | connector | OpenAI-compatible, or a local command like the transcriber | Produce a voice note file for `send_file`. |
| Browser automation | connector | none | Playwright in the Docker sandbox; output untrusted; the largest item. Alternative: wait for the MCP client and use a Playwright MCP server. |
| Home Assistant | connector | token + base URL | Reads are `net.fetch`; service calls ask as `message.send`. Base URL is usually private, so it needs `trustedOrigin`. |
| Spotify | connector | OAuth | Playback and playlists are side effects (ask). |
| Kanban | core tool | none | A task board file in the workspace; maybe just a `todo_list` that persists. |
| RSS and feeds | connector | none | Read and diff feeds, pairs with `schedule`. |
| Video analysis and generation, X search, A2A, computer use | later | various | Need special models, OAuth or are out of scope today. |
| `patch` (unified diffs across files) | core tool | none | `edit_file` covers exact edits; add this only if models prove better at diffs. |
| Unit conversion in `calculate` | core tool | none | The evaluator has no units. |
| Cost per delegated model | runtime | none | Subagent spend is priced at the active provider's rate for the daily cap; use each subagent's own pricing. |
| Per-provider vision flag in config | config | none | `vision_analyze` guesses (`vision`, else anthropic/gemini on); make it explicit in setup. |
