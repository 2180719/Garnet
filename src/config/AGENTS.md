# config

Loads `<GARNET_HOME>/config.json`, validates it with zod, migrates old versions (keeping a `.bak-vN` backup), and redacts secrets for display.

- Public API: `loadConfig`, `writeConfig`, `parseConfig`, `defaultConfig`, `configSchema`, `redact`, `garnetHome`, `pathsFor`, `loadEnvFile`, `parseEnv`, `removeFromEnvFile`, `setInEnvFile`, `secretNames`.
- Every field needs `.describe()`; `garnet config explain` and the dashboard render them.
- `timezone` (optional, IANA) is the owner's zone for schedules and reminders; unset means the host's. `jobSchema` is exported for jobs stored outside config (the scheduler's `JobBook`).
- Defaults must be safe: external access off, loopback only, `exec` denied.
- Schema change checklist: bump `CONFIG_VERSION`, add a migration in `migrations.ts`, add a test in `config.test.ts`.
- Must not: read secrets. Config names environment variables or stored secrets (`apiKeyEnv`, `tokenEnv`; `secretNames` lists them); `main.ts` resolves them through `src/secrets`. The env-file helpers (`env.ts`) are the one exception: they parse and rewrite `<home>/env` for the CLI.
- `skills` and `connectors` (version 2): optional built-ins, all off by default. Each has `enabled` (global) and `channels` (overrides keyed by scope, `SCOPE_RE`: a channel or surface, `<channel>:<chatId>`, `api:<keyId>`, `job:<id>`, `route:<name>`) with `enable`/`disable` lists. `extensions.ts` holds the names (`BUILTIN_SKILLS`, `CONNECTORS`), `resolveToggles`/`activeNames` (global, then each scope broadest first; the narrowest wins) and `setToggle` (the CLI's edit). Connector settings name secrets (`connectors.github.tokenEnv`, `connectors.calendar.urlEnv`); `secretNames` includes them when the connector is on anywhere. `connectors.github.apiUrl`, `repos` and `write` are protected (where the token goes and what it may do).
- `media.transcription.*` and `media.pdfText.*` are protected (`protected.ts`): they choose a host command or where voice notes and a key are sent. `secretNames` includes `media.transcription.apiKeyEnv` when that backend is used. `model.vision`/`model.pdf` are optional; unset means the provider default.
