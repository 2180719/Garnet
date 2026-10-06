# config

Loads `<RUBY_HOME>/config.json`, validates it with zod, migrates old versions (keeping a `.bak-vN` backup), and redacts secrets for display.

- Public API: `loadConfig`, `writeConfig`, `parseConfig`, `defaultConfig`, `configSchema`, `redact`, `rubyHome`, `pathsFor`, `loadEnvFile`, `parseEnv`, `removeFromEnvFile`, `secretNames`.
- Every field needs `.describe()`; `ruby config explain` and the dashboard render them.
- Defaults must be safe: external access off, loopback only, `exec` denied.
- Schema change checklist: bump `CONFIG_VERSION`, add a migration in `migrations.ts`, add a test in `config.test.ts`.
- Must not: read secrets. Config names environment variables or stored secrets (`apiKeyEnv`, `tokenEnv`; `secretNames` lists them); `main.ts` resolves them through `src/secrets`. The env-file helpers (`env.ts`) are the one exception: they parse and rewrite `<home>/env` for the CLI.
