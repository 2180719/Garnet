# config

Loads `<GARNET_HOME>/config.json`, validates it with zod, migrates old versions (keeping a `.bak-vN` backup), and redacts secrets for display.

- Public API: `loadConfig`, `writeConfig`, `parseConfig`, `defaultConfig`, `configSchema`, `redact`, `garnetHome`, `pathsFor`, `loadEnvFile`, `parseEnv`, `removeFromEnvFile`, `setInEnvFile`, `secretNames`, `envVar`, `unknownGarnetEnv`, and the editing helpers in `edit.ts` (`changeConfig`, `getConfigValue`, `parseConfigValue`, `showConfigValue`) behind `garnet config get|set|unset`.
- Every field needs `.describe()`; `garnet config explain` and the dashboard render them.
- `persona.ts` owns the `<!-- garnet setup -->` block in `config.persona`: `readPersona`, `writePersona`, `validBasic` (single line, no comment markers), `DEFAULT_NAME`, `PERSONA_MAX`. `garnet setup`, the onboarding fallback form and the `set_profile` tool all go through it.
- `timezone` (optional, IANA) is the owner's zone for schedules and reminders; unset means the host's. `jobSchema` is exported for jobs stored outside config (the scheduler's `JobBook`).
- Defaults must be safe: external access off, loopback only, `exec` denied.
- Schema change checklist: bump `CONFIG_VERSION`, add a migration in `migrations.ts`, add a test in `config.test.ts`.
- Must not: read secrets. Config names environment variables or stored secrets (`apiKeyEnv`, `tokenEnv`; `secretNames` lists them); `main.ts` resolves them through `src/secrets`. The env-file helpers (`env.ts`) are the one exception: they parse and rewrite `<home>/env` for the CLI.
- `media.transcription.*` and `media.pdfText.*` are protected (`protected.ts`): they choose a host command or where voice notes and a key are sent. `secretNames` includes `media.transcription.apiKeyEnv` when that backend is used. `model.vision`/`model.pdf` are optional; unset means the provider default.
- Settings never come from the environment: only secrets, `GARNET_HOME` and the bootstrap variables in `docs/CONFIGURATION.md` are read. A new `GARNET_*` variable must be added to `KNOWN_GARNET_ENV` (`env.ts`) and to that table, or doctor flags it as unread. `changeConfig` refuses credential-shaped values and non-name values in `*Env` fields; keep that in step with `redact.ts`.
- Every schema field needs `.describe()`; `edit.test.ts` fails otherwise.
